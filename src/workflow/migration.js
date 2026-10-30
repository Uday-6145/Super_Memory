/**
 * Super Memory — Repository Migration / Import
 *
 * Explicitly imports workflows from a source repository into a destination
 * repository. Guarantees:
 * - Copy, never move: the source repository is only read.
 * - Every version is schema-validated and hash-checked before import.
 * - Verified versions must carry verification evidence that matches their
 *   canonical content hash.
 * - A verified version is never overwritten. Destination collisions and
 *   validation failures skip the whole workflow with a reported reason.
 * - Repeated imports are safe: identical workflows are reported as skipped.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { WorkflowError } from './errors.js';
import { FileSystemWorkflowRepository } from './repository.js';
import {
  validateWorkflowVersion,
  validateVerificationEvidence,
  verifyEvidenceMatchesWorkflow,
} from './schema.js';
import { calculateContentHash } from './hash.js';

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

/** Canonicalizes a path, resolving symlinks in existing ancestors. */
async function canonicalizePath(target) {
  const resolved = path.resolve(target);
  try {
    return await fs.realpath(resolved);
  } catch {
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    const canonicalParent = await canonicalizePath(parent);
    return path.join(canonicalParent, path.basename(resolved));
  }
}

function isContained(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Symlink policy (strict): symlinks are never imported. Before copying, the
 * workflow tree is scanned with lstat; any symbolic link — file, directory,
 * internal, external, or dangling — rejects that workflow with a clear
 * diagnostic. This guarantees the staged copy contains only real files
 * inside the destination, and staging cleanup can never delete data
 * outside the destination through a planted link.
 *
 * @returns {Promise<string|null>} Relative path of the first symlink, or null
 */
async function findSymlink(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(rootDir, entry.name);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) {
      return entry.name;
    }
    if (stat.isDirectory()) {
      const nested = await findSymlink(full);
      if (nested) return path.join(entry.name, nested);
    }
  }
  return null;
}

async function listVersionNumbers(workflowDir) {
  let entries;
  try {
    entries = await fs.readdir(path.join(workflowDir, 'versions'));
  } catch {
    return [];
  }
  return entries
    .filter((name) => /^\d+\.json$/.test(name))
    .map((name) => Number.parseInt(name, 10))
    .sort((a, b) => a - b);
}

/**
 * Validates one source workflow completely (manifest, every version schema
 * and canonical hash, and evidence for verified versions).
 *
 * @returns {Promise<{ manifest: object, versions: Map<number, { version: object, contentHash: string }> }>}
 */
async function validateSourceWorkflow(sourceDir, workflowId) {
  const workflowDir = path.join(sourceDir, workflowId);
  const manifest = await readJson(path.join(workflowDir, 'manifest.json'));
  if (manifest.id !== workflowId) {
    throw new Error(`Manifest id "${manifest.id}" does not match directory "${workflowId}".`);
  }

  const versionNumbers = await listVersionNumbers(workflowDir);
  if (versionNumbers.length === 0) {
    throw new Error('Workflow contains no version files.');
  }

  const versions = new Map();
  for (const versionNumber of versionNumbers) {
    const version = await readJson(path.join(workflowDir, 'versions', `${versionNumber}.json`));
    validateWorkflowVersion(version);
    if (version.workflowId !== workflowId || version.version !== versionNumber) {
      throw new Error(`Version file ${versionNumber}.json does not match its workflow/version identity.`);
    }
    const contentHash = calculateContentHash(version);

    if (version.status === 'verified') {
      const evidencePath = path.join(workflowDir, 'verifications', `${versionNumber}.evidence.json`);
      let evidence;
      try {
        evidence = await readJson(evidencePath);
      } catch {
        throw new Error(`Verified version ${versionNumber} is missing its verification evidence file.`);
      }
      validateVerificationEvidence(evidence);
      verifyEvidenceMatchesWorkflow(evidence, version, contentHash);
    }

    versions.set(versionNumber, { version, contentHash });
  }

  return { manifest, versions };
}

/**
 * Imports workflows from a source repository into a destination repository.
 *
 * @param {object} params
 * @param {string} params.sourceDir - Source repository root (read-only)
 * @param {string} params.destinationDir - Destination repository root
 * @returns {Promise<{ imported: object[], skipped: object[] }>}
 */
export async function migrateRepository({ sourceDir, destinationDir }) {
  // Containment is checked on canonical paths (symlinks resolved) before
  // any reading or copying begins: neither tree may contain the other.
  const sourceBase = await canonicalizePath(sourceDir);
  const destinationBase = await canonicalizePath(destinationDir);
  if (isContained(sourceBase, destinationBase) || isContained(destinationBase, sourceBase)) {
    throw new WorkflowError(
      'Migration source and destination must be independent directories: neither may contain the other (checked after resolving symlinks). Refusing to start.'
    );
  }

  const sourceRepo = new FileSystemWorkflowRepository({ baseDir: sourceBase });
  const destRepo = new FileSystemWorkflowRepository({ baseDir: destinationBase });
  await destRepo.init();

  const listing = await sourceRepo.list({});
  const listedById = new Map(
    listing.map((entry) => [entry.id || entry.workflowId, entry]).filter(([id]) => Boolean(id))
  );
  // Enumerate the source root directly as well: repository listing silently
  // skips symlinked workflow directories, and those must be reported, not
  // ignored, under the symlink policy.
  const candidateIds = new Set(listedById.keys());
  try {
    for (const entry of await fs.readdir(sourceBase, { withFileTypes: true })) {
      if (!entry.name.startsWith('.')) candidateIds.add(entry.name);
    }
  } catch {}

  const imported = [];
  const skipped = [];

  for (const workflowId of candidateIds) {
    const entry = listedById.get(workflowId);
    if (entry?.corrupt) {
      skipped.push({ workflowId, reason: `Source workflow is corrupt: ${entry.error || 'unreadable manifest'}` });
      continue;
    }

    // Symlink policy is enforced before any file is read or copied, so no
    // link target outside the source repository is ever followed.
    const workflowRoot = path.join(sourceBase, workflowId);
    try {
      const rootStat = await fs.lstat(workflowRoot);
      if (rootStat.isSymbolicLink()) {
        skipped.push({
          workflowId,
          reason: 'Workflow directory is a symbolic link; symlinks are never imported.',
        });
        continue;
      }
      const link = await findSymlink(workflowRoot);
      if (link) {
        skipped.push({
          workflowId,
          reason: `Workflow contains a symbolic link at "${link}"; symlinks are never imported.`,
        });
        continue;
      }
    } catch (err) {
      skipped.push({ workflowId, reason: `Source validation failed: ${err.message}` });
      continue;
    }

    let validated;
    try {
      validated = await validateSourceWorkflow(sourceBase, workflowId);
    } catch (err) {
      skipped.push({ workflowId, reason: `Source validation failed: ${err.message}` });
      continue;
    }

    const destManifest = await destRepo.getManifest(workflowId);
    if (destManifest) {
      // Never overwrite: import only if every source version already exists
      // identically at the destination (a safe repeated import).
      let identical = true;
      let reason = 'Already imported identically.';
      if (
        destManifest.activeVersion !== validated.manifest.activeVersion ||
        destManifest.draftVersion !== validated.manifest.draftVersion ||
        destManifest.enabled !== validated.manifest.enabled
      ) {
        identical = false;
        reason = 'Destination workflow exists with a different manifest (active/draft/enabled state).';
      } else {
        for (const [versionNumber, { contentHash }] of validated.versions) {
          const destVersion = await destRepo.getVersion(workflowId, versionNumber);
          if (!destVersion) {
            identical = false;
            reason = `Destination workflow exists but version ${versionNumber} differs (missing at destination).`;
            break;
          }
          if (calculateContentHash(destVersion) !== contentHash) {
            identical = false;
            reason = `Destination version ${versionNumber} exists with different content. Refusing to overwrite.`;
            break;
          }
        }
      }
      skipped.push({ workflowId, reason });
      continue;
    }

    // Stage the copy inside the destination (dot-prefixed so repository
    // scanners ignore it), verify it, then atomically rename into place.
    const stagingDir = path.join(destinationBase, `.import-${workflowId}-${randomUUID().slice(0, 8)}`);
    try {
      await fs.cp(path.join(sourceBase, workflowId), stagingDir, { recursive: true });
      for (const [versionNumber, { contentHash }] of validated.versions) {
        const copied = await readJson(path.join(stagingDir, 'versions', `${versionNumber}.json`));
        if (calculateContentHash(copied) !== contentHash) {
          throw new Error(`Copied version ${versionNumber} failed hash verification.`);
        }
      }
      await fs.rename(stagingDir, path.join(destinationBase, workflowId));
    } catch (err) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      skipped.push({ workflowId, reason: `Import failed: ${err.message}` });
      continue;
    }

    // Read-back validation through the destination repository itself.
    try {
      const readBackManifest = await destRepo.getManifest(workflowId);
      if (!readBackManifest) throw new Error('Imported workflow is not readable at destination.');
      for (const versionNumber of validated.versions.keys()) {
        const readBack = await destRepo.getVersion(workflowId, versionNumber);
        if (!readBack) throw new Error(`Imported version ${versionNumber} is not readable at destination.`);
      }
    } catch (err) {
      skipped.push({ workflowId, reason: `Post-import validation failed: ${err.message}` });
      continue;
    }

    imported.push({
      workflowId,
      versions: [...validated.versions.keys()],
      contentHashes: Object.fromEntries(
        [...validated.versions.entries()].map(([n, { contentHash }]) => [n, contentHash])
      ),
    });
  }

  return { imported, skipped };
}
