import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MapContainer, Marker, Polyline, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import { Bell, ChevronLeft, Gauge, MapPin, Navigation, Play, Pause, Radio, Search, Settings, Zap } from 'lucide-react';
import { io } from 'socket.io-client';
import 'leaflet/dist/leaflet.css';
import './styles.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:10000';
const SOCKET = import.meta.env.VITE_SOCKET_URL || API;
const LIMIT = 60;

const carIcon = alert => L.divIcon({ className: '', html: `<div class="vehicle-marker ${alert ? 'alert' : ''}">&#128663;</div>`, iconSize: [46, 46], iconAnchor: [23, 23] });
function Fit({ position }) { const map = useMap(); useEffect(() => { if (position) map.flyTo([position.lat, position.lng], 14, { duration: 1.2 }); }, [position?.lat, position?.lng]); return null; }
function ago(date) { if (!date) return 'Waiting for GPS'; const seconds = Math.max(0, Math.round((Date.now() - new Date(date)) / 1000)); return seconds < 60 ? `Updated ${seconds}s ago` : `Updated ${Math.floor(seconds / 60)}m ago`; }

function App() {
  const [devices, setDevices] = useState({}); // imei -> latest location
  const [active, setActive] = useState(null);
  const [history, setHistory] = useState([]);
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [toast, setToast] = useState('');
  const [now, setNow] = useState(Date.now());

  const vehicles = useMemo(
    () => Object.values(devices).map(d => ({ ...d, name: d.name || `Tracker ${d.imei}`, plate: d.plate || d.imei, isReal: true })),
    [devices]
  );
  const selected = active && devices[active.imei] ? devices[active.imei] : vehicles[0] || null;

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  useEffect(() => {
    fetch(`${API}/devices`)
      .then(r => (r.ok ? r.json() : []))
      .then(list => {
        const map = {};
        for (const d of list) if (d.latest) map[d.imei] = d.latest;
        setDevices(map);
      })
      .catch(() => {});

    const s = io(SOCKET);
    s.on('location-update', p => {
      setDevices(prev => ({ ...prev, [p.imei]: p }));
      setHistory(h => (active?.imei === p.imei ? [...h.slice(-499), p] : h));
      if (Number(p.speed) > LIMIT) {
        setToast(`Overspeed alert - ${Math.round(p.speed)} km/h`);
        setTimeout(() => setToast(''), 5000);
      }
    });
    s.on('device-removed', ({ imei }) => {
      setDevices(prev => {
        if (!(imei in prev)) return prev;
        const next = { ...prev };
        delete next[imei];
        return next;
      });
      setActive(a => (a?.imei === imei ? null : a));
    });
    return () => s.close();
  }, [active?.imei]);

  useEffect(() => {
    if (!selected?.imei) return;
    fetch(`${API}/devices/${selected.imei}/history`)
      .then(r => (r.ok ? r.json() : []))
      .then(setHistory)
      .catch(() => {});
  }, [selected?.imei]);

  useEffect(() => {
    if (!playing || history.length < 2) return;
    const id = setInterval(() => setCursor(c => (c >= history.length - 1 ? 0 : c + 1)), 700);
    return () => clearInterval(id);
  }, [playing, history.length]);

  const display = selected && history[cursor] && playing ? history[cursor] : selected;
  const overspeed = Number(display?.speed) > LIMIT;
  const running = vehicles.filter(v => v.ignition).length;
  const stopped = vehicles.length - running;
  const overspeedCount = vehicles.filter(v => Number(v.speed) > LIMIT).length;
  const selectVehicle = v => { setActive(v); setCursor(0); };

  const maxCursor = Math.max(0, history.length - 1);
  const cursorValue = Math.min(cursor, maxCursor);
  const progress = maxCursor > 0 ? Math.round((cursorValue / maxCursor) * 100) : 0;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><Navigation size={22} /></div><span>Fleet<span>Pulse</span></span></div>
        <div className="search"><Search size={18} /><input placeholder="Search fleet" /></div>
        <p className="side-caption">MY FLEET <b>{vehicles.length}</b></p>
        <div className="vehicle-list">
          {vehicles.length === 0 && <p className="empty-state">No devices connected yet. Waiting for tracker...</p>}
          {vehicles.map(v => (
            <button key={v.imei} className={`vehicle-row ${selected?.imei === v.imei ? 'selected' : ''}`} onClick={() => selectVehicle(v)}>
              <div className={`dot ${v.ignition ? 'online' : 'idle'}`} />
              <div><strong>{v.name}</strong><small>{v.plate}</small></div>
              <span>{Math.round(v.speed)}<small> km/h</small></span>
            </button>
          ))}
        </div>
        <div className="side-bottom"><button><Settings size={19} /> Settings</button></div>
      </aside>

      <section className="content">
        <header>
          <button className="mobile-back"><ChevronLeft /></button>
          <div><p>LIVE OPERATIONS</p><h1>{selected?.name || 'Fleet overview'}</h1></div>
          <div className="header-actions"><button><Bell size={20} /><i /></button><div className="avatar">FP</div></div>
        </header>

        <div className="mobile-fleet">
          {vehicles.map(v => (
            <button key={v.imei} className={selected?.imei === v.imei ? 'selected' : ''} onClick={() => selectVehicle(v)}>
              <i className={v.ignition ? 'online' : 'idle'} /><span>{v.name}</span><b>{Math.round(v.speed)} km/h</b>
            </button>
          ))}
        </div>

        <div className="summary-bar">
          <div className="summary total"><span>Total vehicles</span><b>{vehicles.length}</b><small>In your fleet</small></div>
          <div className="summary running"><span>Running</span><b>{running}</b><small>Ignition on</small></div>
          <div className="summary stopped"><span>Stopped</span><b>{stopped}</b><small>Awaiting dispatch</small></div>
          <div className="summary overspeed"><span>Overspeed</span><b>{overspeedCount}</b><small>Above {LIMIT} km/h</small></div>
        </div>

        <div className="map-wrap">
          <MapContainer center={[28.6139, 77.2090]} zoom={13} zoomControl={false}>
            <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            {display && (
              <>
                <Fit position={display} />
                <Marker position={[display.lat, display.lng]} icon={carIcon(overspeed)} />
              </>
            )}
            {history.length > 1 && (
              <Polyline positions={history.map(p => [p.lat, p.lng])} pathOptions={{ color: '#635bff', weight: 5, opacity: 0.85 }} />
            )}
          </MapContainer>

          <div className="live-pill"><Radio size={15} /> LIVE TRACKING</div>
          {toast && <div className="toast"><Zap size={19} />{toast}</div>}

          {selected && (
            <div className="info-card">
              <div className="card-top"><div><p>{selected.plate}</p><h2>{selected.name}</h2></div><button className="more">...</button></div>
              <div className="status-line">
                <span className={display?.ignition ? 'on' : 'off'}><i /> Ignition {display?.ignition ? 'ON' : 'OFF'}</span>
                <span className="gps"><MapPin size={16} /> GPS {display?.satellites ? `${display.satellites} satellites` : 'Strong'}</span>
              </div>
              <div className="metrics">
                <div className="speed-readout"><div><Gauge /><small>CURRENT SPEED</small></div><b className={overspeed ? 'danger' : ''}>{Math.round(display?.speed || 0)}</b><em>km/h</em></div>
                <div className="update-readout"><p>LAST UPDATE</p><strong>{ago(display?.timestamp || now)}</strong><small>IMEI {selected.imei}</small></div>
              </div>
              {overspeed && <div className="alert-line"><Zap size={16} /> Speed limit {LIMIT} km/h exceeded</div>}
            </div>
          )}

          <div className="history-card">
            <button onClick={() => setPlaying(!playing)}>
              {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
              <span>{playing ? 'Pause history' : 'Play history'}</span>
            </button>
            <input
              type="range"
              min="0"
              max={maxCursor}
              value={cursorValue}
              style={{ '--progress': progress }}
              onChange={e => { setPlaying(false); setCursor(Number(e.target.value)); }}
            />
            <span>{history.length ? `${cursorValue + 1} / ${history.length}` : 'No route yet'}</span>
          </div>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);