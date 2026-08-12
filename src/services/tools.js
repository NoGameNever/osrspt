'use strict';

/**
 * Tools the assistant may call during a chat turn.
 *
 * This is how we keep the "never fabricate prices" rule honest: the model has
 * no reliable price knowledge of its own, so instead of asking it to guess we
 * give it a function that returns live OSRS Wiki data, and instruct it to call
 * that function whenever GP values matter.
 *
 * Every handler is server-side and takes only model-supplied arguments, so
 * each one re-validates its input.
 */

const prices = require('./prices');

const MAX_ITEMS_PER_CALL = 8;

const definitions = [
  {
    type: 'function',
    function: {
      name: 'get_item_prices',
      description:
        'Get current Grand Exchange prices for one or more Old School RuneScape items from the ' +
        'OSRS Wiki real-time price API. Use this whenever the answer involves a GP price, an ' +
        'item cost, a gear-setup total, a flipping margin, or high alch value. Never state a ' +
        'price without calling this first. Accepts common shorthand such as "tbow" or "bcp".',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: `Item names to price. Up to ${MAX_ITEMS_PER_CALL} per call. Batch related items into one call.`,
            items: { type: 'string' },
            minItems: 1,
            maxItems: MAX_ITEMS_PER_CALL,
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_items',
      description:
        'Search Grand Exchange item names when a name is ambiguous or you are unsure of the ' +
        'exact spelling. Returns candidate item names. Use this before get_item_prices if a ' +
        'lookup came back as a poor or unexpected match.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Partial or approximate item name.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
];

const handlers = {
  async get_item_prices(args) {
    const list = Array.isArray(args && args.items) ? args.items : [];
    const clean = list
      .filter((i) => typeof i === 'string' && i.trim())
      .map((i) => i.trim().slice(0, 80))
      .slice(0, MAX_ITEMS_PER_CALL);

    if (clean.length === 0) {
      return { error: 'No valid item names were provided.' };
    }

    const results = await prices.getItemPrices(clean);
    return {
      // Compact text keeps the tool result small; the model does not need the
      // full JSON payload to answer a price question.
      prices: results.map((r) => prices.formatForPrompt(r)),
      currency: 'gp',
      taxNote:
        'Grand Exchange tax is 2% of the sale price, rounded down, capped at 5,000,000 gp per item, ' +
        'and is not charged below 50 gp. Some items are exempt.',
      source: 'OSRS Wiki real-time prices (prices.runescape.wiki)',
      retrievedAt: new Date().toISOString(),
    };
  },

  async search_items(args) {
    const q = args && typeof args.query === 'string' ? args.query.trim().slice(0, 80) : '';
    if (!q) return { error: 'No search query was provided.' };
    return { query: q, matches: await prices.searchItems(q, 10) };
  },
};

/**
 * Executes a tool call by name. Never throws — the model must receive a
 * result it can reason about, and an upstream outage should degrade the
 * answer rather than fail the whole chat turn.
 */
async function execute(name, rawArgs) {
  const handler = handlers[name];
  if (!handler) return { error: `Unknown tool "${name}".` };

  let args = {};
  if (rawArgs) {
    try {
      args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
    } catch (_) {
      return { error: 'Tool arguments were not valid JSON.' };
    }
  }

  try {
    return await handler(args);
  } catch (err) {
    console.error(`[tools] ${name} failed:`, err.message);
    return {
      error: err.message,
      guidance:
        'Live price data is unavailable right now. Tell the user you could not retrieve current ' +
        'prices and do not estimate them from memory.',
    };
  }
}

module.exports = { definitions, execute, MAX_ITEMS_PER_CALL };
