import 'dotenv/config';
import net from 'node:net';

const port = Number(process.env.TCP_PORT || 5000);
const apiUrl = process.env.API_URL || 'http://localhost:10000';
const secret = process.env.INGEST_SECRET;
const connections = new Map();
const hex = b => b.toString('hex').toUpperCase();
const bcd = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('').replace(/^0/, '').replace(/F/g, '');
const crc16 = buffer => { let crc = 0xFFFF; for (const byte of buffer) { crc ^= byte << 8; for (let i=0;i<8;i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF; } return crc; };
function ack(protocol, serial) { const payload = Buffer.from([0x05, protocol, serial >> 8, serial & 255]); const crc = crc16(payload); return Buffer.concat([Buffer.from([0x78,0x78]), payload, Buffer.from([crc >> 8, crc & 255, 0x0D,0x0A])]); }
function parseGps(frame, imei) {
  const p = frame.subarray(3, frame.length - 6); // protocol begins at p[0]
  if (p[0] !== 0x12 || p.length < 28) return null;
  const date = p.subarray(1, 7); const year = 2000 + date[0];
  const timestamp = new Date(Date.UTC(year, date[1]-1, date[2], date[3], date[4], date[5]));
  const rawLat = p.readUInt32BE(8), rawLng = p.readUInt32BE(12);
  const courseStatus = p.readUInt16BE(17), west = Boolean(courseStatus & 0x0800), south = Boolean(courseStatus & 0x0400);
  return { imei: imei || 'unknown', lat: (south ? -1 : 1) * rawLat / 30000 / 60, lng: (west ? -1 : 1) * rawLng / 30000 / 60, speed: p[16], course: courseStatus & 0x03FF, ignition: Boolean(courseStatus & 0x1000), satellites: p[7] & 0x0F, timestamp };
}
async function publish(location) {
  if (!secret) return console.warn('Location parsed but INGEST_SECRET is missing');
  const r = await fetch(`${apiUrl}/ingest/location`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ingest-secret': secret }, body: JSON.stringify(location) });
  if (!r.ok) throw new Error(`API returned ${r.status}`);
}
function processFrames(socket) {
  let buffer = socket._gt06Buffer || Buffer.alloc(0);
  while (buffer.length >= 10) {
    const start = buffer.indexOf(Buffer.from([0x78,0x78])); if (start < 0) { buffer = Buffer.alloc(0); break; } if (start) buffer = buffer.subarray(start);
    const length = buffer[2], total = length + 5; if (buffer.length < total) break;
    const frame = buffer.subarray(0, total); buffer = buffer.subarray(total);
    if (frame[total-2] !== 0x0D || frame[total-1] !== 0x0A) continue;
    const protocol = frame[3], serial = frame.readUInt16BE(total - 6);
    if (protocol === 0x01) { socket.imei = bcd(frame.subarray(4, 12)); connections.set(socket.imei, socket); console.log(`Login: ${socket.imei}`); }
    if (protocol === 0x12) { const point = parseGps(frame, socket.imei); if (point) publish(point).then(() => console.log(`GPS ${point.imei}: ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`)).catch(e => console.error('Publish error:', e.message)); }
    socket.write(ack(protocol, serial));
  }
  socket._gt06Buffer = buffer;
}
net.createServer(socket => { console.log('Tracker connected', socket.remoteAddress); socket.on('data', chunk => {
  socket._gt06Buffer = Buffer.concat([socket._gt06Buffer || Buffer.alloc(0), chunk]);
  processFrames(socket);
}); socket.on('error', e => console.warn('Tracker error', e.message)); socket.on('close', () => socket.imei && connections.delete(socket.imei)); }).listen(port, '0.0.0.0', () => console.log(`GT06 TCP listener on 0.0.0.0:${port}`));
