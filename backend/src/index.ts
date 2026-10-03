import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { sittingRouter } from './routes/sitting';
import { eventBroadcaster } from './lib/eventBroadcaster';
import { getOnlineDeviceIds } from './lib/telemetryStore';

const app = express();

// CORS: allow the Next.js frontend origin(s) configured via CORS_ORIGIN (comma-separated)
const allowedOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.includes('*') ? true : allowedOrigins,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-timezone', 'x-timezone-offset', 'Cache-Control'],
  })
);

app.use(express.json());

app.use('/api/sitting', sittingRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ success: true, sseClients: eventBroadcaster.getClientCount(), onlineDevices: getOnlineDeviceIds() });
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
});
