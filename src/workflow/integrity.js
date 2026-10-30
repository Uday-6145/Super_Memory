/**
 * Super Memory — Read-Only Repository Integrity Scan
 *
 * Inspects a workflow repository without modifying it and reports:
 * - Unparseable or schema-invalid manifests and versions.
 * - Verification evidence that is missing, invalid, or whose content hash
 *   does not match the canonical hash of its version.
 * - Manifest active/draft pointers referencing missing version files.
 * - Verified versions with no matching evidence.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  validateManifest,
  validateWorkflowVersion,
  validateVerificationEvidence,
  verifyEvidenceMatchesWorkflow,
} from './schema.js';
import { calculateContentHash } from './hash.js';

async function readJsonSafe(filePath) {
  try {
    return { value: JSON.parse(await fs.readFile(filePath, 'utf8')) };
  } catch (err) {
    return { error: err };
  }
}

/**
 * Scans a repository directory read-only.
 *
 * @param {string} baseDir
 * @returns {Promise<{ baseDir: string, ok: boolean, workflows: object[], totals: object }>}
 */
export async function scanRepositoryIntegrity(baseDir) {
  const resolvedBase = path.resolve(baseDir);
  const report = {
    baseDir: resolvedBase,
    ok: true,
    workflows: [],
    totals: { workflows: 0, versions: 0, issues: 0 },
  };

  let entries;
  try {
    entries = await fs.readdir(resolvedBase, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return report;
    }
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const workflowId = entry.name;
    const workflowDir = path.join(resolvedBase, workflowId);
    const issues = [];
    const issue = (code, message) => issues.push({ code, message });

    // Manifest
    let manifest = null;
    const manifestResult = await readJsonSafe(path.join(workflowDir, 'manifest.json'));
    if (manifestResult.error) {
      issue('MANIFEST_UNREADABLE', `manifest.json is missing or invalid JSON: ${manifestResult.error.message}`);
    } else {
      manifest = manifestResult.value;
      try {
        validateManifest(manifest);
      } catch (err) {
        issue('MANIFEST_INVALID', err.message);
      }
    }

    // Versions
    let versionFiles = [];
    try {
      versionFiles = (await fs.readdir(path.join(workflowDir, 'versions'))).filter((n) => /^\d+\.json$/.test(n));
    } catch {
      issue('VERSIONS_MISSING', 'versions/ directory is missing.');
    }

    const presentVersions = new Set();
    for (const fileName of versionFiles) {
      const versionNumber = Number.parseInt(fileName, 10);
      presentVersions.add(versionNumber);
      report.totals.versions += 1;
      const result = await readJsonSafe(path.join(workflowDir, 'versions', fileName));
      if (result.error) {
        issue('VERSION_UNREADABLE', `versions/${fileName} is invalid JSON: ${result.error.message}`);
        continue;
      }
      const version = result.value;
      try {
        validateWorkflowVersion(version);
      } catch (err) {
        issue('VERSION_INVALID', `versions/${fileName}: ${err.message}`);
        continue;
      }
      if (version.workflowId !== workflowId || version.version !== versionNumber) {
        issue('VERSION_IDENTITY', `versions/${fileName} does not match its workflow/version identity.`);
        continue;
      }

      const contentHash = calculateContentHash(version);
      if (version.status === 'verified') {
        const evidenceResult = await readJsonSafe(
          path.join(workflowDir, 'verifications', `${versionNumber}.evidence.json`)
        );
        if (evidenceResult.error) {
          issue('EVIDENCE_MISSING', `Verified version ${versionNumber} has no readable verification evidence.`);
        } else {
          try {
            validateVerificationEvidence(evidenceResult.value);
            verifyEvidenceMatchesWorkflow(evidenceResult.value, version, contentHash);
          } catch (err) {
            issue('EVIDENCE_MISMATCH', `Version ${versionNumber} evidence does not match: ${err.message}`);
          }
        }
      }
    }

    // Manifest pointers
    if (manifest) {
      if (manifest.activeVersion !== null && manifest.activeVersion !== undefined && !presentVersions.has(manifest.activeVersion)) {
        issue('POINTER_MISSING', `Manifest activeVersion ${manifest.activeVersion} has no version file.`);
      }
      if (manifest.draftVersion !== null && manifest.draftVersion !== undefined && !presentVersions.has(manifest.draftVersion)) {
        issue('POINTER_MISSING', `Manifest draftVersion ${manifest.draftVersion} has no version file.`);
      }
    }

    report.totals.workflows += 1;
    report.totals.issues += issues.length;
    if (issues.length > 0) report.ok = false;
    report.workflows.push({ id: workflowId, ok: issues.length === 0, issues });
  }

  return report;
}
