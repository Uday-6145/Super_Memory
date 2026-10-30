import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createBookstoreServer } from '../../scripts/serve-bookstore.js';
import { createFixtureServer } from '../../scripts/serve-fixture.js';

function startServer(createServer) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function withBookstore(run, variants) {
  const { server, baseUrl } = await startServer(() => createBookstoreServer(variants));
  try {
    await run(baseUrl);
  } finally {
    await stopServer(server);
  }
}

async function get(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  return {
    status: response.status,
    body: await response.text(),
  };
}

describe('Bookstore fixture', () => {
  it('serves a catalog search form compatible with fill-and-click workflows', async () => {
    await withBookstore(async (baseUrl) => {
      const catalog = await get(baseUrl, '/catalog');

      assert.equal(catalog.status, 200);
      assert.match(catalog.body, /<label for="book-title">Book title<\/label>/);
      assert.match(catalog.body, /<input id="book-title" type="text" name="title" \/>/);
      assert.match(catalog.body, /<button type="submit">Find books<\/button>/);
    });
  });

  it('finds a valid book and adds the exact canonical title to the basket', async () => {
    await withBookstore(async (baseUrl) => {
      const results = await get(baseUrl, '/results?title=Practical%20JavaScript%20Handbook');
      assert.equal(results.status, 200);
      assert.match(results.body, /<span class="book-title">Practical JavaScript Handbook<\/span>/);
      assert.match(results.body, /<button type="submit">Add to basket<\/button>/);

      const basket = await get(baseUrl, '/basket?title=Practical%20JavaScript%20Handbook');
      assert.equal(basket.status, 200);
      assert.match(basket.body, /Added to basket: Practical JavaScript Handbook/);
      assert.match(basket.body, /<li class="basket-item"[^>]*>Practical JavaScript Handbook<\/li>/);

      const retained = await get(baseUrl, '/basket');
      assert.equal(retained.status, 200);
      assert.match(retained.body, /<li class="basket-item"[^>]*>Practical JavaScript Handbook<\/li>/);
    });
  });

  it('supports a second catalog book through the same flow', async () => {
    await withBookstore(async (baseUrl) => {
      const results = await get(baseUrl, '/results?title=Distributed%20Systems%20Field%20Guide');
      assert.equal(results.status, 200);
      assert.match(results.body, /Distributed Systems Field Guide/);

      const basket = await get(baseUrl, '/basket?title=Distributed%20Systems%20Field%20Guide');
      assert.equal(basket.status, 200);
      assert.match(basket.body, /<li class="basket-item"[^>]*>Distributed Systems Field Guide<\/li>/);
      assert.doesNotMatch(basket.body, /Practical JavaScript Handbook/);
    });
  });

  it('matches a valid title despite surrounding whitespace and case differences, rendering the canonical title', async () => {
    await withBookstore(async (baseUrl) => {
      const results = await get(baseUrl, '/results?title=%20practical%20%20javascript%20handbook%20');
      assert.equal(results.status, 200);
      assert.match(results.body, /<span class="book-title">Practical JavaScript Handbook<\/span>/);

      const basket = await get(baseUrl, '/basket?title=%20practical%20%20javascript%20handbook%20');
      assert.equal(basket.status, 200);
      assert.match(basket.body, /Added to basket: Practical JavaScript Handbook/);
    });
  });

  it('does not report an empty or unknown title as found or added', async (t) => {
    const cases = [
      ['missing title parameter', '/results'],
      ['empty title value', '/results?title='],
      ['whitespace-only title value', '/results?title=%20%20'],
      ['unknown title', '/results?title=Unobtainium%20Cookbook'],
    ];

    for (const [name, path] of cases) {
      await t.test(name, async () => {
        await withBookstore(async (baseUrl) => {
          const response = await get(baseUrl, path);

          assert.equal(response.status, 400);
          assert.match(response.body, /No matching books found/);
          assert.doesNotMatch(response.body, /Add to basket/);
          assert.doesNotMatch(response.body, /Practical JavaScript Handbook/);
          assert.doesNotMatch(response.body, /Unobtainium Cookbook/);
        });
      });
    }
  });

  it('rejects invalid direct basket submissions and leaves the basket unchanged', async () => {
    await withBookstore(async (baseUrl) => {
      const submitted = await get(baseUrl, '/basket?title=Unobtainium%20Cookbook');

      assert.equal(submitted.status, 400);
      assert.match(submitted.body, /Your Basket/);
      assert.doesNotMatch(submitted.body, /Added to basket/);
      assert.doesNotMatch(submitted.body, /Unobtainium Cookbook/);

      const empty = await get(baseUrl, '/basket?title=');
      assert.equal(empty.status, 400);
      assert.doesNotMatch(empty.body, /Added to basket/);

      const basket = await get(baseUrl, '/basket');
      assert.equal(basket.status, 200);
      assert.match(basket.body, /Your basket is empty/);
    });
  });

  it('generic basket text alone does not prove that a specific book was added', async () => {
    await withBookstore(async (baseUrl) => {
      const basket = await get(baseUrl, '/basket');

      assert.equal(basket.status, 200);
      assert.match(basket.body, /Your Basket/);
      assert.match(basket.body, /Your basket is empty/);
      assert.doesNotMatch(basket.body, /Practical JavaScript Handbook/);
      assert.doesNotMatch(basket.body, /Added to basket/);
    });
  });

  it('does not reflect unexpected markup input in any response', async () => {
    await withBookstore(async (baseUrl) => {
      const payload = '<script>alert("xss")</script>';
      for (const path of [
        `/results?title=${encodeURIComponent(payload)}`,
        `/basket?title=${encodeURIComponent(payload)}`,
      ]) {
        const response = await get(baseUrl, path);
        assert.equal(response.status, 400);
        assert.doesNotMatch(response.body, /<script>alert/);
        assert.doesNotMatch(response.body, /xss/);
      }
    });
  });

  it('drift variant renames only the search button', async () => {
    await withBookstore(async (baseUrl) => {
      const catalog = await get(baseUrl, '/catalog');
      assert.match(catalog.body, /<button type="submit">Search catalog<\/button>/);
      assert.doesNotMatch(catalog.body, /Find books/);
      assert.match(catalog.body, /<label for="book-title">Book title<\/label>/);
    }, { findButtonName: 'Search catalog' });
  });

  it('drift variant renames only the field label', async () => {
    await withBookstore(async (baseUrl) => {
      const catalog = await get(baseUrl, '/catalog');
      assert.match(catalog.body, /<label for="book-title">Title<\/label>/);
      assert.match(catalog.body, /<button type="submit">Find books<\/button>/);
    }, { titleLabel: 'Title' });
  });

  it('drift variant can remove the search button entirely', async () => {
    await withBookstore(async (baseUrl) => {
      const catalog = await get(baseUrl, '/catalog');
      assert.doesNotMatch(catalog.body, /<button type="submit">/);
      assert.match(catalog.body, /<label for="book-title">Book title<\/label>/);
    }, { hideFindButton: true });
  });

  it('drift variant adds an unrelated button without changing the search flow', async () => {
    await withBookstore(async (baseUrl) => {
      const catalog = await get(baseUrl, '/catalog');
      assert.match(catalog.body, /<button type="button">Gift wrap options<\/button>/);
      assert.match(catalog.body, /<button type="submit">Find books<\/button>/);

      const results = await get(baseUrl, '/results?title=Modern%20Web%20Architecture');
      assert.equal(results.status, 200);
      assert.match(results.body, /Add to basket/);
    }, { extraButton: 'Gift wrap options' });
  });

  it('structural drift changes markup but keeps every action target identical', async () => {
    await withBookstore(async (baseUrl) => {
      const catalog = await get(baseUrl, '/catalog');
      assert.match(catalog.body, /<section aria-label="Search">/);
      assert.match(catalog.body, /<label for="book-title">Book title<\/label>/);
      assert.match(catalog.body, /<button type="submit">Find books<\/button>/);

      const basket = await get(baseUrl, '/basket?title=Modern%20Web%20Architecture');
      assert.equal(basket.status, 200);
      assert.match(basket.body, /<li class="basket-item"[^>]*>Modern Web Architecture<\/li>/);
    }, { structuralVariant: true });
  });

  it('basket-summary drift keeps add actions working but hides book titles', async () => {
    await withBookstore(async (baseUrl) => {
      const basket = await get(baseUrl, '/basket?title=Modern%20Web%20Architecture');
      assert.equal(basket.status, 200);
      assert.match(basket.body, /1 item\(s\) in your basket/);
      assert.doesNotMatch(basket.body, /Modern Web Architecture/);
    }, { basketSummaryOnly: true });
  });

  it('operates independently from the shopping fixture server', async () => {
    const bookstore = await startServer(createBookstoreServer);
    const store = await startServer(createFixtureServer);
    try {
      assert.notEqual(bookstore.baseUrl, store.baseUrl);

      const addedBook = await get(bookstore.baseUrl, '/basket?title=Modern%20Web%20Architecture');
      assert.equal(addedBook.status, 200);

      // The bookstore addition must not appear in the shopping cart.
      const cart = await get(store.baseUrl, '/cart');
      assert.equal(cart.status, 200);
      assert.doesNotMatch(cart.body, /Modern Web Architecture/);

      const addedProduct = await get(store.baseUrl, '/cart?search=Paneer%20Toast');
      assert.equal(addedProduct.status, 200);

      // The shopping addition must not appear in the bookstore basket.
      const basket = await get(bookstore.baseUrl, '/basket');
      assert.equal(basket.status, 200);
      assert.match(basket.body, /Modern Web Architecture/);
      assert.doesNotMatch(basket.body, /Paneer Toast/);

      // Structural routes stay fixture-specific.
      assert.equal((await get(bookstore.baseUrl, '/cart')).status, 404);
      assert.equal((await get(store.baseUrl, '/basket')).status, 404);
    } finally {
      await stopServer(bookstore.server);
      await stopServer(store.server);
    }
  });
});
