import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  buildExpiredSessionCookie,
  buildSessionCookie,
  createAuthState,
  generatePairingCode,
  isAllowedHost,
  isAllowedOrigin,
  normalizePairingCode,
  parseCookies,
} from '../../src/app/auth.js';

describe('App authentication (M3.1)', () => {
  it('generates transcribable codes that normalize identically', () => {
    const code = generatePairingCode();
    // Alphabet: A-Z minus I/L/O (unambiguous transcription) plus digits 2-9.
    assert.match(code, /^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/);
    assert.equal(normalizePairingCode(code.toLowerCase().replaceAll('-', ' ')), normalizePairingCode(code));
  });

  it('pairing succeeds once, then the code is consumed', () => {
    const auth = createAuthState();
    const code = auth.pairingCodeForDisplay();
    assert.ok(code);
    const first = auth.pair('  ' + code.toLowerCase() + ' ');
    assert.equal(first.ok, true);
    assert.ok(first.sessionId);
    assert.equal(auth.pairingCodeForDisplay(), null);
    assert.equal(auth.pair(code).ok, false);
  });

  it('wrong codes fail without consuming the pairing', () => {
    const auth = createAuthState();
    const code = auth.pairingCodeForDisplay();
    assert.equal(auth.pair('AAAA-AAAA-AAAA').ok, false);
    assert.equal(auth.pairingCodeForDisplay(), code);
  });

  it('exhausting attempts rate-limits and consumes the code', () => {
    const auth = createAuthState();
    let last;
    for (let i = 0; i < 10; i += 1) {
      last = auth.pair('AAAA-AAAA-AAAA');
    }
    assert.equal(last.ok, false);
    assert.equal(last.rateLimited, true);
    assert.equal(auth.pairingCodeForDisplay(), null);
  });

  it('expired codes fail closed', () => {
    let t = 1000;
    const auth = createAuthState({ now: () => t });
    const code = auth.pairingCodeForDisplay();
    t += 11 * 60 * 1000;
    assert.equal(auth.pair(code).ok, false);
    assert.equal(auth.pairingCodeForDisplay(), null);
  });

  it('sessions validate until expiry or destruction', () => {
    let t = 1000;
    const auth = createAuthState({ now: () => t });
    const { sessionId } = auth.pair(auth.pairingCodeForDisplay());
    assert.equal(auth.validateSession(sessionId), true);
    assert.equal(auth.validateSession('nope'), false);
    assert.equal(auth.validateSession(''), false);
    assert.equal(auth.validateSession(null), false);
    t += 31 * 24 * 60 * 60 * 1000;
    assert.equal(auth.validateSession(sessionId), false);
  });

  it('logout destroys the session', async () => {
    const auth = createAuthState();
    const { sessionId } = auth.pair(auth.pairingCodeForDisplay());
    assert.equal(auth.destroySession(sessionId), true);
    assert.equal(auth.validateSession(sessionId), false);
  });
});

describe('App auth helpers (M3.1)', () => {
  it('builds safe session cookies and parses them back', () => {
    const setCookie = buildSessionCookie('abc123');
    assert.ok(setCookie.includes('HttpOnly'));
    assert.ok(setCookie.includes('SameSite=Strict'));
    assert.ok(setCookie.includes('Path=/'));
    assert.ok(!setCookie.includes('Domain='));
    assert.ok(!setCookie.toLowerCase().includes('secure'));
    assert.equal(parseCookies(`other=1; ${setCookie.split(';')[0]}`).sm_session, 'abc123');
    const expired = buildExpiredSessionCookie();
    assert.ok(expired.includes('Max-Age=0'));
  });

  it('accepts only exact origins and loopback hosts', () => {
    assert.equal(isAllowedOrigin('http://127.0.0.1:3939', ['http://127.0.0.1:3939']), true);
    assert.equal(isAllowedOrigin('http://127.0.0.1:3939/', ['http://127.0.0.1:3939']), false);
    assert.equal(isAllowedOrigin('https://evil.example', ['http://127.0.0.1:3939']), false);
    assert.equal(isAllowedOrigin('', ['http://127.0.0.1:3939']), false);
    assert.equal(isAllowedHost('127.0.0.1:3939', 3939), true);
    assert.equal(isAllowedHost('localhost:3939', 3939), true);
    assert.equal(isAllowedHost('127.0.0.1:9999', 3939), false);
    assert.equal(isAllowedHost('evil.example:3939', 3939), false);
    assert.equal(isAllowedHost('127.0.0.1', 3939), false);
    assert.equal(isAllowedHost(null, 3939), false);
  });

  it('never exposes the pairing code through status metadata', () => {
    const auth = createAuthState();
    const status = JSON.stringify(auth.pairingStatus());
    assert.ok(!status.includes(auth.pairingCodeForDisplay()));
  });
});
