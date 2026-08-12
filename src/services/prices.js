'use strict';

/**
 * OSRS Wiki real-time Grand Exchange prices.
 *
 * Docs: https://oldschool.runescape.wiki/w/RuneScape:Real-time_Prices
 * The Wiki asks every consumer to send a descriptive User-Agent so they can
 * contact us if our traffic causes problems. Do not remove it.
 *
 * All three upstream payloads are bulk documents (mapping ~860 kB, latest
 * ~340 kB, 24h ~380 kB), so we fetch each one whole and cache it in memory
 * rather than making one request per item. `/latest` and `/24h` ignore an
 * `id` filter for our purposes, which makes bulk-plus-cache the right shape
 * anyway.
 */

const PRICES_BASE = 'https://prices.runescape.wiki/api/v1/osrs';
const WIKI_ITEM_URL = 'https://oldschool.runescape.wiki/w/';

const USER_AGENT =
  process.env.PRICES_USER_AGENT ||
  'OSRSpt/0.1 (OSRS assistant; +https://github.com/NoGameNever/osrspt)';

const REQUEST_TIMEOUT_MS = 15000;

// Cache lifetimes. The Wiki updates /latest continuously; 60s is polite and
// still fresh enough for advice. Mapping is effectively static.
const TTL = {
  mapping: 24 * 60 * 60 * 1000,
  latest: 60 * 1000,
  day: 30 * 60 * 1000,
};

/**
 * Grand Exchange convenience fee ("GE tax"), verified against the OSRS Wiki:
 * 2% of the sale price, rounded DOWN, capped at 5,000,000 gp per item.
 * Introduced at 1% on 2021-12-09 and raised to 2% on 2025-05-29.
 * Sales under 50 gp per item round down to a 0 gp tax, so they are untaxed.
 *
 * A small set of items is fully exempt. That list changes with updates, so we
 * do NOT model it — see `taxExemptionsModelled` in the payload.
 */
const GE_TAX = { rate: 0.02, cap: 5_000_000, freeBelow: 50 };

class PriceError extends Error {
  constructor(message, { status = 502, code = 'PRICE_ERROR' } = {}) {
    super(message);
    this.name = 'PriceError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

// ---------------------------------------------------------------------------
// Fetching + caching
// ---------------------------------------------------------------------------

const cache = {
  mapping: { data: null, at: 0, index: null },
  latest: { data: null, at: 0 },
  day: { data: null, at: 0 },
};

// De-duplicates concurrent refreshes of the same endpoint.
const inflight = new Map();

async function getJson(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${PRICES_BASE}${path}`, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new PriceError(
        `The OSRS Wiki price service returned an error (HTTP ${res.status}).`,
        { status: 502, code: 'PRICES_UPSTREAM' }
      );
    }
    return await res.json();
  } catch (err) {
    if (err instanceof PriceError) throw err;
    const aborted = err && err.name === 'AbortError';
    throw new PriceError(
      aborted
        ? 'The OSRS Wiki price service did not respond in time.'
        : 'Could not reach the OSRS Wiki price service.',
      { status: 504, code: aborted ? 'PRICES_TIMEOUT' : 'PRICES_UNREACHABLE' }
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns cached data, refreshing when stale.
 * If a refresh fails but we still hold an older copy, we serve the stale copy
 * rather than failing the user's request outright.
 */
async function cached(key, path, transform) {
  const slot = cache[key];
  const fresh = slot.data && Date.now() - slot.at < TTL[key];
  if (fresh) return slot.data;

  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const raw = await getJson(path);
      slot.data = transform ? transform(raw) : raw;
      slot.at = Date.now();
      return slot.data;
    } catch (err) {
      if (slot.data) {
        console.warn(`[prices] refresh of ${key} failed, serving stale cache:`, err.message);
        return slot.data;
      }
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

function getMapping() {
  return cached('mapping', '/mapping', (raw) => {
    if (!Array.isArray(raw)) {
      throw new PriceError('Unexpected item mapping format.', {
        status: 502,
        code: 'PRICES_BAD_FORMAT',
      });
    }
    const byId = new Map();
    const byName = new Map();
    for (const it of raw) {
      byId.set(String(it.id), it);
      byName.set(normalizeName(it.name), it);
    }
    cache.mapping.index = { byId, byName, all: raw };
    return raw;
  });
}

function getLatest() {
  return cached('latest', '/latest', (raw) => raw.data || {});
}

function getDay() {
  return cached('day', '/24h', (raw) => raw.data || {});
}

// ---------------------------------------------------------------------------
// Item resolution
// ---------------------------------------------------------------------------

function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Tokens for matching. Drops the orphaned "s" that possessives leave behind
 * ("Zulrah's scales" -> [zulrah, scales]) so it cannot dilute token overlap.
 */
function tokensOf(normalized) {
  return normalized.split(' ').filter((t) => t && t !== 's');
}

/** Singular/plural and prefix tolerant token comparison. */
function tokenMatches(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 3) return false;
  // scale/scales, bolt/bolts, rune/runes
  if (long === short + 's' || long === short + 'es') return true;
  return long.startsWith(short) && long.length - short.length <= 2;
}

/** Common shorthand players actually type. */
const ALIASES = {
  whip: 'abyssal whip',
  dscim: 'dragon scimitar',
  ddef: 'dragon defender',
  dds: 'dragon dagger',
  'd bones': 'dragon bones',
  bcp: 'bandos chestplate',
  tassets: 'bandos tassets',
  'b ring': 'berserker ring',
  fury: 'amulet of fury',
  torture: 'amulet of torture',
  anguish: 'necklace of anguish',
  occult: 'occult necklace',
  arcane: 'arcane spirit shield',
  elysian: 'elysian spirit shield',
  sgs: 'saradomin godsword',
  bgs: 'bandos godsword',
  ags: 'armadyl godsword',
  zgs: 'zamorak godsword',
  acb: 'armadyl crossbow',
  dhcb: 'dragon hunter crossbow',
  tbow: 'twisted bow',
  scythe: 'scythe of vitur',
  shadow: 'tumeken s shadow',
  claws: 'dragon claws',
  primordials: 'primordial boots',
  pegs: 'pegasian boots',
  eternals: 'eternal boots',
  'prims': 'primordial boots',
  'zenyte': 'zenyte',
  ferocious: 'ferocious gloves',
  // The assembled Avernic defender is untradeable; the hilt is the GE item.
  avernic: 'avernic defender hilt',
  'avernic defender': 'avernic defender hilt',
  'inq': 'inquisitor s mace',
  bowfa: 'bow of faerdhinen inactive',
  crystal: 'crystal armour seed',
  voidwaker: 'voidwaker',
  'dwh': 'dragon warhammer',
  ely: 'elysian spirit shield',
  'dfs': 'dragonfire shield',
  'sang': 'sanguinesti staff',
  'trident': 'trident of the seas',
  'toxic trident': 'trident of the swamp',
  ppots: 'prayer potion 4',
  'prayer pot': 'prayer potion 4',
  brews: 'saradomin brew 4',
  'sara brew': 'saradomin brew 4',
  'super restore': 'super restore 4',
  karambwan: 'cooked karambwan',
  shark: 'shark',
  anglerfish: 'anglerfish',
  'dragon bolts': 'dragon bolts e',
  'ruby bolts': 'ruby bolts e',
  'diamond bolts': 'diamond bolts e',
};

/**
 * Resolves a free-text item name to a mapping entry.
 * Returns { item, exact, alternatives[] }. `item` is null when nothing matched.
 */
async function resolveItem(query) {
  await getMapping();
  const idx = cache.mapping.index;
  const raw = String(query || '').trim();

  if (!raw) {
    throw new PriceError('Provide an item name to look up.', {
      status: 400,
      code: 'MISSING_ITEM',
    });
  }

  // Numeric input is treated as an item id.
  if (/^\d+$/.test(raw)) {
    const byId = idx.byId.get(raw);
    return { item: byId || null, exact: Boolean(byId), alternatives: [] };
  }

  let n = normalizeName(raw);
  if (ALIASES[n]) n = normalizeName(ALIASES[n]);

  const exact = idx.byName.get(n);
  if (exact) return { item: exact, exact: true, alternatives: [] };

  // Score every item: prefix beats substring beats token overlap.
  const qTokens = tokensOf(n);
  const scored = [];

  // "saradomin brew" should mean the 4-dose. Only applies when the user did
  // not name a dose themselves.
  const queryHasDose = /\b[1-4]\b/.test(n);

  for (const it of idx.all) {
    const name = normalizeName(it.name);
    let score = 0;

    if (name === n) score = 1000;
    else if (name.startsWith(n)) score = 500 - name.length;
    else if (name.includes(n)) score = 300 - name.length;
    else if (qTokens.length > 0) {
      const nTokens = tokensOf(name);
      const hits = qTokens.filter((q) => nTokens.some((t) => tokenMatches(q, t))).length;
      if (hits === qTokens.length) {
        // Every word the user typed is present. Prefer the tightest name,
        // and reward covering most of the candidate's own words too.
        score = 200 - name.length + (hits / nTokens.length) * 40;
      } else if (hits > 0) {
        score = hits * 40 - name.length * 0.5;
      }
    }

    if (score > 0) {
      if (!queryHasDose) {
        const dose = it.name.match(/\((\d)\)$/);
        if (dose) score += Number(dose[1]) * 3; // tiebreak toward the full dose
      }
      scored.push({ it, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { item: null, exact: false, alternatives: [] };

  return {
    item: scored[0].it,
    exact: false,
    alternatives: scored.slice(1, 6).map((s) => s.it.name),
  };
}

/** Free-text item search, for disambiguation. */
async function searchItems(query, limit = 10) {
  const { item, alternatives } = await resolveItem(query);
  const names = item ? [item.name, ...alternatives] : [];
  return names.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** GE tax on a single item sold at `price`. Floor, capped, free under 50 gp. */
function geTax(price) {
  if (!Number.isFinite(price) || price < GE_TAX.freeBelow) return 0;
  return Math.min(Math.floor(price * GE_TAX.rate), GE_TAX.cap);
}

function agoSeconds(unixSeconds) {
  if (!Number.isFinite(unixSeconds)) return null;
  return Math.max(0, Math.round(Date.now() / 1000 - unixSeconds));
}

function humanAgo(seconds) {
  if (seconds == null) return 'unknown';
  if (seconds < 90) return `${seconds}s ago`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Full price payload for one item. Every number here comes from the Wiki API
 * or is arithmetic on those numbers — nothing is estimated.
 */
async function getItemPrice(query) {
  const { item, exact, alternatives } = await resolveItem(query);

  if (!item) {
    throw new PriceError(
      `No Grand Exchange item matches "${query}". It may be untradeable, or spelled differently.`,
      { status: 404, code: 'ITEM_NOT_FOUND' }
    );
  }

  const [latest, day] = await Promise.all([getLatest(), getDay()]);
  const id = String(item.id);
  const l = latest[id] || {};
  const d = day[id] || {};

  const instaBuy = Number.isFinite(l.high) ? l.high : null; // what you pay to buy now
  const instaSell = Number.isFinite(l.low) ? l.low : null; // what you get selling now

  let margin = null;
  if (instaBuy != null && instaSell != null) {
    const tax = geTax(instaBuy);
    const net = instaBuy - tax - instaSell;
    margin = {
      grossPerItem: instaBuy - instaSell,
      geTaxPerItem: tax,
      netPerItem: net,
      netPerBuyLimit: Number.isFinite(item.limit) ? net * item.limit : null,
      note: 'Net margin subtracts the 2% GE tax (rounded down, capped at 5m/item). A small set of items is tax-exempt and is not modelled here.',
    };
  }

  const volHigh = Number.isFinite(d.highPriceVolume) ? d.highPriceVolume : 0;
  const volLow = Number.isFinite(d.lowPriceVolume) ? d.lowPriceVolume : 0;

  const buyAgo = agoSeconds(l.highTime);
  const sellAgo = agoSeconds(l.lowTime);
  const freshest = [buyAgo, sellAgo].filter((x) => x != null).sort((a, b) => a - b)[0] ?? null;

  return {
    id: item.id,
    name: item.name,
    members: item.members,
    examine: item.examine,
    buyLimit: Number.isFinite(item.limit) ? item.limit : null,
    highAlch: Number.isFinite(item.highalch) ? item.highalch : null,

    matchedExactly: exact,
    alternatives,

    price: {
      instaBuy,
      instaSell,
      instaBuyAge: humanAgo(buyAgo),
      instaSellAge: humanAgo(sellAgo),
    },

    margin,

    last24h: {
      avgHigh: Number.isFinite(d.avgHighPrice) ? d.avgHighPrice : null,
      avgLow: Number.isFinite(d.avgLowPrice) ? d.avgLowPrice : null,
      volume: volHigh + volLow,
    },

    // Anything not traded for over an hour should be treated with suspicion.
    stale: freshest == null || freshest > 3600,
    dataAgeSeconds: freshest,
    source: 'OSRS Wiki real-time prices',
    sourceUrl: 'https://prices.runescape.wiki/',
    wikiUrl: WIKI_ITEM_URL + encodeURIComponent(item.name.replace(/ /g, '_')),
    fetchedAt: new Date().toISOString(),
  };
}

/** Prices for several items at once; failures are reported per item. */
async function getItemPrices(queries) {
  const list = (Array.isArray(queries) ? queries : [queries]).slice(0, 12);
  const out = await Promise.all(
    list.map(async (q) => {
      try {
        return await getItemPrice(q);
      } catch (err) {
        return { query: q, error: err.message, notFound: err.code === 'ITEM_NOT_FOUND' };
      }
    })
  );
  return out;
}

/** Compact text form for injecting into a model prompt. */
function formatForPrompt(p) {
  if (p.error) return `${p.query}: NO DATA (${p.error})`;

  const gp = (n) => (n == null ? 'n/a' : Number(n).toLocaleString() + ' gp');
  const bits = [
    `${p.name} (id ${p.id})`,
    `buy now ${gp(p.price.instaBuy)} [${p.price.instaBuyAge}]`,
    `sell now ${gp(p.price.instaSell)} [${p.price.instaSellAge}]`,
  ];
  if (p.margin) {
    bits.push(`net flip margin after 2% tax ${gp(p.margin.netPerItem)}`);
  }
  if (p.buyLimit != null) bits.push(`buy limit ${p.buyLimit}/4h`);
  if (p.last24h.volume) bits.push(`24h volume ${p.last24h.volume.toLocaleString()}`);
  if (p.highAlch != null) bits.push(`high alch ${gp(p.highAlch)}`);
  if (p.stale) bits.push('WARNING: no recent trades, price may be unreliable');
  if (!p.matchedExactly && p.alternatives.length) {
    bits.push(`(fuzzy match; other candidates: ${p.alternatives.slice(0, 3).join(', ')})`);
  }
  return bits.join(' | ');
}

/** Warms the mapping cache at boot so the first user request is not slow. */
async function warmUp() {
  try {
    await getMapping();
    console.log('[prices] item mapping cached');
  } catch (err) {
    console.warn('[prices] could not warm item mapping:', err.message);
  }
}

module.exports = {
  getItemPrice,
  getItemPrices,
  searchItems,
  resolveItem,
  formatForPrompt,
  geTax,
  warmUp,
  normalizeName,
  GE_TAX,
  PriceError,
};
