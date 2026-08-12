'use strict';

/**
 * Dependency-free smoke tests for the Phase 8 checklist.
 *
 * Boots the app in-process on an ephemeral port and exercises the API.
 * Tests that need real credentials are skipped (not failed) when the matching
 * environment variable is absent, so this is safe to run before setup.
 *
 *   node scripts/smoke.js
 */

const { config, checkEnv } = require('../src/config');
const { connectDb, disconnectDb, dbStatus } = require('../src/db');
const { createApp } = require('../src/app');

let pass = 0;
let fail = 0;
let skip = 0;
let base = '';

function ok(name, detail) {
  pass++;
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function bad(name, detail) {
  fail++;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function skipped(name, why) {
  skip++;
  console.log(`  SKIP  ${name} — ${why}`);
}

async function req(path, options = {}) {
  const res = await fetch(base + path, options);
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    body = null;
  }
  return { status: res.status, body };
}

function post(path, payload) {
  return req(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

async function expectStatus(name, promise, expected) {
  try {
    const { status, body } = await promise;
    const list = Array.isArray(expected) ? expected : [expected];
    if (list.includes(status)) {
      ok(name, `HTTP ${status}`);
      return body;
    }
    bad(name, `expected ${list.join('/')}, got ${status} ${JSON.stringify(body)}`);
    return body;
  } catch (err) {
    bad(name, err.message);
    return null;
  }
}

async function run() {
  const missing = checkEnv();
  console.log(`\nOSRSpt smoke tests (env: ${config.env})`);
  if (missing.length) console.log(`Missing env: ${missing.join(', ')} — related tests will skip.\n`);
  else console.log('All required env vars present.\n');

  await connectDb();
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  console.log('Core');
  const health = await expectStatus('/health responds', req('/health'), 200);
  if (health && health.status === 'ok') ok('/health reports status ok');
  else bad('/health reports status ok', JSON.stringify(health));

  if (health && Array.isArray(health.missingEnv)) {
    ok('/health lists missing env by NAME only', `missingEnv=[${health.missingEnv.join(', ')}]`);
  } else {
    bad('/health lists missing env');
  }

  await expectStatus('frontend index.html served', req('/'), 200);
  await expectStatus('frontend app.js served', req('/app.js'), 200);
  await expectStatus('frontend style.css served', req('/style.css'), 200);
  await expectStatus('unknown route returns 404 JSON', req('/api/nope'), 404);

  console.log('\nValidation');
  await expectStatus('chat rejects empty body', post('/api/chat', {}), 400);
  await expectStatus(
    'chat rejects missing message',
    post('/api/chat', { sessionId: 'smoke-session-1' }),
    400
  );
  await expectStatus(
    'chat rejects bad sessionId',
    post('/api/chat', { sessionId: 'ab', message: 'hi' }),
    400
  );
  await expectStatus(
    'chat rejects oversized message',
    post('/api/chat', { sessionId: 'smoke-session-1', message: 'x'.repeat(2001) }),
    400
  );
  await expectStatus(
    'chat rejects invalid RSN',
    post('/api/chat', { sessionId: 'smoke-session-1', message: 'hi', rsn: 'way too long name!!' }),
    400
  );
  await expectStatus('malformed JSON rejected', post('/api/chat', '{nope'), 400);

  console.log('\nPermission gate (Phase 5)');
  await expectStatus(
    'lookup blocked with no permission field',
    post('/api/player/lookup', { rsn: 'Lynx Titan' }),
    403
  );
  await expectStatus(
    'lookup blocked with permissionGranted:false',
    post('/api/player/lookup', { rsn: 'Lynx Titan', permissionGranted: false }),
    403
  );
  await expectStatus(
    'lookup blocked with truthy-but-not-true value',
    post('/api/player/lookup', { rsn: 'Lynx Titan', permissionGranted: 'yes' }),
    403
  );

  console.log('\nHiscores lookup (live external call)');
  if (process.env.SKIP_NETWORK === '1') {
    skipped('hiscores lookup succeeds with permission', 'SKIP_NETWORK=1');
  } else {
    const body = await expectStatus(
      'hiscores lookup succeeds with permission',
      post('/api/player/lookup', { rsn: 'Lynx Titan', permissionGranted: true }),
      200
    );
    if (body && body.stats && body.stats.combatLevel === 126) {
      ok('combat level computed correctly', `Lynx Titan = ${body.stats.combatLevel}`);
    } else if (body && body.stats) {
      bad('combat level computed correctly', `got ${body.stats.combatLevel}, expected 126`);
    }
    await expectStatus(
      'nonexistent RSN returns a clean 404',
      post('/api/player/lookup', {
        rsn: 'zzqqxxjj9',
        permissionGranted: true,
      }),
      [404, 400]
    );
  }

  console.log('\nDatabase');
  if (dbStatus() === 'connected') {
    ok('MongoDB connected');
  } else if (dbStatus() === 'not-configured') {
    skipped('MongoDB connected', 'MONGODB_URI not set');
  } else {
    bad('MongoDB connected', `status=${dbStatus()}`);
  }

  console.log('\nGrand Exchange prices');
  {
    const prices = require('../src/services/prices');

    // Tax maths is pure and must match the Wiki's own worked examples:
    // 2%, rounded down, nothing under 50 gp, capped at 5m per item.
    const taxCases = [
      [49, 0],
      [50, 1],
      [99, 1],
      [100, 2],
      [1000, 20],
      [1_000_000_000, 5_000_000],
    ];
    const taxBad = taxCases.filter(([input, want]) => prices.geTax(input) !== want);
    if (taxBad.length === 0) ok('GE tax maths matches the Wiki (2%, floor, 5m cap, free under 50)');
    else bad('GE tax maths', JSON.stringify(taxBad));

    const whip = await expectStatus(
      'price lookup by name',
      req('/api/prices/item?name=abyssal%20whip'),
      200
    );
    if (whip && whip.id === 4151 && whip.name === 'Abyssal whip') {
      ok('resolved shorthand to the right item', `id ${whip.id}`);
    } else {
      bad('resolved shorthand to the right item', JSON.stringify(whip).slice(0, 120));
    }
    if (whip && whip.price && Number.isFinite(whip.price.instaBuy) && whip.price.instaBuy > 0) {
      ok('live price returned', `${whip.price.instaBuy.toLocaleString()} gp`);
    } else {
      bad('live price returned', JSON.stringify(whip && whip.price));
    }
    if (whip && whip.margin && whip.margin.geTaxPerItem === prices.geTax(whip.price.instaBuy)) {
      ok('margin subtracts the same tax the helper computes');
    } else {
      bad('margin tax consistency', JSON.stringify(whip && whip.margin));
    }

    // Aliases and possessives were both wrong in early drafts.
    const alias = await expectStatus('shorthand alias resolves', req('/api/prices/item?name=tbow'), 200);
    if (alias && alias.name === 'Twisted bow') ok('"tbow" resolves to Twisted bow');
    else bad('"tbow" resolves to Twisted bow', alias && alias.name);

    const poss = await expectStatus(
      'possessive item name resolves',
      req('/api/prices/item?name=zulrah%20scale'),
      200
    );
    if (poss && poss.name === "Zulrah's scales") ok('"zulrah scale" resolves to Zulrah\'s scales');
    else bad('possessive resolution', poss && poss.name);

    const dose = await expectStatus(
      'dose defaulting',
      req('/api/prices/item?name=saradomin%20brew'),
      200
    );
    if (dose && dose.name === 'Saradomin brew(4)') ok('undosed potion query defaults to (4)');
    else bad('dose defaulting', dose && dose.name);

    await expectStatus('unknown item is a 404', req('/api/prices/item?name=zzzznotanitem'), 404);
    await expectStatus('missing name is rejected', req('/api/prices/item'), 400);

    const search = await expectStatus('item search works', req('/api/prices/search?q=dragon'), 200);
    if (search && Array.isArray(search.matches) && search.matches.length > 1) {
      ok('search returns candidates', `${search.matches.length} matches`);
    } else {
      bad('search returns candidates', JSON.stringify(search).slice(0, 120));
    }

    const bulk = await expectStatus(
      'bulk pricing works',
      post('/api/prices/bulk', { items: ['twisted bow', 'scythe of vitur'] }),
      200
    );
    if (bulk && bulk.results && bulk.results.length === 2 && bulk.results.every((r) => r.id)) {
      ok('bulk returned both items');
    } else {
      bad('bulk returned both items', JSON.stringify(bulk).slice(0, 120));
    }

    await expectStatus('bulk rejects an empty list', post('/api/prices/bulk', { items: [] }), 400);
    await expectStatus(
      'bulk rejects oversized batches',
      post('/api/prices/bulk', { items: Array(20).fill('shark') }),
      400
    );
  }

  console.log('\nChat + OpenAI');
  const sessionId = 'smoke-' + Date.now();
  if (!config.openaiApiKey) {
    const body = await expectStatus(
      'chat returns a clear error when OPENAI_API_KEY is unset',
      post('/api/chat', { sessionId, message: 'What boss should I learn next?' }),
      503
    );
    if (body && body.error && /OPENAI_API_KEY/.test(body.error.message)) {
      ok('missing-key error names the variable');
    }
    skipped('chat completion succeeds', 'OPENAI_API_KEY not set');
    skipped('conversation persisted', 'requires a successful chat');
    skipped('model called get_item_prices', 'OPENAI_API_KEY not set');
  } else {
    const body = await expectStatus(
      'chat completion succeeds',
      post('/api/chat', { sessionId, message: 'In one sentence: what is a Slayer task?' }),
      200
    );
    if (body && body.reply) ok('assistant reply received', `${body.reply.slice(0, 60)}…`);

    // A price question must go through the tool, not the model's memory.
    const priced = await expectStatus(
      'price question triggers a tool call',
      post('/api/chat', {
        sessionId: sessionId + '-price',
        message: 'What does an abyssal whip cost right now?',
      }),
      200
    );
    if (priced && Array.isArray(priced.toolsUsed) && priced.toolsUsed.includes('get_item_prices')) {
      ok('model called get_item_prices instead of guessing');
    } else {
      bad('model called get_item_prices', JSON.stringify(priced && priced.toolsUsed));
    }

    const replay = await expectStatus(
      'conversation history replays',
      req('/api/chat/' + sessionId),
      200
    );
    if (replay && replay.messages && replay.messages.length >= 2) {
      ok('conversation persisted', `${replay.messages.length} messages`);
    } else {
      bad('conversation persisted', JSON.stringify(replay));
    }
  }

  console.log('\nSecret hygiene');
  const fs = require('fs');
  const path = require('path');
  const publicDir = path.join(__dirname, '..', 'public');
  const files = fs.readdirSync(publicDir);
  const banned = [/sk-[A-Za-z0-9]{16,}/, /mongodb\+srv:\/\//, /OPENAI_API_KEY/, /MONGODB_URI/];
  let leaked = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(publicDir, f), 'utf8');
    for (const rx of banned) if (rx.test(text)) leaked.push(`${f} matches ${rx}`);
  }
  if (leaked.length === 0) ok('no secrets or secret names in /public');
  else bad('no secrets in /public', leaked.join('; '));

  server.close();
  await disconnectDb();

  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('smoke runner crashed:', err);
  process.exit(1);
});
