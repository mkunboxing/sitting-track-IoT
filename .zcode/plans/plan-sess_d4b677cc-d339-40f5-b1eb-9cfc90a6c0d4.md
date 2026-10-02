# Extract Express backend from Next.js app

## Context (from exploration)

The app is a sitting-tracker IoT dashboard. The backend surface is small and cleanly separated already:

- **6 API routes** in `src/app/api/sitting/` — `status` (GET), `simulate` (POST), `stream` (GET, SSE), `start` (POST, device-token auth), `stop` (POST, device-token auth), `heartbeat` (POST, device-token auth)
- **Server-only libs**: `supabaseServer.ts` (Supabase client), `auth.ts` (Bearer DEVICE_TOKEN check), `eventBroadcaster.ts` (in-memory SSE hub, 15s ping), server-side fns in `timeUtils.ts` (`getTimezoneDayBoundaries`, `getUtcForLocalTime`, `calculateSessionOverlapWithInterval`)
- **Shared types**: `src/types/sitting.ts`
- **Clients of the API**: the dashboard `page.tsx` (3 call sites, hard-coded relative URLs, no API base helper today) and the ESP8266 firmware (hard-coded `SERVER_BASE_URL`)
- **No middleware, no server-component data access, no client auth, no cookies** — the Next.js app can become purely static-frontend.

**Confirmed choices**: `server/` folder in this repo · TypeScript · delete the old Next.js API routes.

## 1. Scaffold `server/` (Express 5 + TypeScript)

```
server/
├── package.json        # deps: express, cors, dotenv, @supabase/supabase-js
│                       # dev: typescript, tsx, @types/express, @types/cors, @types/node
│                       # scripts: dev = "tsx watch src/index.ts", build = "tsc", start = "node dist/index.js"
├── tsconfig.json       # NodeNext modules, strict, outDir dist
├── .gitignore          # node_modules, dist, .env
├── .env                # copied from root .env.local (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DEVICE_TOKEN)
├── .env.example        # + PORT=4000, CORS_ORIGIN=http://localhost:3000
└── src/
    ├── index.ts        # dotenv, cors (CORS_ORIGIN, comma-separated), express.json(), mount router, listen(PORT)
    ├── routes/sitting.ts    # Express Router mounted at /api/sitting — all 6 endpoints, paths unchanged
    ├── lib/
    │   ├── supabase.ts       # port of supabaseServer.ts (drops NEXT_PUBLIC_ fallback)
    │   ├── auth.ts           # port of verifyDeviceToken → Express middleware (same 401/403 responses)
    │   ├── eventBroadcaster.ts # adapted: clients are express Response objects (res.write) instead of
    │   │                     # ReadableStreamDefaultController; cleanup on req 'close'; same SSE format,
    │   │                     # same 'connected' event, same 15s ping, same broadcast payloads
    │   └── timeUtils.ts      # server-only fns moved verbatim
    └── types/sitting.ts      # SittingSession, DayStats, DashboardStatsResponse (moved verbatim)
```

**Faithful ports** — same paths, methods, status codes (201 on started, 401/403/400/500/503), request/response JSON shapes, and edge-case logic (heartbeat-stale auto-close at 90s/8h, unique-violation 23505 fallback on start, `no_active_session` on duplicate stop). Status responses get `Cache-Control: no-store` (replaces `dynamic = 'force-dynamic'`). `/stream` writes SSE headers + `flushHeaders()` and removes clients on `close`. Since it's a plain Express process, the broadcaster is a plain module singleton (no `globalThis` dance needed).

## 2. Rewire the frontend

- New `src/lib/api.ts`: `API_BASE` from `process.env.NEXT_PUBLIC_API_URL` (empty default) + `apiUrl(path)` helper.
- `src/app/page.tsx`: prefix the 3 call sites — `getStatusEndpoint()` (~line 57), `new EventSource(...)` (~line 206), simulate fetch (~line 282). Paths stay `/api/sitting/...`.
- `src/lib/timeUtils.ts`: remove the server-only functions (frontend only uses the 3 format helpers — verified by import scan).
- Root `.env.local` + `.env.example`: add `NEXT_PUBLIC_API_URL=http://localhost:4000`.

Before editing, check `node_modules/next/dist/docs/` (per AGENTS.md — this Next 16.3.7 differs from training data) for anything relevant to env vars/client components.

## 3. Delete old backend

- Remove `src/app/api/` entirely. Root `package.json` keeps only frontend deps (no change needed).

## 4. Docs

- `README.md`: two-process dev workflow (`npm run dev` in root + in `server/`), deployment note — frontend stays on Vercel, Express needs an always-on host for SSE (Railway/Render/Fly/VPS), and firmware `SERVER_BASE_URL` in `firmware/sitting_tracker/sitting_tracker.ino` must be repointed to the Express host once deployed (left unchanged — new URL unknown).

## 5. Verification

1. `npm install` in `server/`; `tsc --noEmit` on both apps.
2. Start Express; curl all 6 endpoints: status (configured payload), simulate start/stop, start/stop/heartbeat with + without Bearer token (expect 201/200 and 401/403), and an SSE stream test — connect, trigger simulate, confirm the `STATUS_CHANGE` event arrives.
3. Start `next dev`; confirm the frontend compiles with the API routes deleted and that `next build` passes (no broken imports).
4. Report results + how-to-run instructions.

Not in scope: firmware URL change (needs the future backend host), HTTPS/auth hardening for the browser-facing endpoints.