import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { sittingRouter } from './routes/sitting';
import { authRouter } from './routes/auth';
import { devicesRouter } from './routes/devices';
import { eventBroadcaster } from './lib/eventBroadcaster';
import { getOnlineDeviceIds } from './lib/telemetryStore';
import { getMqttStatus, startMqttClient } from './lib/mqttClient';
import { initSessionStatePublisher } from './lib/sessionStatePublisher';

const app = express();

// CORS: allow the Next.js frontend origin(s) configured via CORS_ORIGIN (comma-separated).
// credentials: true — the auth cookie must ride along on cross-origin
// frontend→API calls (Vercel → Render in production).
const allowedOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.includes('*') ? true : allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-timezone', 'x-timezone-offset', 'Cache-Control'],
  })
);

app.use(express.json());
app.use(cookieParser());

// User accounts (signup/login/logout) + device linking — all cookie-based.
// Device/MQTT telemetry stays completely separate (no auth here).
app.use('/api/auth', authRouter);
app.use('/api/devices', devicesRouter);

app.use('/api/sitting', sittingRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({
    success: true,
    sseClients: eventBroadcaster.getClientCount(),
    onlineDevices: getOnlineDeviceIds(),
    mqtt: getMqttStatus(),
  });
});

// JSON body parse errors and unexpected errors
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    if (err instanceof SyntaxError && 'body' in (err as unknown as Record<string, unknown>)) {
      res.status(400).json({ success: false, error: 'Invalid JSON body' });
      return;
    }
    console.error('[SERVER] Unhandled error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
);

const port = parseInt(process.env.PORT || '4000', 10);
app.listen(port, () => {
  console.log(`[SERVER] Smart Tracking API listening on http://localhost:${port}`);
  console.log(`[SERVER] CORS origins: ${allowedOrigins.join(', ')}`);
  // MQTT telemetry subscriber (EMQX Cloud) — no-ops when MQTT_BROKER_URL is
  // unset. The session-state publisher then keeps the mobile app's retained
  // sitting/device/<id>/session snapshot current (open/close/posture,
  // reconnects, midnight rollover); it no-ops without MQTT too.
  startMqttClient();
  initSessionStatePublisher();
});
