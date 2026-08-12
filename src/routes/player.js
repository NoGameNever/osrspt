'use strict';

const express = require('express');
const osrs = require('../services/osrs');
const Player = require('../models/Player');
const Conversation = require('../models/Conversation');
const { isDbReady } = require('../db');
const { HttpError } = require('../middleware/errors');
const {
  requireBody,
  requireString,
  optionalString,
  optionalEnum,
} = require('../middleware/validate');

const router = express.Router();

/**
 * POST /api/player/lookup
 * Body: { rsn, permissionGranted, mode?, sessionId? }
 *
 * Hard rule: no lookup happens unless permissionGranted === true.
 */
router.post('/lookup', async (req, res, next) => {
  try {
    const body = requireBody(req);

    // Permission gate FIRST — before any validation or network access.
    if (body.permissionGranted !== true) {
      throw new HttpError(
        403,
        'Permission is required before looking up public account data. Send permissionGranted: true to confirm.',
        'PERMISSION_REQUIRED'
      );
    }

    const rsn = requireString(body, 'rsn', { max: 12 });
    const mode = optionalEnum(body, 'mode', Object.keys(osrs.MODES), 'main');
    const sessionId = optionalString(body, 'sessionId', { max: 100 });

    const stats = await osrs.fetchPlayerStats(rsn, mode);

    let cached = false;
    if (isDbReady()) {
      try {
        await Player.findOneAndUpdate(
          { rsnKey: osrs.rsnKey(stats.rsn) },
          {
            rsnKey: osrs.rsnKey(stats.rsn),
            rsn: stats.rsn,
            publicStats: stats,
            lastUpdated: new Date(),
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        cached = true;

        if (sessionId) {
          await Conversation.findOneAndUpdate(
            { sessionId },
            { sessionId, rsn: stats.rsn, lookupPermissionGranted: true },
            { upsert: true, setDefaultsOnInsert: true }
          );
        }
      } catch (dbErr) {
        // Persistence is best-effort; the lookup itself already succeeded.
        console.error('[player] failed to cache stats:', dbErr.message);
      }
    }

    res.json({ rsn: stats.rsn, stats, persisted: cached });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/player/:rsn — returns the cached snapshot only. Never triggers a lookup.
 */
router.get('/:rsn', async (req, res, next) => {
  try {
    if (!isDbReady()) {
      throw new HttpError(
        503,
        'No database is configured, so cached player data is unavailable.',
        'DB_UNAVAILABLE'
      );
    }
    const key = osrs.rsnKey(req.params.rsn);
    if (!osrs.isValidRsn(req.params.rsn)) {
      throw new HttpError(400, 'That RSN does not look valid.', 'INVALID_RSN');
    }
    const player = await Player.findOne({ rsnKey: key }).lean();
    if (!player) {
      throw new HttpError(
        404,
        'No cached data for that RSN. Run a lookup with permission first.',
        'NOT_CACHED'
      );
    }
    res.json({
      rsn: player.rsn,
      stats: player.publicStats,
      lastUpdated: player.lastUpdated,
      cached: true,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
