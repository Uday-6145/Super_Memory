#!/usr/bin/env node
/**
 * Super Memory — Operator CLI Executable
 *
 * Usage:
 *   node scripts/super-memory.js <command> [arguments] [options]
 */

// Automatically load .env if available
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {}
}

import { runCli } from '../src/cli/operator.js';

const exitCode = await runCli(process.argv.slice(2));
process.exit(exitCode);
