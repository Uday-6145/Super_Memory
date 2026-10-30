import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFixtureServer } from '../../scripts/serve-fixture.js';

async function withFixture(run) {
  const server = createFixtureServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function get(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  return {
    status: response.status,
    body: await response.text(),
  };
}

describe('SuperStore fixture cart', () => {
  it('adds the canonical Paneer Toast product and retains its identity in cart state', async () => {
    await withFixture(async (baseUrl) => {
      const submitted = await get(baseUrl, '/cart?search=Paneer%20Toast');

      assert.equal(submitted.status, 200);
      assert.match(submitted.body, /Item added to cart: Paneer Toast/);
      assert.match(submitted.body, /<li class="cart-item"[^>]*>Paneer Toast<\/li>/);
      assert.match(submitted.body, /Proceed to Checkout/);

      const cart = await get(baseUrl, '/cart');
      assert.equal(cart.status, 200);
      assert.match(cart.body, /<li class="cart-item"[^>]*>Paneer Toast<\/li>/);
    });
  });

  it('matches a valid product despite surrounding whitespace and case differences', async () => {
    await withFixture(async (baseUrl) => {
      const submitted = await get(baseUrl, '/cart?search=%20paneer%20%20toast%20');

      assert.equal(submitted.status, 200);
      assert.match(submitted.body, /Item added to cart: Paneer Toast/);
    });
  });

  it('does not report an empty or unknown product as added', async (t) => {
    const cases = [
      ['empty search value', '/cart?search='],
      ['whitespace-only search value', '/cart?search=%20%20'],
      ['unknown product', '/cart?search=Unobtainium%20Sandwich'],
    ];

    for (const [name, path] of cases) {
      await t.test(name, async () => {
        await withFixture(async (baseUrl) => {
          const response = await get(baseUrl, path);

          assert.equal(response.status, 400);
          assert.match(response.body, /Your Cart/);
          assert.doesNotMatch(response.body, /Item added to cart/);
          assert.doesNotMatch(response.body, /Paneer Toast/);
          assert.doesNotMatch(response.body, /Unobtainium Sandwich/);
          assert.doesNotMatch(response.body, /Proceed to Checkout/);

          const cart = await get(baseUrl, '/cart');
          assert.equal(cart.status, 200);
          assert.doesNotMatch(cart.body, /Paneer Toast/);
          assert.doesNotMatch(cart.body, /Item added to cart/);
        });
      });
    }
  });

  it('generic cart text alone does not prove that Paneer Toast was added', async () => {
    await withFixture(async (baseUrl) => {
      const cart = await get(baseUrl, '/cart');

      assert.equal(cart.status, 200);
      assert.match(cart.body, /Your Cart/);
      assert.match(cart.body, /Your cart is empty/);
      assert.doesNotMatch(cart.body, /Paneer Toast/);
      assert.doesNotMatch(cart.body, /Item added to cart/);
      assert.doesNotMatch(cart.body, /Proceed to Checkout/);
    });
  });

  it('does not reflect unexpected markup input in the response', async () => {
    await withFixture(async (baseUrl) => {
      const payload = '<script>alert("xss")</script>';
      const response = await get(baseUrl, `/cart?search=${encodeURIComponent(payload)}`);

      assert.equal(response.status, 400);
      assert.doesNotMatch(response.body, /<script>alert/);
      assert.doesNotMatch(response.body, /xss/);
    });
  });

  it('keeps the store form compatible with the existing fill-and-click workflow', async () => {
    await withFixture(async (baseUrl) => {
      const store = await get(baseUrl, '/store');

      assert.equal(store.status, 200);
      assert.match(store.body, /<label for="search">Search Product<\/label>/);
      assert.match(store.body, /<input id="search" type="text" name="search" \/>/);
      assert.match(store.body, /<button type="submit">Add to Cart<\/button>/);
    });
  });
});
