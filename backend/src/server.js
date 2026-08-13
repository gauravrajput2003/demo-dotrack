import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import { createServer } from 'node:http';
import { Server } from 'socket.io';

const app = express();
const allowedOrigins = [
  'http://localhost:5173',
  'https://rad-toffee-29171e.netlify.app'
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin
    // e.g. Postman, server-to-server requests
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'));
  }
}));

app.use(express.json());

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST']
  }
});
const client = new MongoClient(process.env.MONGODB_URI);
const db = client.db(process.env.MONGODB_DB || 'fleetpulse');
const locations = db.collection('locations');

function cleanLocation(body) {
  const { imei, lat, lng, speed = 0, course = 0, ignition = false, timestamp = new Date(), satellites = 0 } = body;
  if (!imei || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) throw new Error('imei, lat and lng are required');
  return { imei: String(imei), lat: Number(lat), lng: Number(lng), speed: Number(speed), course: Number(course), ignition: Boolean(ignition), satellites: Number(satellites), timestamp: new Date(timestamp), receivedAt: new Date() };
}

app.get('/health', (_, res) => res.json({ ok: true, service: 'fleet-pulse-api' }));
app.get('/devices', async (_, res, next) => {
  try {
    const devices = await locations.aggregate([{ $sort: { timestamp: -1 } }, { $group: { _id: '$imei', latest: { $first: '$$ROOT' } } }, { $project: { _id: 0, imei: '$_id', latest: 1 } }]).toArray();
    res.json(devices);
  } catch (err) { next(err); }
});
app.get('/devices/:imei/latest', async (req, res, next) => {
  try { res.json(await locations.findOne({ imei: req.params.imei }, { sort: { timestamp: -1 } }) || null); } catch (err) { next(err); }
});
app.get('/devices/:imei/history', async (req, res, next) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : new Date(new Date().setHours(0, 0, 0, 0));
    const data = await locations.find({ imei: req.params.imei, timestamp: { $gte: from } }).sort({ timestamp: 1 }).limit(5000).toArray();
    res.json(data);
  } catch (err) { next(err); }
});
app.delete('/devices/:imei', async (req, res, next) => {
  try {
    const { imei } = req.params;
    const result = await locations.deleteMany({ imei });
    io.emit('device-removed', { imei }); 
    res.json({ imei, deletedCount: result.deletedCount });
  } catch (err) {
    next(err);
  }
});
app.post('/ingest/location', async (req, res, next) => {
  try {
    if (!process.env.INGEST_SECRET || req.get('x-ingest-secret') !== process.env.INGEST_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    const location = cleanLocation(req.body);
    await locations.insertOne(location);
    io.emit('location-update', location);
    res.status(201).json(location);
  } catch (err) { next(err); }
});
app.use((err, _, res, __) => { console.error(err); res.status(400).json({ error: err.message || 'Request failed' }); });

await client.connect();
await locations.createIndex({ imei: 1, timestamp: -1 });
io.on('connection', socket => socket.emit('server-ready', { at: new Date() }));
httpServer.listen(process.env.PORT || 10000, () => console.log('Fleet Pulse API listening'));
