import { NextRequest, NextResponse } from 'next/server';

/**
 * Validates the device Authorization Bearer token from the incoming request.
 * Expected header: "Authorization: Bearer <DEVICE_TOKEN>"
 */
export function verifyDeviceToken(req: NextRequest): { authorized: boolean; errorResponse?: NextResponse } {
  const configuredToken = process.env.DEVICE_TOKEN;

  if (!configuredToken) {
    console.error('[AUTH ERROR] DEVICE_TOKEN is not set in environment variables.');
    return {
      authorized: false,
      errorResponse: NextResponse.json(
        {
          success: false,
          error: 'Server misconfiguration: DEVICE_TOKEN is not set in environment variables.',
        },
        { status: 500 }
      ),
    };
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader) {
    return {
      authorized: false,
      errorResponse: NextResponse.json(
        {
          success: false,
          error: 'Missing Authorization header. Expected "Authorization: Bearer <token>"',
        },
        { status: 401 }
      ),
    };
  }

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return {
      authorized: false,
      errorResponse: NextResponse.json(
        {
          success: false,
          error: 'Invalid Authorization header format. Expected "Bearer <token>"',
        },
        { status: 401 }
      ),
    };
  }

  const token = parts[1];
  if (token !== configuredToken) {
    return {
      authorized: false,
      errorResponse: NextResponse.json(
        {
          success: false,
          error: 'Unauthorized: Invalid device token.',
        },
        { status: 403 }
      ),
    };
  }

  return { authorized: true };
}
