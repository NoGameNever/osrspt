'use strict';

const express = require('express');
const prices = require('../services/prices');
const { HttpError } = require('../middleware/errors');
const { requireBody } = require('../middleware/validate');

const router = express.Router();

/** GET /api/prices/item?name=abyssal+whip */
router.get('/item', async (req, res, next) => {
  try {
    const name = String(req.query.name || '').trim();
    if (!name) throw new HttpError(400, 'Provide ?name=<item>.', 'MISSING_ITEM');
    if (name.length > 80) throw new HttpError(400, 'Item name is too long.', 'FIELD_TOO_LONG');
    res.json(await prices.getItemPrice(name));
  } catch (err) {
    next(err);
  }
});

/** GET /api/prices/search?q=dragon — name suggestions for disambiguation. */
router.get('/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) throw new HttpError(400, 'Provide ?q=<search text>.', 'MISSING_QUERY');
    if (q.length > 80) throw new HttpError(400, 'Search text is too long.', 'FIELD_TOO_LONG');
    res.json({ query: q, matches: await prices.searchItems(q, 10) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/prices/bulk  { items: ["twisted bow", "scythe of vitur"] } */
router.post('/bulk', async (req, res, next) => {
  try {
    const body = requireBody(req);
    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw new HttpError(400, '"items" must be a non-empty array of names.', 'INVALID_FIELD');
    }
    if (body.items.length > 12) {
      throw new HttpError(400, 'Request at most 12 items at a time.', 'TOO_MANY_ITEMS');
    }
    if (!body.items.every((i) => typeof i === 'string' && i.trim() && i.length <= 80)) {
      throw new HttpError(400, 'Each item must be a non-empty string.', 'INVALID_FIELD');
    }
    res.json({ results: await prices.getItemPrices(body.items) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
