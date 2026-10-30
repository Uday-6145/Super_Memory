/**
 * Super Memory — Managed Home Directory Resolution
 *
 * Single source of truth for the persistent, application-level storage
 * layout:
 *
 *   <home>/
 *   ├── workflows/    (FileSystemWorkflowRepository root)
 *   ├── backups/      (timestamped repository snapshots)
 *   ├── journals/     (discovery scratch journals; diagnostic only)
 *   ├── config.json   (operator configuration; created once, never overwritten)
 *   └── audit.jsonl   (append-only audit trail; no secrets, ever)
 *
 * Resolution order for the home directory:
 * 1. SUPER_MEMORY_HOME environment override.
 * 2. macOS: ~/Library/Application Support/SuperMemory
 * 3. Linux: $XDG_DATA_HOME/super-memory, else ~/.local/share/super-memory
 * 4. Windows: %APPDATA%/SuperMemory (or ~/AppData/Roaming/SuperMemory)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const HOME_ENV_VAR = 'SUPER_MEMORY_HOME';

/**
 * Resolves the Super Memory home directory without creating anything.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.platform]
 * @param {string} [options.homedir]
 * @returns {string} Absolute home directory path
 */
export function resolveSuperMemoryHome({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  const override = env?.[HOME_ENV_VAR];
  if (typeof override === 'string' && override.trim() !== '') {
    return path.resolve(override.trim());
  }

  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', 'SuperMemory');
  }

  if (platform === 'win32') {
    const appData = env?.APPDATA;
    if (typeof appData === 'string' && appData.trim() !== '') {
      return path.join(appData, 'SuperMemory');
    }
    return path.join(homedir, 'AppData', 'Roaming', 'SuperMemory');
  }

  // Linux and other POSIX platforms follow the XDG base directory spec.
  const xdgDataHome = env?.XDG_DATA_HOME;
  if (typeof xdgDataHome === 'string' && xdgDataHome.trim() !== '') {
    return path.join(xdgDataHome, 'super-memory');
  }
  return path.join(homedir, '.local', 'share', 'super-memory');
}

/**
 * Returns the standard paths inside a home directory.
 *
 * @param {string} home
 * @returns {{ home: string, workflows: string, backups: string, journals: string, config: string, audit: string }}
 */
export function getHomePaths(home) {
  const resolved = path.resolve(home);
  return {
    home: resolved,
    workflows: path.join(resolved, 'workflows'),
    backups: path.join(resolved, 'backups'),
    journals: path.join(resolved, 'journals'),
    config: path.join(resolved, 'config.json'),
    audit: path.join(resolved, 'audit.jsonl'),
  };
}

/**
 * Creates the home directory structure safely. Existing files (notably
 * config.json and the workflow repository) are never overwritten.
 *
 * @param {object} [options]
 * @param {string} [options.home] - Explicit home (default: resolved)
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.platform]
 * @param {string} [options.homedir]
 * @returns {Promise<object>} Home paths
 */
export async function ensureSuperMemoryHome({ home, env, platform, homedir } = {}) {
  const paths = getHomePaths(home || resolveSuperMemoryHome({ env, platform, homedir }));

  await fs.mkdir(paths.workflows, { recursive: true });
  await fs.mkdir(paths.backups, { recursive: true });
  await fs.mkdir(paths.journals, { recursive: true });

  try {
    const defaultConfig = `${JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        allowedOrigins: [],
      },
      null,
      2
    )}\n`;
    // 'wx' fails instead of overwriting an existing operator config.
    await fs.writeFile(paths.config, defaultConfig, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  return paths;
}

/**
 * Resolves which workflow repository directory a command should use.
 * An explicit operator choice always wins; the legacy WORKFLOWS_DIR
 * environment variable is honored next; otherwise the managed home
 * repository is the default.
 *
 * @param {object} [options]
 * @param {string} [options.explicit] - Explicit -w/--workflows-dir value
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.platform]
 * @param {string} [options.homedir]
 * @returns {{ workflowsDir: string, source: 'explicit' | 'env' | 'home', home: string }}
 */
export function resolveWorkflowsDir({ explicit, env = process.env, platform, homedir } = {}) {
  const home = resolveSuperMemoryHome({ env, platform, homedir });
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return { workflowsDir: path.resolve(explicit.trim()), source: 'explicit', home };
  }
  const envDir = env?.WORKFLOWS_DIR;
  if (typeof envDir === 'string' && envDir.trim() !== '') {
    return { workflowsDir: path.resolve(envDir.trim()), source: 'env', home };
  }
  return { workflowsDir: getHomePaths(home).workflows, source: 'home', home };
}

/**
 * Detects a legacy ./workflows repository that predates the managed home.
 * Returns guidance information only; nothing is moved or imported implicitly.
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string} [options.home]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.platform]
 * @param {string} [options.homedir]
 * @returns {Promise<null | { legacyDir: string, homeWorkflowsDir: string, message: string }>}
 */
export async function detectLegacyWorkflowsDir({ cwd = process.cwd(), home, env, platform, homedir } = {}) {
  const legacyDir = path.join(cwd, 'workflows');
  const paths = getHomePaths(home || resolveSuperMemoryHome({ env, platform, homedir }));
  if (path.resolve(legacyDir) === paths.workflows) {
    return null;
  }

  const hasEntries = async (dir) => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.some((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    } catch {
      return false;
    }
  };

  if (!(await hasEntries(legacyDir))) {
    return null;
  }
  if (await hasEntries(paths.workflows)) {
    return null;
  }

  return {
    legacyDir,
    homeWorkflowsDir: paths.workflows,
    message:
      `Found an existing workflow repository at "${legacyDir}", but the managed Super Memory home repository at "${paths.workflows}" is empty. ` +
      `The legacy repository was NOT modified or imported automatically. ` +
      `To migrate it explicitly, run: node scripts/super-memory.js migrate --from "${legacyDir}"`,
  };
}
