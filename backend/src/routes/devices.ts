import { Router } from 'express';
import { requireAuth } from '../lib/auth';
import {
  linkDevice,
  listDevicesForUser,
  unlinkDevice,
} from '../lib/devices';
import { getOnlineDeviceIds } from '../lib/telemetryStore';

/**
 * Device linking routes — all behind user authentication (requireAuth).
 *
 * These are the user-side "Connect Device" endpoints only; the Arduino keeps
 * talking MQTT with its own broker credentials and never calls any of this.
 */

export const devicesRouter = Router();

// ── GET /api/devices — devices linked to the logged-in user ──────────────────
devicesRouter.get('/', requireAuth, async (req, res) => {
  const userId = req.authUser!.id;
  const devices = await listDevicesForUser(userId);
  const onlineIds = getOnlineDeviceIds();

  return res.json({
    success: true,
    devices: devices.map((device) => ({
      ...device,
      online: onlineIds.includes(device.device_id),
    })),
  });
});

// ── POST /api/devices/connect — link a device to the logged-in user ──────────
devicesRouter.post('/connect', requireAuth, async (req, res) => {
  const userId = req.authUser!.id;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
  const secret = typeof body.secret === 'string' ? body.secret : undefined;
  const name = typeof body.name === 'string' ? body.name : undefined;

  if (!deviceId) {
    return res.status(400).json({ success: false, error: 'Device ID is required' });
  }

  const result = await linkDevice(userId, deviceId, secret, name);

  switch (result.status) {
    case 'linked':
      console.log(`[DEVICES] ${deviceId} linked to ${req.authUser!.username}`);
      return res.json({
        success: true,
        message: `Device "${result.device.name}" connected. Its sitting data now appears on your dashboard.`,
        device: result.device,
      });
    case 'already_linked':
      return res.json({
        success: true,
        message: 'This device is already connected to your account.',
        device: result.device,
      });
    case 'taken':
      return res.status(409).json({
        success: false,
        error: 'This device is already linked to another account. It must be unlinked there first.',
      });
    case 'invalid_secret':
      return res.status(403).json({
        success: false,
        error: 'Incorrect device credential (PIN).',
      });
    case 'invalid_device_id':
      return res.status(400).json({
        success: false,
        error: 'Invalid device ID (1–64 characters; letters, numbers, dot, dash, underscore only).',
      });
    case 'db_error':
      console.error('[DEVICES] Connect failed:', result.error);
      return res.status(500).json({ success: false, error: 'Failed to connect device' });
  }
});

// ── POST /api/devices/unlink — release a device from the logged-in user ──────
devicesRouter.post('/unlink', requireAuth, async (req, res) => {
  const userId = req.authUser!.id;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';

  if (!deviceId) {
    return res.status(400).json({ success: false, error: 'Device ID is required' });
  }

  const result = await unlinkDevice(userId, deviceId);

  switch (result.status) {
    case 'unlinked':
      console.log(`[DEVICES] ${deviceId} unlinked from ${req.authUser!.username}`);
      return res.json({
        success: true,
        message: 'Device disconnected. Its sitting data is no longer visible on your dashboard.',
      });
    case 'not_owned':
      return res.status(404).json({
        success: false,
        error: 'Device not found on your account.',
      });
    case 'db_error':
      console.error('[DEVICES] Unlink failed:', result.error);
      return res.status(500).json({ success: false, error: 'Failed to disconnect device' });
  }
});
