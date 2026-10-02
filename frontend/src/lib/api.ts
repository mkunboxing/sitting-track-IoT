/**
 * Base URL of the standalone Express backend.
 * Empty string in dev-by-default setups means "same origin"; set
 * NEXT_PUBLIC_API_URL (e.g. http://localhost:4000) to point at the API server.
 * Inlined at build time by Next.js — must be prefixed with NEXT_PUBLIC_.
 */
const API_BASE = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/+$/, '');

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}
