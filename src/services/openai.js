'use strict';

const OpenAI = require('openai');
const { config } = require('../config');
const tools = require('./tools');

// Safety valve so a misbehaving model cannot loop on tool calls forever.
const MAX_TOOL_ROUNDS = 3;

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
 * Sends a chat completion request, resolving any tool calls the model makes
 * before returning. Called ONLY from the server.
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {Array<{role:string, content:string}>} opts.messages
 * @param {boolean} [opts.enableTools=true]
 */
async function createChatCompletion({ systemPrompt, messages, enableTools = true }) {
  const openai = getClient();

  const convo = [{ role: 'system', content: systemPrompt }, ...messages];
  const toolsUsed = [];
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  function addUsage(u) {
    if (!u) return;
    totalUsage.prompt_tokens += u.prompt_tokens || 0;
    totalUsage.completion_tokens += u.completion_tokens || 0;
    totalUsage.total_tokens += u.total_tokens || 0;
  }

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      // On the final round, drop the tools so the model must produce prose.
      const offerTools = enableTools && round < MAX_TOOL_ROUNDS;

      const completion = await openai.chat.completions.create({
        model: config.openaiModel,
        messages: convo,
        temperature: 0.4,
        max_tokens: 1200,
        ...(offerTools ? { tools: tools.definitions, tool_choice: 'auto' } : {}),
      });

      addUsage(completion.usage);

      const choice = completion.choices?.[0];
      const msg = choice?.message;
      const calls = msg?.tool_calls || [];

      if (calls.length > 0) {
        // Preserve the assistant turn verbatim; the API requires each
        // tool_call_id to be answered by a matching tool message.
        convo.push(msg);

        const results = await Promise.all(
          calls.map(async (call) => {
            const name = call.function?.name;
            const result = await tools.execute(name, call.function?.arguments);
            toolsUsed.push(name);
            return {
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(result),
            };
          })
        );

        convo.push(...results);
        continue; // let the model use the results
      }

      const reply = msg?.content?.trim();
      if (!reply) {
        throw new AiError('The assistant returned an empty response. Please try again.', {
          status: 502,
          code: 'AI_EMPTY',
        });
      }

      return {
        reply,
        model: completion.model,
        usage: totalUsage.total_tokens ? totalUsage : null,
        toolsUsed: [...new Set(toolsUsed)],
      };
    }

    throw new AiError('The assistant could not complete that request. Please try again.', {
      status: 502,
      code: 'AI_TOOL_LOOP',
    });
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
