'use strict';

const OpenAI = require('openai');
const { config } = require('../config');

class AiError extends Error {
  constructor(message, { status = 502, code = 'AI_ERROR' } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

let client = null;

function getClient() {
  if (!config.openaiApiKey) {
    throw new AiError(
      'The assistant is not configured on the server (missing OPENAI_API_KEY). Ask the operator to set it.',
      { status: 503, code: 'AI_NOT_CONFIGURED' }
    );
  }
  if (!client) {
    client = new OpenAI({ apiKey: config.openaiApiKey, timeout: 60000, maxRetries: 1 });
  }
  return client;
}

function isConfigured() {
  return Boolean(config.openaiApiKey);
}

/**
 * Sends a chat completion request. Called ONLY from the server.
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {Array<{role:string, content:string}>} opts.messages
 */
async function createChatCompletion({ systemPrompt, messages }) {
  const openai = getClient();

  try {
    const completion = await openai.chat.completions.create({
      model: config.openaiModel,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      temperature: 0.4,
      max_tokens: 1200,
    });

    const reply = completion.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      throw new AiError('The assistant returned an empty response. Please try again.', {
        status: 502,
        code: 'AI_EMPTY',
      });
    }

    return {
      reply,
      model: completion.model,
      usage: completion.usage || null,
    };
  } catch (err) {
    if (err instanceof AiError) throw err;

    // Map provider errors to safe user-facing messages. Never leak the key,
    // request body, or raw provider payload.
    const status = err.status || err.statusCode;
    console.error('[openai] request failed:', status || '', err.message);

    if (status === 401 || status === 403) {
      throw new AiError('The assistant could not authenticate with its AI provider.', {
        status: 502,
        code: 'AI_AUTH',
      });
    }
    if (status === 429) {
      throw new AiError('The assistant is rate limited right now. Please try again in a moment.', {
        status: 429,
        code: 'AI_RATE_LIMITED',
      });
    }
    if (status === 400) {
      throw new AiError('The assistant rejected that request. Try rephrasing or shortening it.', {
        status: 400,
        code: 'AI_BAD_REQUEST',
      });
    }
    throw new AiError('The assistant is temporarily unavailable. Please try again.', {
      status: 502,
      code: 'AI_UNAVAILABLE',
    });
  }
}

module.exports = { createChatCompletion, isConfigured, AiError };
