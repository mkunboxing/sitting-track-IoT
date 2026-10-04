'use client';

import React, { useEffect, useState } from 'react';
import { Logo } from '@/components/Logo';
import { fetchCurrentUser, loginRequest } from '@/lib/authClient';
import { LogIn, ShieldAlert } from 'lucide-react';

export default function LoginPage() {
  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCheckingSession, setIsCheckingSession] = useState<boolean>(true);

  // Already logged in (persistent session) → straight to the dashboard
  useEffect(() => {
    let ignore = false;
    fetchCurrentUser().then((user) => {
      if (!ignore && user) {
        window.location.replace('/');
        return;
      }
      if (!ignore) setIsCheckingSession(false);
    });
    return () => {
      ignore = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      const result = await loginRequest(username.trim(), password);
      if (result.ok) {
        // Full navigation so the dashboard boots with the session cookie set
        window.location.assign('/');
        return;
      }
      setErrorMessage(result.error);
      setIsSubmitting(false);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Login failed');
      setIsSubmitting(false);
    }
  };

  if (isCheckingSession) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-app text-ink">
        <Logo size="md" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-app text-ink px-4">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="flex flex-col items-center gap-3 mb-8">
          <Logo size="lg" />
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight text-ink-bright">
              Sitting Time Tracker
            </h1>
            <p className="text-xs text-ink4 mt-1">
              Sign in to view your desk sessions
            </p>
          </div>
        </div>

        {/* Login card */}
        <form
          onSubmit={handleSubmit}
          className="p-6 rounded-2xl bg-panel/60 border border-edge/80 shadow-xl space-y-4"
        >
          <div className="space-y-1.5">
            <label htmlFor="username" className="text-xs font-semibold text-ink3">
              Username
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="your-username"
              className="w-full px-3.5 py-2.5 rounded-xl bg-well/60 border border-edge-strong/60 text-sm text-ink-bright placeholder:text-ink6 outline-none focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20 transition"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="text-xs font-semibold text-ink3">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-3.5 py-2.5 rounded-xl bg-well/60 border border-edge-strong/60 text-sm text-ink-bright placeholder:text-ink6 outline-none focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20 transition"
            />
          </div>

          {errorMessage && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-acc-rose-soft text-xs">
              <ShieldAlert className="w-4 h-4 text-acc-rose shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting || !username.trim() || !password}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-950 font-bold text-sm transition-colors shadow-lg shadow-emerald-500/20 active:scale-[0.98]"
          >
            <LogIn className="w-4 h-4" />
            {isSubmitting ? 'Signing in…' : 'Sign In'}
          </button>

          <p className="text-center text-xs text-ink4 pt-1">
            No account yet?{' '}
            <a href="/signup" className="font-semibold text-acc-emerald hover:text-acc-emerald-soft">
              Create one
            </a>
          </p>
        </form>

        <p className="text-center text-[11px] text-ink6 mt-6">
          Sessions persist until you sign out — no automatic logout.
        </p>
      </div>
    </div>
  );
}
