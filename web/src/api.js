/**
 * Minimal API client for the Super Memory local application server.
 * Same-origin requests only; the session cookie is HttpOnly and handled
 * by the browser. No credentials are stored in browser storage.
 */

async function readJson(res) {
  const text = await res.text();
  try {
    return { status: res.status, data: text ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, data: null, raw: text };
  }
}

export async function apiGet(pathname) {
  const res = await fetch(pathname, { headers: { Accept: 'application/json' } });
  return readJson(res);
}

export async function apiPost(pathname, body) {
  const res = await fetch(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return readJson(res);
}
