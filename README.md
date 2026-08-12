# OSRSpt

An Old School RuneScape research assistant. Ask it about gear, bosses, progression routing,
skilling methods and money making. If you give it your RuneScape Name (RSN) **and grant
permission**, it reads your public OSRS hiscores and personalizes its advice.

Unofficial fan project. Not affiliated with Jagex.

## What it does

- Chat interface backed by the OpenAI API, called **only** from the server.
- Public OSRS hiscores lookup, gated behind explicit user permission.
- **Live Grand Exchange prices** from the OSRS Wiki real-time price API, exposed to the model as
  a tool so it looks prices up instead of recalling stale ones.
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
git clone https://github.com/NoGameNever/osrspt.git
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
| `PRICES_USER_AGENT` | no | User-Agent sent to the OSRS Wiki price API. A sensible default is set; override it to identify your own deployment. |

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

### `GET /api/prices/item?name=<item>`

Current Grand Exchange data for one item. Accepts exact names, an item id, common shorthand
(`tbow`, `bcp`, `whip`), possessives (`zulrah scale`) and undosed potion names (`saradomin brew`
resolves to the 4-dose).

```json
{
  "id": 20997,
  "name": "Twisted bow",
  "buyLimit": 8,
  "highAlch": 2400000,
  "price": { "instaBuy": 1289000000, "instaSell": 1280808641, "instaBuyAge": "45s ago" },
  "margin": { "grossPerItem": 8191359, "geTaxPerItem": 5000000, "netPerItem": 3191359 },
  "last24h": { "avgHigh": 1343776076, "avgLow": 1339541266, "volume": 392 },
  "stale": false
}
```

### `GET /api/prices/search?q=<text>`

Candidate item names, for disambiguating a vague query.

### `POST /api/prices/bulk`

```json
{ "items": ["twisted bow", "scythe of vitur"] }
```

Up to 12 items. Individual failures are reported per item rather than failing the batch.

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
      prices.js           GET /api/prices/item, /search, POST /bulk
    services/
      openai.js           OpenAI client, tool-calling loop, safe error mapping
      osrs.js             ALL external hiscores access lives here
      prices.js           ALL external GE price access lives here
      tools.js            tool definitions + handlers the model may call
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

## Grand Exchange prices

Prices come from the [OSRS Wiki real-time price API](https://oldschool.runescape.wiki/w/RuneScape:Real-time_Prices).
All access is isolated in `src/services/prices.js`.

**The model is never asked to recall a price.** `src/services/tools.js` exposes `get_item_prices`
and `search_items` as OpenAI tools, and the system prompt requires a tool call before any GP
figure is stated. If the lookup fails, the assistant is instructed to say so rather than
substitute a remembered number. Chat responses include a `toolsUsed` array, and the frontend
labels any answer whose prices came from a live lookup.

### Caching and etiquette

The Wiki serves these as bulk documents, so we fetch each whole and cache it in memory rather
than making one request per item:

| Data | Endpoint | Size | Cache |
| --- | --- | --- | --- |
| Item mapping | `/mapping` | ~860 kB | 24 hours (warmed at boot) |
| Latest prices | `/latest` | ~340 kB | 60 seconds |
| 24-hour averages | `/24h` | ~380 kB | 30 minutes |

Concurrent refreshes of the same endpoint are de-duplicated, and if a refresh fails while an
older copy is cached, the stale copy is served instead of failing the request. The Wiki asks
consumers to send a descriptive `User-Agent`; ours is set in `prices.js` and overridable with
`PRICES_USER_AGENT`.

### Grand Exchange tax

The tax is **2% of the sale price, rounded down, capped at 5,000,000 gp per item**, and is not
charged below 50 gp. It was introduced at 1% on 9 December 2021 and raised to 2% on
29 May 2025 — figures from before that date are wrong. A small set of items is exempt; that
list changes with game updates and is **not** modelled here, which the API response notes.

## Roadmap

- A structured gear database so tier recommendations are data-driven rather than model-generated.
- Retrieval over OSRS Wiki content for citable, current mechanics.
- Per-user accounts and multi-conversation history.

## License

MIT
