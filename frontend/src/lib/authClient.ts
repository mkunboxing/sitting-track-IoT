import { apiUrl } from './api';

/**
 * Client-side helpers for the dashboard's cookie-based auth and device
 * linking. Every request includes credentials so the backend's HttpOnly
 * session cookie rides along (cross-origin: Vercel frontend → Render API).
 * The cookie is HttpOnly, so JavaScript never touches the token itself.
 */

export interface AuthUser {
  id: string;
  username: string;
}

export interface TrackerDevice {
  id: string;
  device_id: string;
  name: string;
  created_at: string;
  online: boolean;
}

interface ApiJson {
  success?: boolean;
  error?: string;
  message?: string;
  user?: AuthUser | null;
  devices?: TrackerDevice[];
}

/** Current user from the session cookie, or null when logged out. */
export async function fetchCurrentUser(): Promise<AuthUser | null> {
  try {
    const res = await fetch(apiUrl('/api/auth/me'), {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json: ApiJson = await res.json();
    return json.user ?? null;
  } catch {
    return null;
  }
}

export async function loginRequest(
  username: string,
  password: string
): Promise<{ ok: true; user: AuthUser } | { ok: false; error: string }> {
  try {
    const res = await fetch(apiUrl('/api/auth/login'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const json: ApiJson = await res.json();
    if (!res.ok || !json.success || !json.user) {
      return { ok: false, error: json.error || `Login failed (HTTP ${res.status})` };
    }
    return { ok: true, user: json.user };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Login failed' };
  }
}

export async function signupRequest(
  username: string,
  password: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(apiUrl('/api/auth/signup'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const json: ApiJson = await res.json();
    if (!res.ok || !json.success) {
      return { ok: false, error: json.error || `Sign up failed (HTTP ${res.status})` };
    }
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Sign up failed' };
  }
}

export async function logoutRequest(): Promise<void> {
  try {
    await fetch(apiUrl('/api/auth/logout'), {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // Clearing failed server-side — the login page still works (the cookie
    // can be overwritten); surface nothing, the redirect proceeds.
  }
}

export async function fetchDevices(): Promise<TrackerDevice[]> {
  const res = await fetch(apiUrl('/api/devices'), { credentials: 'include', cache: 'no-store' });
  if (res.status === 401) {
    window.location.replace('/login');
    throw new Error('Session expired');
  }
  const json: ApiJson = await res.json();
  return json.devices ?? [];
}

export async function connectDevice(
  deviceId: string,
  secret?: string,
  name?: string
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const res = await fetch(apiUrl('/api/devices/connect'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, ...(secret ? { secret } : {}), ...(name ? { name } : {}) }),
  });
  const json: ApiJson = await res.json();
  if (!res.ok || !json.success) {
    return { ok: false, error: json.error || `Connect failed (HTTP ${res.status})` };
  }
  return { ok: true, message: json.message || 'Device connected.' };
}

export async function unlinkDevice(
  deviceId: string
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const res = await fetch(apiUrl('/api/devices/unlink'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  const json: ApiJson = await res.json();
  if (!res.ok || !json.success) {
    return { ok: false, error: json.error || `Disconnect failed (HTTP ${res.status})` };
  }
  return { ok: true, message: json.message || 'Device disconnected.' };
}
