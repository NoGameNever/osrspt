'use strict';

/**
 * All external OSRS data access is isolated in this module.
 *
 * We use Jagex's PUBLIC Old School RuneScape hiscores endpoint. That is the
 * only account information this app can ever see: it exposes ranks, levels,
 * XP and some activity/boss killcounts for accounts that appear on the
 * hiscores. It does NOT expose bank value, inventory, quests, achievement
 * diaries, collection log, membership status, or anything private.
 */

const HISCORE_BASE = 'https://secure.runescape.com';

// Supported hiscores game modes -> URL path segment.
const MODES = {
  main: 'm=hiscore_oldschool',
  ironman: 'm=hiscore_oldschool_ironman',
  hardcore: 'm=hiscore_oldschool_hardcore_ironman',
  ultimate: 'm=hiscore_oldschool_ultimate',
};

const REQUEST_TIMEOUT_MS = 12000;

class OsrsLookupError extends Error {
  constructor(message, { status = 502, code = 'HISCORES_ERROR' } = {}) {
    super(message);
    this.name = 'OsrsLookupError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

/**
 * RSNs are 1-12 characters: letters, digits, spaces, underscores, hyphens.
 */
function isValidRsn(rsn) {
  return typeof rsn === 'string' && /^[A-Za-z0-9 _-]{1,12}$/.test(rsn.trim());
}

function normalizeRsn(rsn) {
  return String(rsn || '').trim().replace(/[_\s]+/g, ' ');
}

function rsnKey(rsn) {
  return normalizeRsn(rsn).toLowerCase();
}

/**
 * Combat level from the standard OSRS formula.
 * Returns null if any required skill is missing.
 */
function computeCombatLevel(levels) {
  const need = ['attack', 'strength', 'defence', 'hitpoints', 'ranged', 'prayer', 'magic'];
  for (const k of need) {
    if (typeof levels[k] !== 'number') return null;
  }
  const base =
    0.25 * (levels.defence + levels.hitpoints + Math.floor(levels.prayer / 2));
  const melee = 0.325 * (levels.attack + levels.strength);
  const range = 0.325 * (Math.floor(levels.ranged / 2) + levels.ranged);
  const mage = 0.325 * (Math.floor(levels.magic / 2) + levels.magic);
  return Math.floor(base + Math.max(melee, range, mage));
}

/**
 * Turns the raw hiscores payload into our own stable shape.
 * Unranked entries come back as -1 from Jagex; we keep them as-is rather
 * than guessing a value, and mark them `unranked`.
 */
function normalizeHiscores(raw, { rsn, mode }) {
  const skills = (raw.skills || []).map((s) => ({
    name: String(s.name),
    rank: Number(s.rank),
    level: Number(s.level),
    xp: Number(s.xp),
    unranked: Number(s.rank) === -1,
  }));

  const activities = (raw.activities || [])
    .map((a) => ({
      name: String(a.name),
      rank: Number(a.rank),
      score: Number(a.score),
    }))
    .filter((a) => a.score > 0); // only keep things the player has actually done

  const byName = {};
  for (const s of skills) byName[s.name.toLowerCase()] = s.level;

  const overall = skills.find((s) => s.name.toLowerCase() === 'overall');

  return {
    source: 'osrs-hiscores',
    mode,
    rsn,
    combatLevel: computeCombatLevel(byName),
    totalLevel: overall ? overall.level : null,
    totalXp: overall ? overall.xp : null,
    skills,
    activities,
    fetchedAt: new Date().toISOString(),
    disclaimer:
      'Public OSRS hiscores only. Does not include bank, inventory, quests, diaries, or collection log.',
  };
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'OSRSpt/0.1 (public hiscores lookup)',
        Accept: 'application/json',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches public hiscores for an RSN.
 * Throws OsrsLookupError with a user-safe message on failure.
 */
async function fetchPlayerStats(rsnInput, modeInput = 'main') {
  const rsn = normalizeRsn(rsnInput);
  const mode = MODES[modeInput] ? modeInput : 'main';

  if (!isValidRsn(rsn)) {
    throw new OsrsLookupError(
      'That RSN does not look valid. RSNs are 1-12 characters using letters, numbers, spaces, hyphens or underscores.',
      { status: 400, code: 'INVALID_RSN' }
    );
  }

  const url = `${HISCORE_BASE}/${MODES[mode]}/index_lite.json?player=${encodeURIComponent(rsn)}`;

  let res;
  try {
    res = await fetchWithTimeout(url);
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    throw new OsrsLookupError(
      aborted
        ? 'The OSRS hiscores service did not respond in time. Try again shortly.'
        : 'Could not reach the OSRS hiscores service.',
      { status: 504, code: aborted ? 'HISCORES_TIMEOUT' : 'HISCORES_UNREACHABLE' }
    );
  }

  if (res.status === 404) {
    throw new OsrsLookupError(
      `No ${mode} hiscores entry found for "${rsn}". The name may be spelled differently, or the account may be too low-level to appear on the hiscores.`,
      { status: 404, code: 'PLAYER_NOT_FOUND' }
    );
  }

  if (!res.ok) {
    throw new OsrsLookupError(
      `The OSRS hiscores service returned an error (HTTP ${res.status}).`,
      { status: 502, code: 'HISCORES_ERROR' }
    );
  }

  const text = await res.text();
  if (!text.trim()) {
    throw new OsrsLookupError(
      `No hiscores data returned for "${rsn}".`,
      { status: 404, code: 'PLAYER_NOT_FOUND' }
    );
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (_) {
    throw new OsrsLookupError('Unexpected response format from the OSRS hiscores service.', {
      status: 502,
      code: 'HISCORES_BAD_FORMAT',
    });
  }

  if (!Array.isArray(raw.skills) || raw.skills.length === 0) {
    throw new OsrsLookupError(
      `No hiscores data returned for "${rsn}".`,
      { status: 404, code: 'PLAYER_NOT_FOUND' }
    );
  }

  return normalizeHiscores(raw, { rsn: raw.name || rsn, mode });
}

/**
 * Builds a short, token-cheap summary of a player for the model prompt.
 * Never invents values.
 */
function summarizeForPrompt(stats) {
  if (!stats) return null;

  const wanted = [
    'Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic',
    'Slayer', 'Herblore', 'Agility', 'Farming', 'Construction', 'Runecraft',
  ];
  const levels = (stats.skills || [])
    .filter((s) => wanted.includes(s.name))
    .map((s) => `${s.name} ${s.unranked ? 'unranked' : s.level}`)
    .join(', ');

  const topKills = (stats.activities || [])
    .filter((a) => a.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map((a) => `${a.name}: ${a.score}`)
    .join(', ');

  const lines = [
    `RSN: ${stats.rsn}`,
    `Hiscores mode: ${stats.mode}`,
    stats.combatLevel != null ? `Combat level: ${stats.combatLevel}` : null,
    stats.totalLevel != null ? `Total level: ${stats.totalLevel}` : null,
    stats.totalXp != null ? `Total XP: ${stats.totalXp}` : null,
    levels ? `Key skills: ${levels}` : null,
    topKills ? `Notable activity/boss scores: ${topKills}` : 'Notable activity/boss scores: none recorded on the hiscores.',
    `Snapshot taken: ${stats.fetchedAt}`,
    'Source: public OSRS hiscores. No bank value, inventory, quest, diary, or collection log data is available.',
  ].filter(Boolean);

  return lines.join('\n');
}

module.exports = {
  fetchPlayerStats,
  summarizeForPrompt,
  normalizeRsn,
  rsnKey,
  isValidRsn,
  computeCombatLevel,
  OsrsLookupError,
  MODES,
};
