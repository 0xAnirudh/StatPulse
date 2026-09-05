import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.LOG_LEVEL];

/**
 * Fields that must never reach a log line, at any level.
 *
 * Redaction is by key name rather than at the call site, because the
 * whole problem with logging a secret is that nobody does it
 * deliberately - it arrives inside an object someone spread into a log
 * call while debugging something else.
 */
const REDACTED = new Set([
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
]);

function redact(fields) {
  if (!fields) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = REDACTED.has(key) ? '[redacted]' : value;
  }
  return out;
}

/**
 * Structured-enough logging without a dependency.
 *
 * Deliberately not pino or winston. Nothing here asks for log shipping,
 * sampling or transports, and a logger is the easiest dependency in the
 * world to add later if one of those becomes real.
 */
function emit(level, message, fields) {
  if (LEVELS[level] < threshold) return;
  const line = { t: new Date().toISOString(), level, msg: message, ...redact(fields) };
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(JSON.stringify(line));
}

export const log = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};
