#!/usr/bin/env node
/**
 * Super Memory — Local Bookstore Fixture Server
 *
 * Runs a lightweight local bookstore on http://127.0.0.1:8081 for testing
 * discovery, repair, and playback workflows manually via the CLI.
 *
 * This fixture is intentionally structurally different from the SuperStore
 * shopping fixture (scripts/serve-fixture.js):
 * - Entry point is /catalog (not /store) with a "Book title" search field.
 * - Search navigates to an intermediate /results page; it never adds directly.
 * - Each result carries its own "Add to basket" submission to /basket.
 * - The basket is at /basket (not /cart) and lists canonical catalog titles.
 *
 * Usage:
 *   node scripts/serve-bookstore.js [--port 8081]
 *   npm run fixture:bookstore
 */

import http from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';

const FIXTURE_BOOKS = [
  'Practical JavaScript Handbook',
  'Distributed Systems Field Guide',
  'Modern Web Architecture',
];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Same parameter normalization policy as the shopping fixture: surrounding
// and repeated internal whitespace is collapsed and matching is
// case-insensitive, but the rendered identity is always the canonical
// catalog title.
function normalizeBookQuery(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function findFixtureBook(search) {
  const normalizedSearch = normalizeBookQuery(search);
  if (!normalizedSearch) {
    return null;
  }
  return FIXTURE_BOOKS.find((book) => normalizeBookQuery(book) === normalizedSearch) || null;
}

/**
 * Creates the bookstore fixture server.
 *
 * The variant options exist solely for controlled website-drift experiments:
 * each one changes exactly one aspect of the site while every default keeps
 * the baseline site byte-identical in behavior.
 *
 * @param {object} [options]
 * @param {string} [options.findButtonName='Find books'] - Accessible name of the search submit button
 * @param {string} [options.titleLabel='Book title'] - Label text of the search field
 * @param {boolean} [options.hideFindButton=false] - Omit the search submit button entirely
 * @param {string|null} [options.extraButton=null] - Add an unrelated button with this accessible name to /catalog
 * @param {boolean} [options.structuralVariant=false] - Wrap content in different markup (headings/sections) without changing actions
 * @param {boolean} [options.basketSummaryOnly=false] - Basket shows an item count instead of book titles
 */
export function createBookstoreServer({
  findButtonName = 'Find books',
  titleLabel = 'Book title',
  hideFindButton = false,
  extraButton = null,
  structuralVariant = false,
  basketSummaryOnly = false,
} = {}) {
  // Process-local synthetic basket. It deliberately derives its contents
  // only from titles validated against the fixture catalog below.
  const basketItems = [];

  const renderBasket = (res, { statusCode = 200, notice = '', invalidSubmission = false } = {}) => {
    const itemsHtml = basketItems
      .map((book) => `    <li class="basket-item">${escapeHtml(book)}</li>`)
      .join('\n');
    // Drift variant: the add-to-basket actions still work, but the basket
    // page no longer displays book titles, so title-bound verification fails.
    const basketContents = basketSummaryOnly
      ? `  <p>${basketItems.length} item(s) in your basket.</p>`
      : basketItems.length > 0
        ? `  <ul class="basket-items">\n${itemsHtml}\n  </ul>`
        : '  <p>Your basket is empty.</p>';

    res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html>
<head><title>Book Basket</title></head>
<body>
  <h1>Your Basket</h1>
${notice ? `  <p${invalidSubmission ? ' role="alert"' : ''}>${escapeHtml(notice)}</p>\n` : ''}${basketContents}
</body>
</html>`);
  };

  return http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host}`);

    if (parsed.pathname === '/catalog') {
      const catalogHtml = FIXTURE_BOOKS.map(
        (book) => `    <li class="catalog-entry">${escapeHtml(book)}</li>`
      ).join('\n');
      const findButtonHtml = hideFindButton
        ? ''
        : `\n    <button type="submit">${escapeHtml(findButtonName)}</button>`;
      const extraButtonHtml = extraButton
        ? `\n  <button type="button">${escapeHtml(extraButton)}</button>`
        : '';
      const catalogBody = `  <h1>City Books Catalog</h1>
  <form action="/results" method="GET">
    <label for="book-title">${escapeHtml(titleLabel)}</label>
    <input id="book-title" type="text" name="title" />${findButtonHtml}
  </form>${extraButtonHtml}
  <ul class="catalog-entries">
${catalogHtml}
  </ul>`;
      // Drift variant: identical actions and labels, different page structure.
      const bodyHtml = structuralVariant
        ? `  <header><p>City Books — now with a fresh look!</p></header>
  <main>
  <section aria-label="Search">
${catalogBody}
  </section>
  </main>`
        : catalogBody;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head><title>City Books Catalog</title></head>
<body>
${bodyHtml}
</body>
</html>`);
    } else if (parsed.pathname === '/results') {
      const book = findFixtureBook(parsed.searchParams.get('title'));
      if (!book) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Search Results</title></head>
<body>
  <h1>Search Results</h1>
  <p role="alert">No matching books found. Search the catalog by exact title.</p>
  <p><a href="/catalog" role="link">Back to Catalog</a></p>
</body>
</html>`);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head><title>Search Results</title></head>
<body>
  <h1>Search Results</h1>
  <ul class="book-results">
    <li class="book-result">
      <span class="book-title">${escapeHtml(book)}</span>
      <form action="/basket" method="GET">
        <input type="hidden" name="title" value="${escapeHtml(book)}" />
        <button type="submit">Add to basket</button>
      </form>
    </li>
  </ul>
</body>
</html>`);
    } else if (parsed.pathname === '/basket') {
      if (!parsed.searchParams.has('title')) {
        renderBasket(res);
        return;
      }

      const book = findFixtureBook(parsed.searchParams.get('title'));
      if (!book) {
        renderBasket(res, {
          statusCode: 400,
          notice: 'No book was added. Choose a book from the catalog.',
          invalidSubmission: true,
        });
        return;
      }

      if (!basketItems.includes(book)) {
        basketItems.push(book);
      }
      renderBasket(res, { notice: basketSummaryOnly ? 'Added to basket.' : `Added to basket: ${book}` });
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    }
  });
}

export async function startBookstoreServer(port = 8081, variants = {}) {
  const server = createBookstoreServer(variants);
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

// Drift variants for controlled experiments, selected via environment so the
// baseline command stays identical when no variable is set:
//   BOOKSTORE_FIND_BUTTON="Search catalog"  (rename the search button)
//   BOOKSTORE_TITLE_LABEL="Title"           (rename the field label)
//   BOOKSTORE_HIDE_FIND_BUTTON=1            (remove the search button)
//   BOOKSTORE_EXTRA_BUTTON="Gift wrap"      (add an unrelated button)
//   BOOKSTORE_STRUCTURAL_VARIANT=1          (different markup, same actions)
//   BOOKSTORE_BASKET_SUMMARY_ONLY=1         (basket hides book titles)
export function bookstoreVariantsFromEnv(env = process.env) {
  const variants = {};
  if (env.BOOKSTORE_FIND_BUTTON) variants.findButtonName = env.BOOKSTORE_FIND_BUTTON;
  if (env.BOOKSTORE_TITLE_LABEL) variants.titleLabel = env.BOOKSTORE_TITLE_LABEL;
  if (env.BOOKSTORE_HIDE_FIND_BUTTON === '1') variants.hideFindButton = true;
  if (env.BOOKSTORE_EXTRA_BUTTON) variants.extraButton = env.BOOKSTORE_EXTRA_BUTTON;
  if (env.BOOKSTORE_STRUCTURAL_VARIANT === '1') variants.structuralVariant = true;
  if (env.BOOKSTORE_BASKET_SUMMARY_ONLY === '1') variants.basketSummaryOnly = true;
  return variants;
}

// If executed directly from command line
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', short: 'p', default: '8081' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });

  if (values.help) {
    console.log(`
Super Memory Local Bookstore Fixture Server

Usage:
  node scripts/serve-bookstore.js [--port 8081]
  npm run fixture:bookstore
`);
    process.exit(0);
  }

  const PORT = parseInt(values.port, 10) || 8081;
  const variants = bookstoreVariantsFromEnv();
  const activeVariants = Object.keys(variants);
  startBookstoreServer(PORT, variants).then(() => {
    if (activeVariants.length > 0) {
      console.log(`Drift variants active: ${activeVariants.join(', ')}`);
    }
    console.log(`\nLocal bookstore fixture server listening on http://127.0.0.1:${PORT}`);
    console.log('Endpoints:');
    console.log(`  - http://127.0.0.1:${PORT}/catalog   (Book catalog & title search)`);
    console.log(`  - http://127.0.0.1:${PORT}/results   (Matching catalog entries)`);
    console.log(`  - http://127.0.0.1:${PORT}/basket    (Book basket)`);
    console.log('\nPress Ctrl+C to stop.\n');
  });
}
