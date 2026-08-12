'use strict';

const { HttpError } = require('./errors');

const LIMITS = {
  message: 2000,
  sessionId: 100,
  rsn: 12,
};

function requireBody(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new HttpError(400, 'Request body must be a JSON object.', 'INVALID_BODY');
  }
  return req.body;
}

function requireString(body, field, { max, min = 1 } = {}) {
  const value = body[field];
  if (typeof value !== 'string') {
    throw new HttpError(400, `"${field}" is required and must be a string.`, 'INVALID_FIELD');
  }
  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw new HttpError(400, `"${field}" cannot be empty.`, 'INVALID_FIELD');
  }
  if (max && trimmed.length > max) {
    throw new HttpError(
      400,
      `"${field}" must be ${max} characters or fewer.`,
      'FIELD_TOO_LONG'
    );
  }
  return trimmed;
}

function optionalString(body, field, { max } = {}) {
  if (body[field] === undefined || body[field] === null || body[field] === '') return null;
  return requireString(body, field, { max });
}

function optionalEnum(body, field, allowed, fallback = null) {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = String(raw).toLowerCase();
  if (!allowed.includes(value)) {
    throw new HttpError(
      400,
      `"${field}" must be one of: ${allowed.join(', ')}.`,
      'INVALID_FIELD'
    );
  }
  return value;
}

/** Session ids are client-generated; restrict them to a safe charset. */
function requireSessionId(body) {
  const id = requireString(body, 'sessionId', { max: LIMITS.sessionId });
  if (!/^[A-Za-z0-9_-]{6,100}$/.test(id)) {
    throw new HttpError(
      400,
      '"sessionId" must be 6-100 characters of letters, numbers, hyphens or underscores.',
      'INVALID_SESSION_ID'
    );
  }
  return id;
}

module.exports = {
  LIMITS,
  requireBody,
  requireString,
  optionalString,
  optionalEnum,
  requireSessionId,
};
