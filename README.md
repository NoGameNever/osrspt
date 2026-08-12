# OSRSpt

An Old School RuneScape research assistant. Ask it about gear, bosses, progression routing,
skilling methods and money making. If you give it your RuneScape Name (RSN) **and grant
permission**, it reads your public OSRS hiscores and personalizes its advice.

Unofficial fan project. Not affiliated with Jagex.

## What it does

- Chat interface backed by the OpenAI API, called **only** from the server.
- Public OSRS hiscores lookup, gated behind explicit user permission.
- Conversation history persisted to MongoDB Atlas, keyed by session id.
- Three response styles (Concise, Gear & Setups, Deep Dive) and four gear tiers
  (Budget, Mid-game, Near-BiS, BiS) passed into the server-side prompt.
- Graceful degradation: with no database configured the chat still works using
  in-memory history; with no OpenAI key it returns a clear, actionable error.

### What it deliberately cannot do

The **only** account data available is the public OSRS hiscores: ranks, levels, XP, and some
activity/boss scores, for accounts that appear on the hiscores. It has no access to your bank,
inventory, equipment, quests, achievement diaries, collection log, membership status, RuneLite
client, local files, or login details. The assistant prompt enforces this and forbids inventing stats.

## Prerequisites

- Node.js 20 or newer
- A MongoDB Atlas cluster (the free M0 tier is fine)
- An OpenAI API key

## Installation

```bash
git clone <your-repo-url>
cd osrspt
npm install
cp .env.example .env   # then fill in real values
```

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | yes | MongoDB Atlas connection string. Include a database name, e.g. `/osrspt`. |
| `OPENAI_API_KEY` | yes | OpenAI API key. Server-side only. |
| `OPENAI_MODEL` | no | Chat model. Default `gpt-4o-mini`. |
| `NODE_ENV` | no | `development` or `production`. |
| `PORT` | no | Local port, default `3000`. On Render this is injected — do not set it. |
| `HISTORY_LIMIT` | no | Prior messages replayed into the model. Default `20`. |
| `CORS_ORIGINS` | no | Comma-separated origin allow-list. Leave empty when the frontend is same-origin (the default). |

`.env` is gitignored and must never be committed. Only `.env.example` is tracked.

## Running locally

```bash
npm start     # production-style
npm run dev   # nodemon, restarts on change
```

Then open http://localhost:3000

The server starts even when environment variables are missing — it logs which ones and
`/health` reports them by name — so you can verify the frontend before wiring up credentials.

## Testing

```bash
npm test              # dependency-free smoke suite
SKIP_NETWORK=1 npm test   # skip the live hiscores call
```

The suite boots the app in-process on an ephemeral port and checks the Phase 8 list: `/health`,
static assets, request validation, malformed JSON, the RSN permission gate, a live hiscores
lookup, combat-level maths, database connectivity, chat + OpenAI, conversation persistence, and
that no secrets or secret names appear in `/public`. Tests needing absent credentials are
reported as `SKIP`, not `FAIL`.

Manual checks:

```bash
curl localhost:3000/health

# Must be rejected with 403 — no permission
curl -X POST localhost:3000/api/player/lookup \
  -H 'Content-Type: application/json' \
  -d '{"rsn":"Lynx Titan"}'

# Succeeds
curl -X POST localhost:3000/api/player/lookup \
  -H 'Content-Type: application/json' \
  -d '{"rsn":"Lynx Titan","permissionGranted":true}'

curl -X POST localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"test-session-1","message":"What boss should I learn next?"}'
```

## API

### `GET /health`

```json
{
  "status": "ok",
  "env": "development",
  "uptimeSeconds": 12,
  "database": "connected",
  "ai": "configured",
  "missingEnv": []
}
```

`missingEnv` lists variable **names** only, never values.

### `POST /api/chat`

```json
{
  "sessionId": "abc123def",
  "message": "What boss should I learn next?",
  "rsn": "ExampleRSN",
  "style": "concise",
  "gearTier": "mid-game",
  "permissionGranted": true
}
```

`sessionId` is required (6–100 chars, `[A-Za-z0-9_-]`). `message` is required, max 2000 chars.
`style` is one of `concise` | `gear` | `deep`. `gearTier` is one of `budget` | `mid-game` |
`near-bis` | `bis`. Returns the assistant reply plus `playerDataLoaded`, `needsPermission`,
`persisted`, `model` and `usage`.

This endpoint **never** performs a hiscores lookup. It only reads a snapshot that a prior
permitted lookup cached.

### `GET /api/chat/:sessionId`

Replays a stored conversation.

### `POST /api/player/lookup`

```json
{ "rsn": "ExampleRSN", "permissionGranted": true, "mode": "main", "sessionId": "abc123def" }
```

Returns `403 PERMISSION_REQUIRED` unless `permissionGranted` is exactly boolean `true`. The
permission check runs before any validation or network access. `mode` is one of `main` |
`ironman` | `hardcore` | `ultimate`.

### `GET /api/player/:rsn`

Returns the cached snapshot only. Never triggers a lookup.

All errors use a single shape and never include stack traces, credentials or connection strings:

```json
{ "error": { "code": "PERMISSION_REQUIRED", "message": "Permission is required…" } }
```

## Project structure

```
osrspt/
  public/                 static frontend, served same-origin
    index.html
    app.js                talks only to our own API
    style.css
  src/
    server.js             startup, graceful shutdown, binds 0.0.0.0
    app.js                Express wiring: helmet, CORS, limits, routes
    config.js             env loading + missing-var reporting
    db.js                 Mongo connection, never throws on failure
    middleware/
      errors.js           HttpError, 404, centralized error handler
      validate.js         request validation helpers
    routes/
      chat.js             POST /api/chat, GET /api/chat/:sessionId
      player.js           POST /api/player/lookup, GET /api/player/:rsn
    services/
      openai.js           OpenAI client + safe error mapping
      osrs.js             ALL external hiscores access lives here
      prompt.js           server-side assistant instructions
    models/
      Conversation.js
      Player.js
  scripts/
    smoke.js              npm test
  render.yaml             Render blueprint
  .env.example
  .gitignore
```

Two additions to the originally sketched layout, both to keep concerns separated:

- **`src/app.js` split from `src/server.js`** so the smoke tests can build the app and listen on
  an ephemeral port without starting the real server or duplicating middleware setup.
- **`src/services/prompt.js` split from `services/openai.js`** so assistant behaviour (Phase 4)
  can be edited and reviewed without touching the API client. `src/config.js` and
  `src/middleware/` exist for the same reason.

## Security

- `helmet` with a restrictive CSP; `connect-src 'self'`, no inline scripts.
- JSON body limit of 32 kb; `413` and `400` handled explicitly.
- Rate limits: 30 req/min per IP across `/api`, 12/min on `/api/chat`, 10/min on
  `/api/player/lookup`. `trust proxy` is set so Render forwards real client IPs.
- Strict validation on every field, with an allow-listed RSN charset.
- Centralized error handler; only messages explicitly marked safe reach the client.
- Secrets are read from `process.env` exclusively and are never sent to the browser or logged.
  The smoke suite asserts that no key patterns or secret variable names appear in `/public`.
- CORS stays off in production unless `CORS_ORIGINS` is set, because the frontend is same-origin.

## Deployment (Render)

`render.yaml` is included, so you can either use the blueprint or configure manually.

**Manual setup:** Render → New → Web Service → connect the repo.

| Setting | Value |
| --- | --- |
| Environment | Node |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/health` |

Environment variables to add in Render → Environment:

- `MONGODB_URI`
- `OPENAI_API_KEY`
- `NODE_ENV` = `production`
- `OPENAI_MODEL` (optional)

Do **not** set `PORT` — Render injects it, and the server reads `process.env.PORT` and binds
`0.0.0.0` so the platform can route traffic in.

**MongoDB Atlas network access:** Atlas → Network Access → Add IP Address. Render web services on
the free and starter tiers do not have static outbound IPs, so allow `0.0.0.0/0` and rely on the
database user's credentials and a strong password. If you are on a Render plan with static
outbound IPs, allow-list those addresses instead. Use a dedicated database user with
`readWrite` on the `osrspt` database only — not an admin user.

**Verify the deployment:**

1. `curl https://<your-service>.onrender.com/health` → `status: "ok"`, `database: "connected"`,
   `ai: "configured"`, `missingEnv: []`.
2. Open the site; the status dot in the header should read "online".
3. Send a chat message and confirm a reply.
4. Enter an RSN, click **Allow lookup**, and confirm the stat card populates.
5. Reload the page — history and the stat card should restore from MongoDB.

Free Render instances sleep when idle, so the first request after a pause can take ~30 seconds.

## Roadmap

- Live Grand Exchange prices via the OSRS Wiki real-time price API.
- A structured gear database so tier recommendations are data-driven rather than model-generated.
- Retrieval over OSRS Wiki content for citable, current mechanics.
- Per-user accounts and multi-conversation history.

## License

MIT
