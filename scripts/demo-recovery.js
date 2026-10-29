#!/usr/bin/env node
/**
 * Super Memory — End-to-End Recovery Demonstration
 *
 * Demonstrates the full model-assisted recovery lifecycle:
 * Working active v1 -> website changes button -> playback fails ->
 * failure diagnosed with DOM snapshot -> Meta reasoning model proposes repair ->
 * unapproved draft v2 branched -> operator reviews diff ->
 * genuine browser trial produces verification evidence ->
 * operator explicitly confirms promotion -> normal playback of v2 succeeds!
 *
 * Usage:
 *   node --env-file=.env scripts/demo-recovery.js [options]
 *   npm run demo
 *   npm run demo:offline
 *
 * Options:
 *   --live          Force live Meta model execution (requires META_API_KEY or BASETEN_API_KEY)
 *   --offline       Run in offline mode using deterministic mock provider (no credentials needed)
 *   --no-headless   Run Playwright with visible browser window (default: headless)
 *   --help, -h      Display help
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { FileSystemWorkflowRepository } from '../src/workflow/repository.js';
import { OperatorCLI } from '../src/cli/operator.js';
import {
  getPreferredRecoveryProvider,
} from '../src/models/index.js';

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
 * Deterministic offline mock provider.
 */
function createMockMetaProvider() {
  return {
    provider: 'meta',
    modelId: 'muse-spark-1.3-mock',
    async complete() {
      return {
        text: JSON.stringify({
          workflowId: 'wf_demo_recovery',
          targetVersion: 1,
          stepId: 'step_order',
          suspectedCause: 'Button label changed from "Submit Order" to "Complete Order"',
          evidence: 'DOM snapshot shows button with accessible name "Complete Order" and role "button"',
          expectedOutcome: 'Clicking Complete Order will submit form to /complete',
          uncertainty: 'None; button accessible name matches DOM snapshot exactly',
          proposedChange: {
            action: 'clickByRole',
            description: 'Click Complete Order button',
            params: { role: 'button', name: 'Complete Order' },
          },
        }),
        provider: 'meta',
        model: 'muse-spark-1.3',
        finishReason: 'stop',
        isTruncated: false,
        usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
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
Super Memory — Recovery Demonstration Runner

Usage:
  node --env-file=.env scripts/demo-recovery.js [options]
  npm run demo
  npm run demo:offline

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
    modelProvider = createMockMetaProvider();
  } else if (values.live) {
    if (!credentials.hasAny) {
      console.error(`${c.red}Error: --live requested, but neither META_API_KEY nor BASETEN_API_KEY is configured.${c.reset}`);
      console.error('Please configure your credentials in .env or run with --offline for deterministic testing.\n');
      return 1;
    }
    isLive = true;
    modelProvider = getPreferredRecoveryProvider();
  } else {
    // Default mode: use live Meta if credentials present, otherwise fallback gracefully to offline mock
    if (credentials.hasAny) {
      isLive = true;
      try {
        modelProvider = getPreferredRecoveryProvider();
      } catch (err) {
        console.warn(`${c.yellow}Warning: Failed to initialize live provider (${err.message}). Falling back to offline mock.${c.reset}`);
        isLive = false;
        modelProvider = createMockMetaProvider();
      }
    } else {
      isLive = false;
      modelProvider = createMockMetaProvider();
    }
  }

  banner('SUPER MEMORY — END-TO-END INTELLIGENT RECOVERY DEMONSTRATION');

  console.log(`Execution Mode:    ${isLive ? `${c.green}LIVE MODEL INFERENCE${c.reset}` : `${c.yellow}OFFLINE DETERMINISTIC MOCK${c.reset}`}`);
  console.log(`Reasoning Route:   ${isLive ? `Meta (${modelProvider.provider || 'meta'} :: ${modelProvider.modelId})` : 'Offline Mock (muse-spark-1.3-mock)'}`);
  console.log(`Browser Mode:      ${values['no-headless'] ? 'Headed (visible window)' : 'Headless'}`);
  console.log(`Target Scenario:   Local synthetic e-commerce checkout button migration\n`);

  // 1. Setup isolated environment
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-memory-demo-'));
  const inputsFile = path.join(tempDir, 'demo-inputs.json');
  await fs.writeFile(inputsFile, JSON.stringify({ couponCode: 'SUPER2026' }));

  let currentButtonName = 'Submit Order';
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
        if (parsed.pathname === '/checkout') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html>
<html>
<head><title>SuperStore Checkout</title></head>
<body>
  <h1>Checkout</h1>
  <form action="/complete" method="GET">
    <label for="coupon">Coupon Code</label>
    <input id="coupon" type="text" name="coupon" />
    <button type="submit">${currentButtonName}</button>
  </form>
</body>
</html>`);
        } else if (parsed.pathname === '/complete') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html>
<html>
<head><title>Order Complete</title></head>
<body>
  <h1>Order Complete</h1>
  <p>Thank you for your order!</p>
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

    // 3. Initialize workflow with working version v1
    stepHeader(1, 'Create and Verify Baseline Workflow (Active v1)');
    commandEcho(`node scripts/super-memory.js inspect wf_demo_recovery -w ${tempDir}`);

    await repo.createWorkflow({
      id: 'wf_demo_recovery',
      name: 'SuperStore Checkout Recovery Demo',
      description: 'Automates checkout coupon entry and order placement',
      target: {
        origin: baseUrl,
        startPath: '/checkout',
      },
      inputs: [
        {
          name: 'couponCode',
          label: 'Coupon Code',
          type: 'string',
          description: 'Promotional discount coupon code',
          required: true,
        },
      ],
      steps: [
        {
          id: 'step_coupon',
          order: 1,
          action: 'fillByLabel',
          description: 'Enter coupon code into input field',
          params: {
            label: 'Coupon Code',
            inputName: 'couponCode',
          },
        },
        {
          id: 'step_order',
          order: 2,
          action: 'clickByRole',
          description: 'Submit order via Submit Order button',
          params: {
            role: 'button',
            name: 'Submit Order',
          },
        },
      ],
      successCriteria: {
        finalPath: '/complete',
      },
    });

    // Trial and promote draft v1
    await cli.trial('wf_demo_recovery', { inputsPath: inputsFile, allowLocalhost: true });
    await cli.promote('wf_demo_recovery', { confirm: 'PROMOTE wf_demo_recovery', inputsPath: inputsFile });

    const manifestInit = await repo.getManifest('wf_demo_recovery');
    if (manifestInit.activeVersion !== 1 || manifestInit.draftVersion !== null) {
      throw new Error(`Expected activeVersion=1, draftVersion=null, got active=${manifestInit.activeVersion}, draft=${manifestInit.draftVersion}`);
    }
    invariantNotice('Baseline workflow active version is v1 with clean draft state.');

    // Step 2: Normal playback on baseline
    stepHeader(2, 'Ordinary Playback on Working Baseline');
    commandEcho('node scripts/super-memory.js play wf_demo_recovery --inputs demo-inputs.json');

    const playResult1 = await cli.play('wf_demo_recovery', { inputsPath: inputsFile, allowLocalhost: true });
    if (!playResult1.ok) {
      throw new Error(`Baseline playback failed unexpectedly: ${playResult1.error}`);
    }
    invariantNotice('Baseline active version v1 executed successfully.');

    // Step 3: Simulate website change
    stepHeader(3, 'Simulate Website UI Modernization (Breaking Change)');
    console.log(`${c.yellow}Event: Website deployment updates checkout button from "Submit Order" to "Complete Order".${c.reset}`);
    currentButtonName = 'Complete Order';

    // Step 4: Playback fails on outdated selector
    stepHeader(4, 'Ordinary Playback Fails on Outdated Active Version');
    commandEcho('node scripts/super-memory.js play wf_demo_recovery --inputs demo-inputs.json');

    const playResult2 = await cli.play('wf_demo_recovery', { inputsPath: inputsFile, allowLocalhost: true });
    if (playResult2.ok) {
      throw new Error('Expected playback to fail after button name change, but it succeeded.');
    }
    console.log(`${c.yellow}Captured Failure: ${playResult2.error}${c.reset}`);
    invariantNotice('Outdated active version failed safely without crashing or corrupting state.');

    // Step 5: Model-assisted repair flow
    stepHeader(5, 'Trigger Model-Assisted Repair Diagnosis & Draft Creation');
    commandEcho('node scripts/super-memory.js repair wf_demo_recovery --inputs demo-inputs.json');

    const repairResult = await cli.repair('wf_demo_recovery', { inputsPath: inputsFile, allowLocalhost: true });
    if (!repairResult.repaired) {
      throw new Error('Repair failed to produce an unapproved draft version.');
    }

    const manifestRepair = await repo.getManifest('wf_demo_recovery');
    if (manifestRepair.activeVersion !== 1 || manifestRepair.draftVersion !== 2) {
      throw new Error(`Draft isolation failure! Expected active=1, draft=2; got active=${manifestRepair.activeVersion}, draft=${manifestRepair.draftVersion}`);
    }
    invariantNotice('Active version remains locked at v1; candidate fix isolated in unapproved draft v2.');

    // Step 6: Operator reviews proposed diff
    stepHeader(6, 'Operator Reviews Proposed Repair Diff (Read-Only)');
    commandEcho('node scripts/super-memory.js review wf_demo_recovery');

    const reviewResult = await cli.review('wf_demo_recovery', { inputsPath: inputsFile });
    if (!reviewResult || !reviewResult.diff) {
      throw new Error('Review failed to produce a structured diff.');
    }

    // Step 7: Draft isolation invariant check
    stepHeader(7, 'Verify Draft Isolation Invariant (Ordinary Playback Still Runs v1)');
    commandEcho('node scripts/super-memory.js play wf_demo_recovery --inputs demo-inputs.json');

    const playResultMid = await cli.play('wf_demo_recovery', { inputsPath: inputsFile, allowLocalhost: true });
    if (playResultMid.ok || playResultMid.version !== 1) {
      throw new Error('Draft isolation violated! Ordinary playback must never run unapproved draft.');
    }
    invariantNotice('Draft isolation upheld: ordinary playback strictly continues running active v1.');

    // Step 8: Genuine browser trial execution
    stepHeader(8, 'Execute Genuine Draft Trial Verification');
    commandEcho('node scripts/super-memory.js trial wf_demo_recovery --inputs demo-inputs.json');

    const trialResult = await cli.trial('wf_demo_recovery', { inputsPath: inputsFile, allowLocalhost: true });
    if (!trialResult.success || !trialResult.trialResult.candidatePromotionReady) {
      throw new Error('Draft trial execution failed.');
    }

    const manifestAfterTrial = await repo.getManifest('wf_demo_recovery');
    if (manifestAfterTrial.activeVersion !== 1 || manifestAfterTrial.draftVersion !== 2) {
      throw new Error('Trial execution must not auto-promote draft!');
    }
    invariantNotice('Trial succeeded and staged evidence, but did NOT automatically promote draft.');

    // Step 9: Explicit promotion gating
    stepHeader(9, 'Operator Confirms Explicit Promotion');
    commandEcho('node scripts/super-memory.js promote wf_demo_recovery --confirm "PROMOTE wf_demo_recovery"');

    const promoteResult = await cli.promote('wf_demo_recovery', {
      confirm: 'PROMOTE wf_demo_recovery',
      inputsPath: inputsFile,
    });
    if (!promoteResult.promoted || promoteResult.manifest.activeVersion !== 2 || promoteResult.manifest.draftVersion !== null) {
      throw new Error('Promotion failed to transition active version to v2.');
    }
    invariantNotice('Explicit promotion successfully updated active version to v2 and cleared draft.');

    // Step 10: Verified ordinary playback on promoted v2
    stepHeader(10, 'Ordinary Playback Succeeds on Promoted Active Version (v2)');
    commandEcho('node scripts/super-memory.js play wf_demo_recovery --inputs demo-inputs.json');

    const playResultFinal = await cli.play('wf_demo_recovery', { inputsPath: inputsFile, allowLocalhost: true });
    if (!playResultFinal.ok || playResultFinal.version !== 2) {
      throw new Error(`Final playback of promoted v2 failed: ${playResultFinal.error}`);
    }
    invariantNotice('Promoted active version v2 succeeded in full deterministic browser execution.');

    banner('DEMONSTRATION COMPLETE: ALL 10 PHASES & INVARIANTS VERIFIED');

    console.log(`${c.bold}${c.green}Lifecycle Summary:${c.reset}`);
    console.log(`  1. Baseline:        Active v1 succeeded against original UI`);
    console.log(`  2. Failure:         Active v1 failed safely on button rename ("Submit Order" -> "Complete Order")`);
    console.log(`  3. Model Repair:    ${isLive ? 'Meta muse-spark-1.3 reasoning' : 'Deterministic mock'} proposed clickByRole targeting "Complete Order"`);
    console.log(`  4. Isolation:       Active version stayed v1 while candidate draft v2 was staged`);
    console.log(`  5. Review:          Operator inspected read-only unified diff with redacted secrets`);
    console.log(`  6. Verification:    Real browser trial verified draft v2 and bound evidence to content hash`);
    console.log(`  7. Promotion:       Explicit confirmation promoted draft v2 to active`);
    console.log(`  8. Recovery:        Ordinary playback seamlessly succeeded on active v2\n`);

    return 0;
  } finally {
    await cleanup();
  }
}

// Direct invocation
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const exitCode = await runDemonstration(process.argv.slice(2));
  process.exit(exitCode);
}
