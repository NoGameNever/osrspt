'use strict';

const { config } = require('../config');

class HttpError extends Error {
  constructor(status, message, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function notFound(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
}

/**
 * Centralized error handler.
 * Only messages explicitly marked `expose` are shown to the client.
 * Stack traces, credentials and connection strings are never returned.
 */
function errorHandler(err, req, res, _next) {
  const status = Number(err.status) >= 400 && Number(err.status) < 600 ? Number(err.status) : 500;

  // Body parser payload-too-large / malformed JSON.
  if (err.type === 'entity.too.large') {
    return res
      .status(413)
      .json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } });
  }
  if (err.type === 'entity.parse.failed') {
    return res
      .status(400)
      .json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' } });
  }

  const safeMessage =
    err.expose && err.message ? err.message : 'Something went wrong on the server.';

  if (status >= 500) {
    console.error('[error]', err.code || '', err.message);
    // Stack traces are logged only for genuinely unexpected failures,
    // and only ever to the server console — never to the client.
    if (!config.isProduction && !err.expose && err.stack) console.error(err.stack);
  }

  res.status(status).json({
    error: {
      code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
      message: safeMessage,
    },
  });
}

module.exports = { HttpError, notFound, errorHandler };
