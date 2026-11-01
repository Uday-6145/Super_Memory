#!/usr/bin/env node
/**
 * Super Memory — Local Application Server Executable
 *
 * Starts the loopback-only application server (see src/app/server.js).
 *
 * Usage:
 *   node scripts/serve-app.js [--port <n>] [--workflows-dir <path>] [--dev-origin <url>]
 *
 * Environment:
 *   SUPER_MEMORY_HOME  Managed home override.
 *   WORKFLOWS_DIR      Explicit workflow repository override.
 *   PORT               Default port when --port is absent (default: 3939).
 *
 * The one-time pairing code is printed once to this terminal. It is never
 * logged, persisted, or served over HTTP.
 */

import { resolveWorkflowsDir, ensureSuperMemoryHome } from '../src/config/home.js';
import { createAppServer } from '../src/app/server.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--port' || arg === '--workflows-dir' || arg === '--dev-origin') && i + 1 < argv.length) {
      out[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    }
  }
  return out;
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(`Super Memory local application server

Usage:
  node scripts/serve-app.js [--port <n>] [--workflows-dir <path>] [--dev-origin <url>]

Binds 127.0.0.1 only. Prints a one-time pairing code for browser pairing.`);
  process.exit(0);
}

const port = options.port !== undefined
  ? Number.parseInt(options.port, 10)
  : (process.env.PORT !== undefined ? Number.parseInt(process.env.PORT, 10) : 3939);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('Error: --port must be an integer between 0 and 65535.');
  process.exit(1);
}

const resolved = resolveWorkflowsDir({ explicit: options['workflows-dir'] });
await ensureSuperMemoryHome({ home: resolved.home });

let app;
try {
  app = await createAppServer({
    home: resolved.home,
    workflowsDir: resolved.workflowsDir,
    port,
    devOrigin: options['dev-origin'] || null,
  });
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

console.log(`Super Memory app listening on ${app.url}`);
console.log(`Repository: ${resolved.workflowsDir} (source: ${resolved.source})`);
console.log('');
console.log('One-time pairing code (enter it in the browser, then it expires):');
console.log(`  ${app.pairingCodeForDisplay()}`);
console.log('');

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await app.close();
  } catch {}
  process.exit(signal === 'SIGINT' ? 130 : 0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
