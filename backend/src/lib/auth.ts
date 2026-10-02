import type { NextFunction, Request, Response } from 'express';

/**
 * Validates the device Authorization Bearer token from the incoming request.
 * Expected header: "Authorization: Bearer <DEVICE_TOKEN>"
 */
export function requireDeviceToken(req: Request, res: Response, next: NextFunction): void {
  const configuredToken = process.env.DEVICE_TOKEN;

  if (!configuredToken) {
    console.error('[AUTH ERROR] DEVICE_TOKEN is not set in environment variables.');
    res.status(500).json({
      success: false,
      error: 'Server misconfiguration: DEVICE_TOKEN is not set in environment variables.',
    });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({
      success: false,
      error: 'Missing Authorization header. Expected "Authorization: Bearer <token>"',
    });
    return;
  }

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    res.status(401).json({
      success: false,
      error: 'Invalid Authorization header format. Expected "Bearer <token>"',
    });
    return;
  }

  const token = parts[1];
  if (token !== configuredToken) {
    res.status(403).json({
      success: false,
      error: 'Unauthorized: Invalid device token.',
    });
    return;
  }

  next();
}
