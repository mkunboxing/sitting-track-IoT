import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getSupabaseServerClient, isSupabaseConfigured } from './supabase';

/**
 * User authentication — bcrypt password hashing + persistent cookie sessions.
 *
 * Completely separate from device/MQTT authentication: the Arduino never uses
 * any of this; it authenticates at the EMQX broker and is identified by its
 * device_id (see lib/devices.ts for the user↔device link).
 *
 * Sessions NEVER expire automatically: the cookie is issued for the browser
 * maximum (400 days) and re-issued is never needed — an auth_sessions row
 * stays valid until the user logs out (active=false + logout_at set) or the
 * row is manually invalidated (e.g. from the Supabase dashboard). Only the
 * SHA-256 hash of the cookie token is stored, so a database leak does not
 * leak usable session cookies.
 */

export const SESSION_COOKIE_NAME = 'st_session';

/** Browser-enforced cookie ceiling (Chrome/Firefox cap at 400 days) — the
 *  server-side session row governs the real lifetime (no expiry). */
const COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

const BCRYPT_ROUNDS = 10;

const isProduction = process.env.NODE_ENV === 'production';

export interface AuthUser {
  id: string;
  username: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth for authenticated requests */
      authUser?: AuthUser;
      /** Raw session cookie token (stashed for logout) */
      sessionToken?: string;
    }
  }
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Random 256-bit opaque token carried by the HttpOnly cookie */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Persist a new auth_sessions row and return the cookie token.
 * The row stays active until logout / manual invalidation — no expiry.
 */
export async function createAuthSession(userId: string): Promise<string> {
  const supabase = getSupabaseServerClient();
  const token = generateSessionToken();

  const { error } = await supabase.from('auth_sessions').insert({
    user_id: userId,
    token_hash: hashToken(token),
    active: true,
  });

  if (error) throw new Error(`Failed to create auth session: ${error.message}`);
  return token;
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  username: string;
  loginAt: string;
}

/**
 * Resolve a cookie token to its (still-active) session + user. Sessions only
 * resolve while active = true and logout_at is null — logging out or manually
 * invalidating the row kills the cookie immediately.
 */
export async function resolveSession(token: string): Promise<ResolvedSession | null> {
  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from('auth_sessions')
    .select('id, user_id, login_at, users(username)')
    .eq('token_hash', hashToken(token))
    .eq('active', true)
    .is('logout_at', null)
    .maybeSingle();

  if (error) throw new Error(`Failed to resolve session: ${error.message}`);
  if (!data) return null;

  // users(...) is a PostgREST embed over auth_sessions.user_id → users.id
  const embedded = data.users as { username: string } | { username: string }[] | null;
  const username = Array.isArray(embedded) ? embedded[0]?.username : embedded?.username;
  if (!username) return null;

  return {
    sessionId: data.id,
    userId: data.user_id,
    username,
    loginAt: data.login_at,
  };
}

/** Mark the session logged out (active=false + logout_at) and clear the cookie. */
export async function closeAuthSession(token: string): Promise<void> {
  const supabase = getSupabaseServerClient();
  await supabase
    .from('auth_sessions')
    .update({ active: false, logout_at: new Date().toISOString() })
    .eq('token_hash', hashToken(token))
    .eq('active', true);
}

// ── Cookie handling ──────────────────────────────────────────────────────────
// Production (Vercel frontend → Render backend = cross-site): SameSite=None +
// Secure so the cookie rides along on cross-origin XHR/EventSource calls.
// Dev (localhost:3000 → localhost:4000 = same-site): SameSite=Lax.

const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: (isProduction ? 'none' : 'lax') as 'none' | 'lax',
  path: '/',
};

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, { ...cookieOptions, maxAge: COOKIE_MAX_AGE_MS });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions);
}

/**
 * Express middleware: 401s unauthenticated requests and attaches
 * req.authUser + req.sessionToken for the handler.
 */
export const requireAuth: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    if (!token || !isSupabaseConfigured()) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    const session = await resolveSession(token);
    if (!session) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    req.authUser = { id: session.userId, username: session.username };
    req.sessionToken = token;
    next();
  } catch (err: unknown) {
    console.error('[AUTH] Session resolution failed:', err);
    res.status(500).json({ success: false, error: 'Failed to resolve session' });
  }
};
