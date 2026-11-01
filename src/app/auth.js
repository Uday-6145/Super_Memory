/**
 * Super Memory — Local Application Authentication
 *
 * Pairing + session authentication for the loopback-only application server.
 *
 * Flow:
 * 1. On startup the server generates a cryptographically random, single-use
 *    pairing code with a short expiry. The entrypoint prints it once to the
 *    terminal. It is never persisted, never logged, and never served.
 * 2. The user enters the code in the browser UI. `POST /api/auth/pair`
 *    consumes the code and sets a session cookie.
 * 3. All subsequent API calls authenticate with the HttpOnly, host-only,
 *    SameSite=Strict session cookie. Sessions live in server memory only,
 *    so every session becomes invalid when the server restarts.
 *
 * Transport notes (documented honestly, not equivalent to HTTPS):
 * - The server binds 127.0.0.1 over plain HTTP. Loopback traffic never
 *   leaves the host, but it is not encrypted.
 * - The `Secure` cookie attribute is intentionally NOT set: several
 *   browsers reject Secure cookies over `http://127.0.0.1` (as opposed to
 *   `https://` or `http://localhost`), which would silently break
 *   sessions. Host-only + HttpOnly + SameSite=Strict + loopback binding +
 *   Host/Origin validation is the protection model here.
 * - Pairing codes and session identifiers never appear in URLs, browser
 *   storage, frontend source, or logs.
 */

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'sm_session';
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const MAX_PAIRING_ATTEMPTS = 10;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Unambiguous alphabet (no 0/O, 1/I/L) for terminal-to-browser transcription.
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIR_CHARS = 12;

/**
 * Generates a pairing code like `XKQ7-9M2P-4RTD` (12 chars, ~62 bits).
 * Presented grouped for transcription; comparison ignores case and dashes.
 */
export function generatePairingCode({ randomInt = crypto.randomInt } = {}) {
  const chars = [];
  for (let i = 0; i < PAIR_CHARS; i += 1) {
    chars.push(PAIR_ALPHABET[randomInt(0, PAIR_ALPHABET.length)]);
  }
  const flat = chars.join('');
  return `${flat.slice(0, 4)}-${flat.slice(4, 8)}-${flat.slice(8, 12)}`;
}

export function normalizePairingCode(input) {
  return String(input || '').replace(/[\s-]/g, '').toUpperCase();
}

function codesEqual(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * In-memory pairing + session state. One instance per server process.
 */
export function createAuthState({ now = () => Date.now() } = {}) {
  const displayCode = generatePairingCode();
  const state = {
    pairing: {
      code: normalizePairingCode(displayCode),
      display: displayCode,
      expiresAt: now() + PAIRING_TTL_MS,
      attempts: 0,
    },
    sessions: new Map(),
  };

  function pairingValid() {
    return state.pairing.code !== null && now() <= state.pairing.expiresAt;
  }

  return {
    /**
     * Server-side only: the current unconsumed pairing code, so the
     * entrypoint can print it once to the terminal. Never serve it in a
     * response, log it, or persist it.
     */
    pairingCodeForDisplay() {
      return pairingValid() ? state.pairing.display : null;
    },

    /** Current pairing metadata for lifecycle checks (never the code). */
    pairingStatus() {
      return {
        pending: pairingValid(),
        expiresAt: state.pairing.expiresAt,
        attemptsRemaining: Math.max(0, MAX_PAIRING_ATTEMPTS - state.pairing.attempts),
      };
    },

    /**
     * Attempts to consume the pairing code. Single-use: success or
     * exhaustion clears the code. Returns `{ ok, sessionId?, error? }`.
     */
    pair(input) {
      if (!pairingValid()) {
        return { ok: false, error: 'Invalid or expired pairing code.' };
      }
      if (state.pairing.attempts >= MAX_PAIRING_ATTEMPTS) {
        state.pairing.code = null;
        return { ok: false, error: 'Too many pairing attempts. Restart the server to pair again.', rateLimited: true };
      }
      state.pairing.attempts += 1;
      if (!codesEqual(normalizePairingCode(input), state.pairing.code)) {
        if (state.pairing.attempts >= MAX_PAIRING_ATTEMPTS) {
          state.pairing.code = null;
          return { ok: false, error: 'Too many pairing attempts. Restart the server to pair again.', rateLimited: true };
        }
        return { ok: false, error: 'Invalid or expired pairing code.' };
      }
      state.pairing.code = null;
      const sessionId = crypto.randomBytes(32).toString('hex');
      state.sessions.set(sessionId, { createdAt: now(), expiresAt: now() + SESSION_TTL_MS });
      return { ok: true, sessionId };
    },

    validateSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false;
      const record = state.sessions.get(sessionId);
      if (!record) return false;
      if (now() > record.expiresAt) {
        state.sessions.delete(sessionId);
        return false;
      }
      return true;
    },

    destroySession(sessionId) {
      return state.sessions.delete(sessionId);
    },

    sessionCount() {
      return state.sessions.size;
    },
  };
}

/** Builds the Set-Cookie value for a fresh session. */
export function buildSessionCookie(sessionId) {
  const parts = [
    `${SESSION_COOKIE}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  return parts.join('; ');
}

/** Expires the session cookie immediately (logout). */
export function buildExpiredSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (name) out[name] = part.slice(index + 1).trim();
  }
  return out;
}

/**
 * Exact-origin allow-list check for Origin/Referer headers.
 */
export function isAllowedOrigin(origin, allowedOrigins) {
  if (typeof origin !== 'string' || origin === '') return false;
  return allowedOrigins.includes(origin);
}

/**
 * Host-header check against the bound loopback address and port.
 * Accepts only `127.0.0.1:<port>` and `localhost:<port>`.
 */
export function isAllowedHost(hostHeader, port) {
  if (typeof hostHeader !== 'string') return false;
  const host = hostHeader.trim().toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
