'use strict';

const express = require('express');
const { config } = require('../config');
const { isDbReady } = require('../db');
const Conversation = require('../models/Conversation');
const Player = require('../models/Player');
const osrs = require('../services/osrs');
const ai = require('../services/openai');
const { buildSystemPrompt, GEAR_TIERS } = require('../services/prompt');
const {
  requireBody,
  requireString,
  optionalString,
  optionalEnum,
  requireSessionId,
  LIMITS,
} = require('../middleware/validate');

const router = express.Router();

/** In-memory fallback history so chat still works with no database. */
const memoryStore = new Map();
const MEMORY_MAX_SESSIONS = 500;

function memoryGet(sessionId) {
  return memoryStore.get(sessionId) || { sessionId, rsn: null, messages: [] };
}

function memorySet(sessionId, convo) {
  if (!memoryStore.has(sessionId) && memoryStore.size >= MEMORY_MAX_SESSIONS) {
    memoryStore.delete(memoryStore.keys().next().value);
  }
  convo.messages = convo.messages.slice(-2 * config.historyLimit);
  memoryStore.set(sessionId, convo);
}

/**
 * POST /api/chat
 * Body: { sessionId, message, rsn?, style?, gearTier?, permissionGranted? }
 */
router.post('/', async (req, res, next) => {
  try {
    const body = requireBody(req);

    const sessionId = requireSessionId(body);
    const message = requireString(body, 'message', { max: LIMITS.message });
    const rsnInput = optionalString(body, 'rsn', { max: LIMITS.rsn });
    const style = optionalEnum(body, 'style', ['concise', 'gear', 'deep'], 'concise');
    const gearTier = optionalEnum(body, 'gearTier', GEAR_TIERS, null);
    const permissionGranted = body.permissionGranted === true;

    const rsn = rsnInput ? osrs.normalizeRsn(rsnInput) : null;
    if (rsn && !osrs.isValidRsn(rsn)) {
      return res.status(400).json({
        error: {
          code: 'INVALID_RSN',
          message:
            'That RSN does not look valid. RSNs are 1-12 characters using letters, numbers, spaces, hyphens or underscores.',
        },
      });
    }

    const dbUp = isDbReady();

    // 1. Load conversation history.
    let convo;
    if (dbUp) {
      convo = await Conversation.findOne({ sessionId });
      if (!convo) convo = new Conversation({ sessionId, rsn });
    } else {
      convo = memoryGet(sessionId);
    }

    if (rsn) convo.rsn = rsn;
    if (permissionGranted) convo.lookupPermissionGranted = true;

    const effectiveRsn = rsn || convo.rsn || null;
    const effectivePermission = permissionGranted || convo.lookupPermissionGranted === true;

    // 2. Load cached player data — only if permission exists. Never fetched here.
    let playerSummary = null;
    let playerStats = null;
    if (dbUp && effectiveRsn && effectivePermission) {
      try {
        const player = await Player.findOne({ rsnKey: osrs.rsnKey(effectiveRsn) }).lean();
        if (player && player.publicStats) {
          playerStats = player.publicStats;
          playerSummary = osrs.summarizeForPrompt({
            ...player.publicStats,
            rsn: player.rsn,
            fetchedAt: (player.lastUpdated || new Date()).toISOString?.() || String(player.lastUpdated),
          });
        }
      } catch (dbErr) {
        console.error('[chat] player lookup failed:', dbErr.message);
      }
    }

    // 3. Build the request server-side.
    const systemPrompt = buildSystemPrompt({
      playerSummary,
      rsn: effectiveRsn,
      permissionGranted: effectivePermission,
      style,
      gearTier,
    });

    const history = (convo.messages || [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-config.historyLimit)
      .map((m) => ({ role: m.role, content: m.content }));

    // 4. Call the model (server-side only).
    const { reply, model, usage } = await ai.createChatCompletion({
      systemPrompt,
      messages: [...history, { role: 'user', content: message }],
    });

    // 5. Persist.
    const now = new Date();
    convo.messages = (convo.messages || []).concat([
      { role: 'user', content: message, createdAt: now },
      { role: 'assistant', content: reply, createdAt: new Date() },
    ]);

    let persisted = false;
    if (dbUp) {
      try {
        await convo.save();
        persisted = true;
      } catch (dbErr) {
        console.error('[chat] failed to save conversation:', dbErr.message);
      }
    } else {
      memorySet(sessionId, convo);
    }

    res.json({
      sessionId,
      reply,
      rsn: effectiveRsn,
      playerDataLoaded: Boolean(playerSummary),
      needsPermission: Boolean(effectiveRsn) && !effectivePermission,
      style,
      gearTier,
      model,
      usage,
      persisted,
      messageCount: convo.messages.length,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/chat/:sessionId — replay a conversation. */
router.get('/:sessionId', async (req, res, next) => {
  try {
    const sessionId = requireSessionId({ sessionId: req.params.sessionId });

    if (!isDbReady()) {
      const convo = memoryGet(sessionId);
      return res.json({
        sessionId,
        rsn: convo.rsn,
        messages: convo.messages || [],
        persisted: false,
      });
    }

    const convo = await Conversation.findOne({ sessionId }).lean();
    if (!convo) {
      return res.json({ sessionId, rsn: null, messages: [], persisted: true });
    }
    res.json({
      sessionId,
      rsn: convo.rsn,
      lookupPermissionGranted: convo.lookupPermissionGranted,
      messages: convo.messages || [],
      createdAt: convo.createdAt,
      updatedAt: convo.updatedAt,
      persisted: true,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
