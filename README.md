# FleetPulse — GT06 live tracking demo

This is a three-part, no-paid-service demonstration: the browser dashboard deploys to Netlify, the API/WebSocket server deploys to Render, and the raw TCP listener runs on your computer behind an ngrok TCP tunnel.

## 1. Install and configure

Install Node.js 20+, then run `npm install` at the repository root. Copy each `.env.example` to `.env` and set the values. Create a free MongoDB Atlas M0 cluster, allow network access from Render and your local computer, and paste its connection string into both backend configuration (only the API needs it) and deploy configuration.

## 2. Run locally

In separate terminals:

```powershell
npm run dev:api
npm run dev:web
npm run dev:listener
ngrok tcp 5000
```

Copy the ngrok address, for example `0.tcp.ngrok.io:12345`. Configure the tracker using its supported SMS/configuration command format so its server host is `0.tcp.ngrok.io` and its port is `12345`. The exact `SERVER,0000,<host>,<port>,0#` syntax varies by tracker firmware; confirm your tracker manual before sending an SMS command. The dashboard opens at `http://localhost:5173`.

The listener accepts standard `0x7878` GT06 login, GPS (`0x12`), and heartbeat packets, replies with CRC16 ACK frames, and forwards GPS data to `POST /ingest/location`. Keep its `INGEST_SECRET` identical to the backend secret.

## 3. Deploy

1. Push this repo to GitHub. In Render, create a Blueprint from the repo; `render.yaml` deploys the `backend` directory. Set `MONGODB_URI`, `CORS_ORIGIN` (your Netlify URL), and copy the generated `INGEST_SECRET` to the local listener.
2. In Netlify, import the repo with base directory `frontend`, build command `npm run build`, and publish directory `frontend/dist` (or use `netlify.toml` from that base). Set `VITE_API_URL` and `VITE_SOCKET_URL` to your Render HTTPS URL, then redeploy.
3. Set the Render URL as `API_URL` in `listener/.env`, restart the listener and ngrok tunnel, and point the tracker at the new ngrok TCP host/port.

## API

- `GET /devices`
- `GET /devices/:imei/latest`
- `GET /devices/:imei/history?from=ISO_DATE`
- Socket.io event: `location-update`

The UI includes three sample fleet vehicles alongside the real tracker. They are display-only demo vehicles; the real device appears automatically after its first valid GPS packet.
