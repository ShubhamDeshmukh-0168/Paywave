'use strict';

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function baseHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,Idempotency-Key',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Max-Age': '600',
  };
}

function json(statusCode, body) {
  return { statusCode, headers: baseHeaders(), body: JSON.stringify(body) };
}

function empty(statusCode) {
  return { statusCode, headers: baseHeaders(), body: '' };
}

function errorBody(code, message) {
  return { error: { code, message } };
}

function getHeader(event, name) {
  const headers = event.headers || {};
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

function parseBody(event, maxBytes = 16 * 1024) {
  if (event.body === undefined || event.body === null || event.body === '') return {};
  let raw = event.body;
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be a JSON object');
  }
  return parsed;
}

module.exports = { HttpError, json, empty, errorBody, getHeader, parseBody };
