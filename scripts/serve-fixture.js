#!/usr/bin/env node
/**
 * Super Memory — Local Synthetic E-Commerce Fixture Server
 *
 * Runs a lightweight local store on http://127.0.0.1:8080 for testing
 * discovery, repair, and playback workflows manually via the CLI.
 *
 * Usage:
 *   node scripts/serve-fixture.js [--port 8080]
 *   npm run fixture
 */

import http from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';

export function createFixtureServer() {
  return http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host}`);

    if (parsed.pathname === '/' || parsed.pathname === '/store') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head><title>SuperStore Shop</title></head>
<body>
  <h1>SuperStore Catalog</h1>
  <form action="/cart" method="GET">
    <label for="search">Search Product</label>
    <input id="search" type="text" name="search" />
    <button type="submit">Add to Cart</button>
  </form>
</body>
</html>`);
    } else if (parsed.pathname === '/cart') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head><title>Shopping Cart</title></head>
<body>
  <h1>Your Cart</h1>
  <p>Item added to cart.</p>
  <p><a href="/checkout" role="link">Proceed to Checkout</a></p>
</body>
</html>`);
    } else if (parsed.pathname === '/checkout') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head><title>Checkout Page</title></head>
<body>
  <h1>Confirm Order - Checkout</h1>
  <form action="/receipt" method="GET">
    <button type="submit">Complete Order</button>
  </form>
</body>
</html>`);
    } else if (parsed.pathname === '/receipt') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head><title>Order Receipt - Confirmation</title></head>
<body>
  <h1>Order Receipt - Confirmation</h1>
  <p>Thank you for shopping with us! Your order is placed. Order Confirmation complete.</p>
</body>
</html>`);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    }
  });
}

export async function startFixtureServer(port = 8080) {
  const server = createFixtureServer();
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

// If executed directly from command line
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', short: 'p', default: '8080' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });

  if (values.help) {
    console.log(`
Super Memory Local Fixture Server

Usage:
  node scripts/serve-fixture.js [--port 8080]
  npm run fixture
`);
    process.exit(0);
  }

  const PORT = parseInt(values.port, 10) || 8080;
  startFixtureServer(PORT).then(() => {
    console.log(`\nLocal SuperStore fixture server listening on http://127.0.0.1:${PORT}`);
    console.log('Endpoints:');
    console.log(`  - http://127.0.0.1:${PORT}/store     (Store catalog & search)`);
    console.log(`  - http://127.0.0.1:${PORT}/cart      (Shopping cart)`);
    console.log(`  - http://127.0.0.1:${PORT}/checkout  (Order checkout)`);
    console.log(`  - http://127.0.0.1:${PORT}/receipt   (Order confirmation receipt)`);
    console.log('\nPress Ctrl+C to stop.\n');
  });
}
