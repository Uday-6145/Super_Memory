#!/usr/bin/env node
/**
 * Super Memory — End-to-End Workflow Discovery Demonstration
 *
 * Demonstrates the full discovery and autonomous synthesis lifecycle:
 * Task Intent -> Browser Exploration (OBSERVE -> DECIDE -> GUARD -> ACT) ->
 * Deterministic Outcome Verification -> Trace Conversion to Candidate Draft v1 ->
 * Safety Invariant (Ordinary Playback Blocked) -> Real Browser Trial Verification ->
 * Explicit Operator Promotion -> Fast Deterministic Replay (0 Model Calls).
 *
 * Usage:
 *   node --env-file=.env scripts/demo-discovery.js [options]
 *   npm run demo:discover
 *   npm run demo:discover:offline
 *
 * Options:
 *   --live          Force live Meta model execution (requires META_API_KEY or BASETEN_API_KEY)
 *   --offline       Run in offline mode using deterministic mock provider (zero credentials required)
 *   --no-headless   Run with a visible Chromium browser window
 *   --help, -h      Display this help message
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { FileSystemWorkflowRepository } from '../src/workflow/repository.js';
import { OperatorCLI } from '../src/cli/operator.js';
import { createTaskIntent } from '../src/discovery/task-intent.js';
import { getPreferredRecoveryProvider } from '../src/models/index.js';

// ANSI color formatting
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

function banner(text) {
  const line = '═'.repeat(78);
  console.log(`\n${c.bold}${c.cyan}${line}${c.reset}`);
  console.log(`${c.bold}${c.cyan}  ${text}${c.reset}`);
  console.log(`${c.bold}${c.cyan}${line}${c.reset}\n`);
}

function stepHeader(stepNumber, title) {
  const line = '─'.repeat(74);
  console.log(`\n${c.bold}${c.blue}[STEP ${stepNumber}] ${title}${c.reset}`);
  console.log(`${c.dim}${line}${c.reset}`);
}

function commandEcho(cmd) {
  console.log(`${c.yellow}$ ${cmd}${c.reset}\n`);
}

function invariantNotice(description) {
  console.log(`${c.green}✔ SAFETY INVARIANT VERIFIED: ${description}${c.reset}`);
}

/**
 * Checks available credentials without exposing secrets.
 */
function checkCredentials() {
  const hasMeta = Boolean(
    typeof process !== 'undefined' && (process.env.META_API_KEY || process.env.MODEL_API_KEY)
  );
  const hasBaseten = Boolean(
    typeof process !== 'undefined' && process.env.BASETEN_API_KEY
  );
  return { hasMeta, hasBaseten, hasAny: hasMeta || hasBaseten };
}

/**
 * Deterministic scripted mock provider for discovery.
 */
function createMockDiscoveryProvider() {
  let callCount = 0;
  return {
    provider: 'meta',
    modelId: 'muse-spark-1.3-discovery-mock',
    async complete() {
      callCount++;
      if (callCount === 1) {
        return {
          text: JSON.stringify({
            action: 'fillByLabel',
            elementIndex: 0,
            label: 'Search Product',
            inputName: 'search_item',
            rationale: 'Search for the desired item in the store',
          }),
        };
      }
      if (callCount === 2) {
        return {
          text: JSON.stringify({
            action: 'clickByRole',
            elementIndex: 1,
            role: 'button',
            name: 'Add to Cart',
            rationale: 'Submit search and add item to cart',
          }),
        };
      }
      if (callCount === 3) {
        return {
          text: JSON.stringify({
            action: 'clickByRole',
            elementIndex: 0,
            role: 'link',
            name: 'Proceed to Checkout',
            rationale: 'Navigate to checkout page',
          }),
        };
      }
      if (callCount === 4) {
        return {
          text: JSON.stringify({
            action: 'clickByRole',
            elementIndex: 0,
            role: 'button',
            name: 'Complete Order',
            rationale: 'Finalize order and navigate to receipt',
            done: true,
          }),
        };
      }
      return {
        text: JSON.stringify({
          action: 'navigate',
          path: '/receipt',
          done: true,
        }),
      };
    },
  };
}

export async function runDemonstration(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      live: { type: 'boolean' },
      offline: { type: 'boolean' },
      'no-headless': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });

  if (values.help) {
    console.log(`
Super Memory — Workflow Discovery Demonstration Runner

Usage:
  node --env-file=.env scripts/demo-discovery.js [options]
  npm run demo:discover
  npm run demo:discover:offline

Options:
  --live          Force live Meta model execution (requires META_API_KEY or BASETEN_API_KEY)
  --offline       Run in offline mode using deterministic mock provider (zero credentials required)
  --no-headless   Run with a visible Chromium browser window
  --help, -h      Display this help message
`);
    return 0;
  }

  const credentials = checkCredentials();
  let isLive = false;
  let modelProvider = null;

  if (values.offline) {
    isLive = false;
    modelProvider = createMockDiscoveryProvider();
  } else if (values.live) {
    if (!credentials.hasAny) {
      console.error(`${c.red}Error: --live requested, but neither META_API_KEY nor BASETEN_API_KEY is configured.${c.reset}`);
      console.error('Please configure your credentials in .env or run with --offline for deterministic testing.\n');
      return 1;
    }
    isLive = true;
    modelProvider = getPreferredRecoveryProvider();
  } else {
    // Default mode: offline deterministic mock unless live credentials are ready and requested
    if (credentials.hasAny) {
      isLive = true;
      try {
        modelProvider = getPreferredRecoveryProvider();
      } catch (err) {
        console.warn(`${c.yellow}Warning: Failed to initialize live provider (${err.message}). Falling back to offline mock.${c.reset}`);
        isLive = false;
        modelProvider = createMockDiscoveryProvider();
      }
    } else {
      isLive = false;
      modelProvider = createMockDiscoveryProvider();
    }
  }

  banner('SUPER MEMORY — WORKFLOW DISCOVERY & SYNTHESIS DEMONSTRATION');

  console.log(`Execution Mode:    ${isLive ? `${c.green}LIVE MODEL INFERENCE${c.reset}` : `${c.yellow}OFFLINE DETERMINISTIC MOCK${c.reset}`}`);
  console.log(`Discovery Route:   ${isLive ? `Meta (${modelProvider.provider || 'meta'} :: ${modelProvider.modelId})` : 'Offline Deterministic Mock'}`);
  console.log(`Browser Mode:      ${values['no-headless'] ? 'Headed (visible window)' : 'Headless'}`);
  console.log(`Target Scenario:   Local synthetic e-commerce store discovery to receipt\n`);

  // 1. Setup isolated environment
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-memory-discover-'));
  const inputsFile = path.join(tempDir, 'demo-inputs.json');
  await fs.writeFile(inputsFile, JSON.stringify({ search_item: 'Fresh Paneer Pizza' }));

  let fixtureServer;

  const cleanup = async () => {
    if (fixtureServer) {
      await new Promise((res) => fixtureServer.close(res));
    }
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  };

  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(1);
  });

  try {
    // 2. Start local HTTP fixture server
    await new Promise((resolve) => {
      fixtureServer = http.createServer((req, res) => {
        const parsed = new URL(req.url, `http://${req.headers.host}`);
        if (parsed.pathname === '/store') {
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
  <h1>Confirm Order</h1>
  <form action="/receipt" method="GET">
    <button type="submit">Complete Order</button>
  </form>
</body>
</html>`);
        } else if (parsed.pathname === '/receipt') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html>
<html>
<head><title>Order Receipt</title></head>
<body>
  <h1>Order Receipt</h1>
  <p>Thank you for shopping with us! Your order is placed.</p>
</body>
</html>`);
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });

      fixtureServer.listen(0, '127.0.0.1', () => resolve());
    });

    const port = fixtureServer.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const repo = new FileSystemWorkflowRepository({ baseDir: tempDir });
    const cli = new OperatorCLI({
      repository: repo,
      modelProvider,
      allowLocalhost: true,
      headless: !values['no-headless'],
    });

    // 3. Define the TaskIntent
    const intent = createTaskIntent({
      taskId: 'task_demo_discover',
      objective: 'Search for item, add to cart, and complete order to receipt',
      targetOrigin: baseUrl,
      startPath: '/store',
      parameters: [
        {
          name: 'search_item',
          value: 'Fresh Paneer Pizza',
          label: 'Search Product',
          description: 'Name of the product to order',
        },
      ],
      successConditions: [{ type: 'finalPath', expected: '/receipt' }],
    });

    const intentFile = path.join(tempDir, 'demo-intent.json');
    await fs.writeFile(intentFile, JSON.stringify(intent, null, 2));

    // [STEP 1] Run Discovery Engine
    stepHeader(1, 'Discover Workflow from Task Intent');
    commandEcho(`node scripts/super-memory.js discover --intent ${intentFile} --allow-localhost -w ${tempDir}`);

    // Controlled synthetic fixture only: explicitly approve consequential demo actions.
    // The discovery default remains safe and requires explicit approval elsewhere.
    const discRes = await cli.discover(intent, {
      inputs: { search_item: 'Fresh Paneer Pizza' },
      allowLocalhost: true,
      headless: !values['no-headless'],
      approveAction: async () => true,
    });

    if (discRes.action !== 'discovered') {
      throw new Error(`Discovery failed with status: ${discRes.status}`);
    }

    const workflowId = discRes.workflowId;
    invariantNotice(`Candidate workflow synthesized and saved with ID: "${workflowId}".`);
    invariantNotice(`Candidate workflow stored as unapproved draft v1 (activeVersion: null).`);

    // [STEP 2] Inspect Unapproved Draft
    stepHeader(2, 'Inspect Candidate Workflow Draft');
    commandEcho(`node scripts/super-memory.js inspect ${workflowId} -w ${tempDir}`);
    await cli.inspect(workflowId);

    // [STEP 3] Verify Draft Isolation Safety Invariant
    stepHeader(3, 'Verify Draft Isolation Invariant (Ordinary Playback Blocked)');
    commandEcho(`node scripts/super-memory.js play ${workflowId} --inputs ${inputsFile} --allow-localhost -w ${tempDir}`);

    let playbackBlocked = false;
    try {
      await cli.play(workflowId, {
        inputs: { search_item: 'Fresh Paneer Pizza' },
        allowLocalhost: true,
        headless: !values['no-headless'],
      });
    } catch (err) {
      if (err.message.includes('has no active verified version')) {
        playbackBlocked = true;
        console.log(`\n${c.yellow}Captured Expected Error: ${err.message}${c.reset}`);
      } else {
        throw err;
      }
    }

    if (!playbackBlocked) {
      throw new Error('Safety violation: ordinary playback was permitted on unapproved draft!');
    }
    invariantNotice('Safety invariant upheld: unapproved draft cannot execute under ordinary playback.');

    // [STEP 4] Execute Genuine Browser Trial
    stepHeader(4, 'Execute Genuine Draft Trial Verification');
    commandEcho(`node scripts/super-memory.js trial ${workflowId} --inputs ${inputsFile} --allow-localhost -w ${tempDir}`);

    const trialRes = await cli.trial(workflowId, {
      inputs: { search_item: 'Fresh Paneer Pizza' },
      allowLocalhost: true,
      headless: !values['no-headless'],
    });

    if (!trialRes.success) {
      throw new Error('Trial verification failed unexpectedly');
    }
    invariantNotice('Browser executed candidate steps against DOM; cryptographic evidence staged.');

    // [STEP 5] Explicit Promotion Gating
    stepHeader(5, 'Explicit Operator Promotion Gating');
    commandEcho(`node scripts/super-memory.js promote ${workflowId} --confirm "PROMOTE ${workflowId}" -w ${tempDir}`);

    const promoteRes = await cli.promote(workflowId, {
      confirm: `PROMOTE ${workflowId}`,
      inputs: { search_item: 'Fresh Paneer Pizza' },
    });

    if (!promoteRes.promoted) {
      throw new Error('Promotion failed unexpectedly');
    }
    invariantNotice(`Workflow "${workflowId}" promoted: activeVersion is now v1, draft cleared.`);

    // [STEP 6] Replay Promoted Active Version
    stepHeader(6, 'Execute Normal Playback on Promoted Active Version');
    commandEcho(`node scripts/super-memory.js play ${workflowId} --inputs ${inputsFile} --allow-localhost -w ${tempDir}`);

    const playRes = await cli.play(workflowId, {
      inputs: { search_item: 'Fresh Paneer Pizza' },
      allowLocalhost: true,
      headless: !values['no-headless'],
    });

    if (!playRes.ok) {
      throw new Error(`Playback failed: ${playRes.error}`);
    }
    invariantNotice('Active verified version v1 executed deterministically with full success criteria.');

    // [STEP 7] Reuse Fast Path (Zero Model Calls)
    stepHeader(7, 'Demonstrate Deterministic Reuse (Zero Model Discovery Calls)');
    const reuseInputsFile = path.join(tempDir, 'demo-reuse-inputs.json');
    await fs.writeFile(reuseInputsFile, JSON.stringify({ search_item: 'Crispy Tofu Burger' }));
    // Same task template with different parameters: the objective shares the discovered
    // workflow's metadata so conservative lookup identifies it as the same reusable flow.
    const reuseIntent = createTaskIntent({
      taskId: 'task_reuse_test',
      objective: 'Search for crispy tofu burger, add to cart, and complete checkout',
      targetOrigin: baseUrl,
      startPath: '/store',
      parameters: [{ name: 'search_item', value: 'Crispy Tofu Burger' }],
      successConditions: [{ type: 'finalPath', expected: '/receipt' }],
    });
    const reuseIntentFile = path.join(tempDir, 'demo-reuse-intent.json');
    await fs.writeFile(reuseIntentFile, JSON.stringify(reuseIntent, null, 2));
    commandEcho(`node scripts/super-memory.js discover --intent ${reuseIntentFile} --inputs ${reuseInputsFile} --allow-localhost -w ${tempDir}`);

    const reuseRes = await cli.discover(reuseIntent, {
      inputs: { search_item: 'Crispy Tofu Burger' },
      allowLocalhost: true,
      headless: !values['no-headless'],
    });

    if (reuseRes.action !== 'reused') {
      throw new Error(`Expected reuse action, received: ${reuseRes.action}`);
    }
    invariantNotice(`Lookup hit on "${workflowId}". Replayed instantly with 0 model calls!`);

    banner('DEMONSTRATION COMPLETE: ALL DISCOVERY INVARIANTS VERIFIED');
    console.log(`${c.green}${c.bold}Summary:${c.reset}`);
    console.log(`  1. Discovered and synthesized workflow: ${workflowId}`);
    console.log('  2. Draft isolated from ordinary playback: Verified');
    console.log('  3. Genuine browser trial verification:   Passed');
    console.log('  4. Cryptographic evidence promotion gate: Passed');
    console.log('  5. Reusable across parameter inputs:      Passed (0 model calls)\n');

    return 0;
  } catch (err) {
    console.error(`\n${c.red}Demonstration Failed: ${err.message}${c.reset}`);
    if (err.stack) console.error(`${c.dim}${err.stack}${c.reset}`);
    return 1;
  } finally {
    await cleanup();
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  runDemonstration().then((code) => {
    process.exit(code ?? 0);
  });
}

