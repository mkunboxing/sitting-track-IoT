import { Router } from 'express';
import {
  clearSessionCookie,
  closeAuthSession,
  createAuthSession,
  hashPassword,
  requireAuth,
  resolveSession,
  setSessionCookie,
  SESSION_COOKIE_NAME,
  verifyPassword,
} from '../lib/auth';
import { getSupabaseServerClient, isSupabaseConfigured } from '../lib/supabase';

/**
 * User account routes — signup / login / logout / me.
 *
 * Passwords are stored ONLY as bcrypt hashes; usernames are unique
 * (case-insensitive, enforced by a DB unique index). Sessions are persistent:
 * no expiry, logout only via POST /logout or by manually invalidating the
 * auth_sessions row. Device/MQTT authentication is unrelated to this router.
 */

export const authRouter = Router();

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 6;

function bodyString(body: unknown, key: string): unknown {
  return (body as Record<string, unknown> | null)?.[key];
}

/**
 * Case-insensitive EXACT username lookup. `ilike` alone is not enough —
 * Postgres treats "_" in the pattern as a wildcard, and usernames may contain
 * underscores. Candidates are fetched broadly, then matched exactly here.
 */
async function findUserByUsername<T extends { username: string }>(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  username: string,
  columns: string
): Promise<T | null> {
  const { data, error } = await supabase
    .from('users')
    .select(columns)
    .ilike('username', username)
    .limit(20);
  if (error) throw error;
  const target = username.toLowerCase();
  const rows = (data ?? []) as unknown as T[];
  return rows.find((row: T) => row.username.toLowerCase() === target) ?? null;
}

// ── POST /api/auth/signup — create account ───────────────────────────────────
authRouter.post('/signup', async (req, res) => {
  if (!isSupabaseConfigured()) {
    return res.status(503).json({
      success: false,
      error: 'Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env',
    });
  }

  const username = typeof bodyString(req.body, 'username') === 'string'
    ? (bodyString(req.body, 'username') as string).trim()
    : '';
  const password = typeof bodyString(req.body, 'password') === 'string'
    ? (bodyString(req.body, 'password') as string)
    : '';

  if (!USERNAME_PATTERN.test(username)) {
    return res.status(400).json({
      success: false,
      error: 'Username must be 3–32 characters (letters, numbers, dot, dash, underscore only)',
    });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      success: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    });
  }

  try {
    const supabase = getSupabaseServerClient();

    // Friendly pre-check; the DB unique index is the real guard (race-safe)
    const existing = await findUserByUsername(supabase, username, 'id');

    if (existing) {
      return res.status(409).json({ success: false, error: 'Username already taken' });
    }

    const passwordHash = await hashPassword(password);
    const { data: created, error: insertError } = await supabase
      .from('users')
      .insert({ username, password_hash: passwordHash })
      .select('id, username')
      .single();

    if (insertError) {
      if (insertError.code === '23505') {
        return res.status(409).json({ success: false, error: 'Username already taken' });
      }
      throw insertError;
    }

    console.log(`[AUTH] Account created: ${created.username} (${created.id})`);
    // No auto-login — the flow is: create account → login (per product spec)
    return res.status(201).json({
      success: true,
      message: 'Account created. Please log in.',
      user: { id: created.id, username: created.username },
    });
  } catch (err: unknown) {
    console.error('[AUTH] Signup failed:', err);
    return res.status(500).json({ success: false, error: 'Failed to create account' });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────────────────────
authRouter.post('/login', async (req, res) => {
  if (!isSupabaseConfigured()) {
    return res.status(503).json({
      success: false,
      error: 'Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env',
    });
  }

  const username = typeof bodyString(req.body, 'username') === 'string'
    ? (bodyString(req.body, 'username') as string).trim()
    : '';
  const password = typeof bodyString(req.body, 'password') === 'string'
    ? (bodyString(req.body, 'password') as string)
    : '';

  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password are required' });
  }

  try {
    const supabase = getSupabaseServerClient();
    const user = await findUserByUsername<{ id: string; username: string; password_hash: string }>(
      supabase,
      username,
      'id, username, password_hash'
    );

    // Same error for unknown user and wrong password (no account enumeration)
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ success: false, error: 'Invalid username or password' });
    }

    const token = await createAuthSession(user.id);
    setSessionCookie(res, token);

    console.log(`[AUTH] Login: ${user.username} (${user.id})`);
    return res.json({
      success: true,
      user: { id: user.id, username: user.username },
    });
  } catch (err: unknown) {
    console.error('[AUTH] Login failed:', err);
    return res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// ── POST /api/auth/logout — invalidate the current session ───────────────────
authRouter.post('/logout', requireAuth, async (req, res) => {
  try {
    if (req.sessionToken) {
      await closeAuthSession(req.sessionToken);
    }
    clearSessionCookie(res);
    console.log(`[AUTH] Logout: ${req.authUser?.username} (${req.authUser?.id})`);
    return res.json({ success: true, message: 'Logged out' });
  } catch (err: unknown) {
    console.error('[AUTH] Logout failed:', err);
    clearSessionCookie(res);
    return res.status(500).json({ success: false, error: 'Logout failed' });
  }
});

// ── GET /api/auth/me — current user or null (200 either way) ─────────────────
authRouter.get('/me', async (req, res) => {
  if (!isSupabaseConfigured()) {
    return res.json({ success: true, user: null, configured: false });
  }

  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token) return res.json({ success: true, user: null });

  try {
    const session = await resolveSession(token);
    return res.json({
      success: true,
      user: session ? { id: session.userId, username: session.username } : null,
    });
  } catch (err: unknown) {
    console.error('[AUTH] /me failed:', err);
    return res.status(500).json({ success: false, error: 'Failed to resolve session' });
  }
});
