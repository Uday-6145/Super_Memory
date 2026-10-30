/**
 * Super Memory — Filesystem Workflow Repository
 *
 * Implements persistent, atomic, and crash-resilient storage for:
 * 1. Workflow Manifests (mutable operational records)
 * 2. Workflow Versions (immutable step definitions)
 * 3. Verification Evidence (tamper-evident execution proofs)
 *
 * Storage Layout:
 *   <baseDir>/
 *     └── <workflowId>/
 *         ├── manifest.json
 *         ├── versions/
 *         │   ├── 1.json
 *         │   └── 2.json
 *         └── verifications/
 *             └── 1.evidence.json
 *
 * Invariants & Guarantees:
 * - Single-process mutation serialization via per-workflow in-memory FIFO lock.
 * - Atomic file replacements using temporary file writes + flush + rename.
 * - Sealed, immutable verified versions: modifying or deleting a verified version is rejected.
 * - Multi-file crash safety: operational promotion is sealed in manifest.json only after
 *   evidence and verified version records are written to disk.
 * - Safe version allocation under lock: scans disk versions and never reuses occupied numbers.
 * - Preserves corrupt records for diagnosis without crashing list() operations.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  WorkflowError,
  WorkflowValidationError,
  ImmutableVersionError,
  VersionConflictError,
  CorruptRecordError,
  WorkflowNotFoundError,
} from './errors.js';

import {
  validateManifest,
  validateWorkflowVersion,
  validateVerificationEvidence,
  verifyEvidenceMatchesWorkflow,
  validateWorkflowId,
} from './schema.js';

import { calculateContentHash } from './hash.js';

// Module-scoped in-process lock registry keyed by `${canonicalBaseDir}:${workflowId}`
const PROCESS_WORKFLOW_LOCKS = new Map();

export class FileSystemWorkflowRepository {
  /**
   * @param {object} options
   * @param {string} options.baseDir - Absolute or relative path to workflow storage root.
   */
  constructor({ baseDir } = {}) {
    if (!baseDir || typeof baseDir !== 'string') {
      throw new WorkflowError('A valid baseDir string is required for FileSystemWorkflowRepository.');
    }
    this.baseDir = path.resolve(baseDir);
  }

  /**
   * Serializes mutations for a specific workflow ID using an in-memory Promise chain
   * shared across all repository instances accessing the same canonical baseDir.
   *
   * @private
   * @template T
   * @param {string} workflowId
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async _withLock(workflowId, fn) {
    validateWorkflowId(workflowId);

    const lockKey = `${this.baseDir}:${workflowId}`;
    const prev = PROCESS_WORKFLOW_LOCKS.get(lockKey) || Promise.resolve();
    let resolveCurrent;
    const current = new Promise((res) => {
      resolveCurrent = res;
    });
    const tail = prev.catch(() => {}).then(() => current);
    PROCESS_WORKFLOW_LOCKS.set(lockKey, tail);

    try {
      await prev.catch(() => {});
      await this._assertSafeWorkflowDir(workflowId);
      return await fn();
    } finally {
      resolveCurrent();
      if (PROCESS_WORKFLOW_LOCKS.get(lockKey) === tail) {
        PROCESS_WORKFLOW_LOCKS.delete(lockKey);
      }
    }
  }

  /**
   * Validates workflow ID and returns its safe absolute directory path.
   *
   * @private
   * @param {string} workflowId
   * @returns {string}
   */
  _getWorkflowDir(workflowId) {
    validateWorkflowId(workflowId);
    const targetDir = path.resolve(this.baseDir, workflowId);
    if (!targetDir.startsWith(this.baseDir + path.sep) && targetDir !== this.baseDir) {
      throw new WorkflowValidationError(`Path traversal detected for workflow ID "${workflowId}".`);
    }
    return targetDir;
  }

  /**
   * Asserts that target workflow directory does not escape baseDir via symlinks.
   * Handles nonexistent workflow directories safely without false alarms.
   *
   * @private
   * @param {string} workflowId
   * @returns {Promise<string>}
   */
  async _assertSafeWorkflowDir(workflowId) {
    const targetDir = this._getWorkflowDir(workflowId);
    try {
      const stat = await fs.lstat(targetDir);
      if (stat.isSymbolicLink()) {
        const realBase = await fs.realpath(this.baseDir).catch(() => this.baseDir);
        const realTarget = await fs.realpath(targetDir);
        if (!realTarget.startsWith(realBase + path.sep) && realTarget !== realBase) {
          throw new WorkflowValidationError(`Symlink escape detected for workflow ID "${workflowId}".`);
        }
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        return targetDir;
      }
      throw err;
    }
    return targetDir;
  }

  _getManifestPath(workflowId) {
    return path.join(this._getWorkflowDir(workflowId), 'manifest.json');
  }

  _getVersionsDir(workflowId) {
    return path.join(this._getWorkflowDir(workflowId), 'versions');
  }

  _getVersionPath(workflowId, versionNumber) {
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      throw new WorkflowValidationError(`Invalid version number "${versionNumber}": must be a positive integer.`);
    }
    return path.join(this._getVersionsDir(workflowId), `${versionNumber}.json`);
  }

  _getVerificationsDir(workflowId) {
    return path.join(this._getWorkflowDir(workflowId), 'verifications');
  }

  _getVerificationPath(workflowId, versionNumber) {
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      throw new WorkflowValidationError(`Invalid version number "${versionNumber}": must be a positive integer.`);
    }
    return path.join(this._getVerificationsDir(workflowId), `${versionNumber}.evidence.json`);
  }

  /**
   * Writes content to a unique temporary file, flushes to disk, and atomically renames.
   *
   * @private
   * @param {string} targetPath
   * @param {string} content
   */
  async _atomicWriteFile(targetPath, content) {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = path.join(
      dir,
      `.tmp_${path.basename(targetPath)}_${Date.now()}_${randomUUID()}`
    );
    try {
      await fs.writeFile(tmpPath, content, { encoding: 'utf8', flush: true });
      await fs.rename(tmpPath, targetPath);
    } catch (err) {
      try {
        await fs.unlink(tmpPath);
      } catch {}
      throw err;
    }
  }

  /**
   * Scans existing version and verification files on disk under versions/ and verifications/
   * to prevent version reuse.
   *
   * @private
   * @param {string} workflowId
   * @returns {Promise<number[]>}
   */
  async _scanOccupiedVersions(workflowId) {
    const versionsDir = this._getVersionsDir(workflowId);
    const verificationsDir = this._getVerificationsDir(workflowId);
    const occupied = new Set();

    try {
      const entries = await fs.readdir(versionsDir);
      for (const entry of entries) {
        if (entry.endsWith('.json') && !entry.startsWith('.')) {
          const num = parseInt(entry.slice(0, -5), 10);
          if (Number.isInteger(num) && num >= 1) {
            occupied.add(num);
          }
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    try {
      const entries = await fs.readdir(verificationsDir);
      for (const entry of entries) {
        if (entry.endsWith('.evidence.json') && !entry.startsWith('.')) {
          const num = parseInt(entry.slice(0, -('.evidence.json'.length)), 10);
          if (Number.isInteger(num) && num >= 1) {
            occupied.add(num);
          }
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    return Array.from(occupied).sort((a, b) => a - b);
  }

  async _scanExistingVersions(workflowId) {
    return this._scanOccupiedVersions(workflowId);
  }

  /**
   * Ensures base directory exists and clears stale temporary files older than 1 hour. Idempotent.
   */
  async init() {
    await fs.mkdir(this.baseDir, { recursive: true });
    await this.cleanStaleTempFiles();
  }

  /**
   * Safely scans for and removes abandoned temporary files left by ungraceful crashes.
   * Only deletes files matching the `.tmp_*` prefix whose last modification time
   * exceeds maxAgeMs (default: 1 hour), ensuring active in-flight writes are never touched.
   *
   * @param {object} [options]
   * @param {number} [options.maxAgeMs=3600000] - Minimum age in ms before a temp file is purged.
   * @returns {Promise<number>} Number of removed stale temp files.
   */
  async cleanStaleTempFiles({ maxAgeMs = 3600000 } = {}) {
    let purgedCount = 0;
    const now = Date.now();

    try {
      await fs.access(this.baseDir);
    } catch (err) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }

    const workflowEntries = await fs.readdir(this.baseDir, { withFileTypes: true });

    for (const wfEntry of workflowEntries) {
      if (!wfEntry.isDirectory() || wfEntry.name.startsWith('.')) continue;

      const wfDir = path.join(this.baseDir, wfEntry.name);
      const subdirs = [wfDir, path.join(wfDir, 'versions'), path.join(wfDir, 'verifications')];

      for (const targetDir of subdirs) {
        let entries;
        try {
          entries = await fs.readdir(targetDir);
        } catch (err) {
          if (err.code === 'ENOENT') continue;
          throw err;
        }

        for (const filename of entries) {
          if (!filename.startsWith('.tmp_')) continue;

          const filePath = path.join(targetDir, filename);
          try {
            const stat = await fs.stat(filePath);
            if (now - stat.mtimeMs > maxAgeMs) {
              await fs.unlink(filePath);
              purgedCount++;
            }
          } catch (err) {
            if (err.code !== 'ENOENT') {
              // Ignore concurrently unlinked temp files
            }
          }
        }
      }
    }

    return purgedCount;
  }

  // =========================================================================
  // Reading Operations
  // =========================================================================

  /**
   * Retrieves the workflow manifest, or null if it does not exist.
   * Throws CorruptRecordError if the file exists but is invalid JSON or violates schema.
   *
   * @param {string} workflowId
   * @returns {Promise<object | null>}
   */
  async getManifest(workflowId) {
    validateWorkflowId(workflowId);
    await this._assertSafeWorkflowDir(workflowId);
    const manifestPath = this._getManifestPath(workflowId);
    let raw;
    try {
      raw = await fs.readFile(manifestPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new WorkflowError(`Failed to read manifest for "${workflowId}": ${err.message}`, { cause: err });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CorruptRecordError(
        `Manifest for "${workflowId}" contains invalid JSON: ${err.message}`,
        { filePath: manifestPath, cause: err }
      );
    }

    try {
      validateManifest(parsed);
    } catch (err) {
      throw new CorruptRecordError(
        `Manifest for "${workflowId}" failed schema validation: ${err.message}`,
        { filePath: manifestPath, cause: err }
      );
    }

    return parsed;
  }

  /**
   * Retrieves a specific version record, or the currently active verified version
   * if versionNumber is omitted/null.
   *
   * Returns null if the version does not exist.
   * Throws CorruptRecordError if the file exists but is invalid JSON or violates schema.
   *
   * @param {string} workflowId
   * @param {number} [versionNumber=null]
   * @returns {Promise<object | null>}
   */
  async getVersion(workflowId, versionNumber = null) {
    validateWorkflowId(workflowId);
    await this._assertSafeWorkflowDir(workflowId);

    if (versionNumber === null) {
      const manifest = await this.getManifest(workflowId);
      if (!manifest || manifest.activeVersion === null) {
        return null;
      }
      versionNumber = manifest.activeVersion;
    }

    const versionPath = this._getVersionPath(workflowId, versionNumber);
    let raw;
    try {
      raw = await fs.readFile(versionPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new WorkflowError(`Failed to read version ${versionNumber} for "${workflowId}": ${err.message}`, {
        cause: err,
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CorruptRecordError(
        `Version ${versionNumber} for "${workflowId}" contains invalid JSON: ${err.message}`,
        { filePath: versionPath, cause: err }
      );
    }

    try {
      validateWorkflowVersion(parsed);
    } catch (err) {
      throw new CorruptRecordError(
        `Version ${versionNumber} for "${workflowId}" failed schema validation: ${err.message}`,
        { filePath: versionPath, cause: err }
      );
    }

    return parsed;
  }

  /**
   * Retrieves the verification evidence for a specific version.
   * Returns null if evidence does not exist.
   *
   * @param {string} workflowId
   * @param {number} versionNumber
   * @returns {Promise<object | null>}
   */
  async getVerificationEvidence(workflowId, versionNumber) {
    validateWorkflowId(workflowId);
    await this._assertSafeWorkflowDir(workflowId);
    const evidencePath = this._getVerificationPath(workflowId, versionNumber);
    let raw;
    try {
      raw = await fs.readFile(evidencePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new WorkflowError(
        `Failed to read verification evidence for "${workflowId}" v${versionNumber}: ${err.message}`,
        { cause: err }
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CorruptRecordError(
        `Verification evidence for "${workflowId}" v${versionNumber} contains invalid JSON: ${err.message}`,
        { filePath: evidencePath, cause: err }
      );
    }

    try {
      validateVerificationEvidence(parsed);
    } catch (err) {
      throw new CorruptRecordError(
        `Verification evidence for "${workflowId}" v${versionNumber} failed schema validation: ${err.message}`,
        { filePath: evidencePath, cause: err }
      );
    }

    return parsed;
  }

  /**
   * Lists workflow manifest summaries with optional filtering.
   * Never throws on corrupted manifests; instead returns diagnostic records for them.
   *
   * @param {object} [options]
   * @param {boolean} [options.enabledOnly=false]
   * @returns {Promise<Array<object>>}
   */
  async list({ enabledOnly = false } = {}) {
    try {
      await fs.access(this.baseDir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    const results = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }

      const workflowId = entry.name;
      const manifestPath = path.join(this.baseDir, workflowId, 'manifest.json');

      try {
        const raw = await fs.readFile(manifestPath, 'utf8');
        const parsed = JSON.parse(raw);
        validateManifest(parsed);

        if (enabledOnly && !parsed.enabled) {
          continue;
        }
        results.push(parsed);
      } catch (err) {
        if (err.code === 'ENOENT') {
          results.push({
            id: workflowId,
            corrupt: true,
            error: 'Manifest file missing',
          });
        } else {
          results.push({
            id: workflowId,
            corrupt: true,
            error: err.message,
          });
        }
      }
    }

    return results;
  }

  // =========================================================================
  // Mutation Operations (All serialized under _withLock)
  // =========================================================================

  /**
   * Creates a new workflow record with an initial draft version (Version 1).
   *
   * Crash-safe order:
   * 1. Writes versions/1.json (draft)
   * 2. Writes manifest.json (activeVersion: null, draftVersion: 1)
   *
   * @param {object} params
   * @param {string} params.id
   * @param {string} params.name
   * @param {string} params.description
   * @param {object} params.target
   * @param {Array<object>} params.inputs
   * @param {Array<object>} params.steps
   * @param {object} params.successCriteria
   * @param {string} [params.schemaVersion] - Workflow version schema (default "1.0.0";
   *   "1.1.0" enables parameter-bound success criteria)
   * @returns {Promise<{ manifest: object, version: object }>}
   */
  async createWorkflow({ id, name, description, target, inputs, steps, successCriteria, schemaVersion = '1.0.0' }) {
    return this._withLock(id, async () => {
      const existingManifest = await this.getManifest(id);
      if (existingManifest) {
        throw new WorkflowError(`Workflow with ID "${id}" already exists.`, {
          code: 'WORKFLOW_ALREADY_EXISTS',
          workflowId: id,
        });
      }

      const diskVersions = await this._scanExistingVersions(id);
      if (diskVersions.length > 0) {
        throw new WorkflowError(
          `Cannot create workflow "${id}": occupied version files exist on disk from an abandoned operation.`,
          { code: 'ORPHANED_FILES_EXIST', workflowId: id }
        );
      }

      const now = new Date().toISOString();

      const versionObj = {
        schemaVersion,
        workflowId: id,
        version: 1,
        status: 'draft',
        parentVersion: null,
        changeSummary: 'Initial recorded workflow draft.',
        target,
        inputs,
        steps,
        successCriteria,
      };
      validateWorkflowVersion(versionObj);

      const manifestObj = {
        schemaVersion: '1.0.0',
        id,
        name,
        description,
        enabled: true,
        activeVersion: null,
        draftVersion: 1,
        timestamps: {
          createdAt: now,
          updatedAt: now,
        },
      };
      validateManifest(manifestObj);

      // 1. Write initial draft version first
      await this._atomicWriteFile(
        this._getVersionPath(id, 1),
        JSON.stringify(versionObj, null, 2)
      );

      // 2. Write manifest referencing the draft
      await this._atomicWriteFile(
        this._getManifestPath(id),
        JSON.stringify(manifestObj, null, 2)
      );

      return { manifest: manifestObj, version: versionObj };
    });
  }

  /**
   * Branches a new draft version from an existing verified workflow.
   *
   * Invariants:
   * - Cannot create a draft if an active draft already exists.
   * - Allocates a version number strictly greater than all disk version files.
   * - Keeps manifest.activeVersion intact so the verified version remains runnable.
   *
   * @param {string} workflowId
   * @param {object} params
   * @param {string} [params.changeSummary]
   * @param {Array<object>} [params.steps]
   * @param {Array<object>} [params.inputs]
   * @param {object} [params.target]
   * @param {object} [params.successCriteria]
   * @returns {Promise<object>} The newly created draft version object.
   */
  async createDraftVersion(workflowId, { changeSummary, steps, inputs, target, successCriteria } = {}) {
    return this._withLock(workflowId, async () => {
      const manifest = await this.getManifest(workflowId);
      if (!manifest) {
        throw new WorkflowNotFoundError(`Workflow "${workflowId}" not found.`, { workflowId });
      }

      if (manifest.draftVersion !== null) {
        throw new VersionConflictError(
          `Workflow "${workflowId}" already has an active draft (version ${manifest.draftVersion}). Verify or delete the existing draft first.`,
          { workflowId, actualVersion: manifest.draftVersion }
        );
      }

      if (manifest.activeVersion === null) {
        throw new WorkflowError(
          `Cannot branch draft for "${workflowId}": workflow has no verified activeVersion to branch from.`,
          { code: 'NO_ACTIVE_VERSION', workflowId }
        );
      }

      const activeVersion = await this.getVersion(workflowId, manifest.activeVersion);
      if (!activeVersion) {
        throw new CorruptRecordError(
          `Active version ${manifest.activeVersion} referenced by manifest "${workflowId}" does not exist on disk.`,
          { filePath: this._getVersionPath(workflowId, manifest.activeVersion) }
        );
      }

      // Safe version allocation under lock: strictly exceeds all disk and manifest versions
      const occupiedVersions = await this._scanOccupiedVersions(workflowId);
      const nextVersion = Math.max(0, manifest.activeVersion ?? 0, manifest.draftVersion ?? 0, ...occupiedVersions) + 1;

      const newVersionObj = {
        // Branching preserves the source schema version so parameter-bound
        // criteria (1.1.0) are not silently downgraded into an invalid draft.
        schemaVersion: activeVersion.schemaVersion ?? '1.0.0',
        workflowId,
        version: nextVersion,
        status: 'draft',
        parentVersion: manifest.activeVersion,
        changeSummary:
          typeof changeSummary === 'string' && changeSummary.trim() !== ''
            ? changeSummary
            : `Draft branched from verified version ${manifest.activeVersion}.`,
        target: target || activeVersion.target,
        inputs: inputs || activeVersion.inputs,
        steps: steps || activeVersion.steps,
        successCriteria: successCriteria || activeVersion.successCriteria,
      };
      validateWorkflowVersion(newVersionObj);

      // 1. Write new draft version file
      await this._atomicWriteFile(
        this._getVersionPath(workflowId, nextVersion),
        JSON.stringify(newVersionObj, null, 2)
      );

      // 2. Update manifest draft pointer (activeVersion remains unchanged!)
      manifest.draftVersion = nextVersion;
      manifest.timestamps.updatedAt = new Date().toISOString();
      validateManifest(manifest);

      await this._atomicWriteFile(
        this._getManifestPath(workflowId),
        JSON.stringify(manifest, null, 2)
      );

      return newVersionObj;
    });
  }

  /**
   * Updates an existing unverified draft version record.
   *
   * Invariants:
   * - Throws ImmutableVersionError if target version is verified.
   * - Must target manifest.draftVersion.
   *
   * @param {string} workflowId
   * @param {number} versionNumber
   * @param {object} updates
   * @returns {Promise<object>} The updated draft version record.
   */
  async updateDraftVersion(workflowId, versionNumber, updates) {
    return this._withLock(workflowId, async () => {
      const manifest = await this.getManifest(workflowId);
      if (!manifest) {
        throw new WorkflowNotFoundError(`Workflow "${workflowId}" not found.`, { workflowId });
      }

      const currentVersion = await this.getVersion(workflowId, versionNumber);
      if (!currentVersion) {
        throw new WorkflowNotFoundError(`Version ${versionNumber} of workflow "${workflowId}" not found.`, {
          workflowId,
          version: versionNumber,
        });
      }

      if (currentVersion.status === 'verified') {
        throw new ImmutableVersionError(
          `Cannot update verified version ${versionNumber} of workflow "${workflowId}". Verified versions are immutable.`,
          { workflowId, version: versionNumber }
        );
      }

      if (manifest.draftVersion !== versionNumber) {
        throw new VersionConflictError(
          `Version ${versionNumber} is not the current active draft (active draft: ${manifest.draftVersion}).`,
          { workflowId, expectedVersion: manifest.draftVersion, actualVersion: versionNumber }
        );
      }

      const updatedVersion = {
        ...currentVersion,
        ...updates,
        // Updates never change the schema version; a 1.1.0 draft stays 1.1.0.
        schemaVersion: currentVersion.schemaVersion ?? '1.0.0',
        workflowId,
        version: versionNumber,
        status: 'draft',
        parentVersion: currentVersion.parentVersion,
      };
      validateWorkflowVersion(updatedVersion);

      // 1. Write updated draft
      await this._atomicWriteFile(
        this._getVersionPath(workflowId, versionNumber),
        JSON.stringify(updatedVersion, null, 2)
      );

      // 2. Touch manifest updatedAt
      manifest.timestamps.updatedAt = new Date().toISOString();
      validateManifest(manifest);
      await this._atomicWriteFile(
        this._getManifestPath(workflowId),
        JSON.stringify(manifest, null, 2)
      );

      return updatedVersion;
    });
  }

  /**
   * Promotes an unverified draft to verified status using valid verification evidence.
   *
   * Crash-safe ordering:
   * 1. Writes verifications/<version>.evidence.json
   * 2. Writes versions/<version>.json with status: "verified"
   * 3. Atomically updates manifest.json (activeVersion = version, draftVersion = null)
   *
   * @param {string} workflowId
   * @param {number} versionNumber
   * @param {object} verificationEvidence
   * @returns {Promise<{ manifest: object, version: object, evidence: object }>}
   */
  async markVerified(workflowId, versionNumber, verificationEvidence) {
    return this._withLock(workflowId, async () => {
      const manifest = await this.getManifest(workflowId);
      if (!manifest) {
        throw new WorkflowNotFoundError(`Workflow "${workflowId}" not found.`, { workflowId });
      }

      const versionObj = await this.getVersion(workflowId, versionNumber);
      if (!versionObj) {
        throw new WorkflowNotFoundError(`Version ${versionNumber} of workflow "${workflowId}" not found.`, {
          workflowId,
          version: versionNumber,
        });
      }

      if (manifest.activeVersion === versionNumber) {
        throw new ImmutableVersionError(
          `Version ${versionNumber} of workflow "${workflowId}" is already verified.`,
          { workflowId, version: versionNumber }
        );
      }

      if (manifest.draftVersion !== versionNumber) {
        throw new VersionConflictError(
          `Version ${versionNumber} is not the current active draft (active draft: ${manifest.draftVersion}).`,
          { workflowId, expectedVersion: manifest.draftVersion, actualVersion: versionNumber }
        );
      }

      validateVerificationEvidence(verificationEvidence);
      const computedHash = calculateContentHash(versionObj);
      verifyEvidenceMatchesWorkflow(verificationEvidence, versionObj, computedHash);

      const verifiedVersion = {
        ...versionObj,
        status: 'verified',
      };
      validateWorkflowVersion(verifiedVersion);

      // Step 1: Write verification evidence atomically
      await this._atomicWriteFile(
        this._getVerificationPath(workflowId, versionNumber),
        JSON.stringify(verificationEvidence, null, 2)
      );

      // Step 2: Seal version record as verified atomically
      await this._atomicWriteFile(
        this._getVersionPath(workflowId, versionNumber),
        JSON.stringify(verifiedVersion, null, 2)
      );

      // Step 3: Advance activeVersion in manifest atomically (only now is version runnable!)
      manifest.activeVersion = versionNumber;
      if (manifest.draftVersion === versionNumber) {
        manifest.draftVersion = null;
      }
      manifest.timestamps.updatedAt = new Date().toISOString();
      validateManifest(manifest);

      await this._atomicWriteFile(
        this._getManifestPath(workflowId),
        JSON.stringify(manifest, null, 2)
      );

      return {
        manifest,
        version: verifiedVersion,
        evidence: verificationEvidence,
      };
    });
  }

  /**
   * Enables or disables a workflow via its manifest without altering historical version records.
   *
   * @param {string} workflowId
   * @param {boolean} enabled
   * @returns {Promise<object>} The updated manifest.
   */
  async setEnabled(workflowId, enabled) {
    return this._withLock(workflowId, async () => {
      const manifest = await this.getManifest(workflowId);
      if (!manifest) {
        throw new WorkflowNotFoundError(`Workflow "${workflowId}" not found.`, { workflowId });
      }

      manifest.enabled = Boolean(enabled);
      manifest.timestamps.updatedAt = new Date().toISOString();
      validateManifest(manifest);

      await this._atomicWriteFile(
        this._getManifestPath(workflowId),
        JSON.stringify(manifest, null, 2)
      );

      return manifest;
    });
  }

  /**
   * Deletes an unverified draft version record.
   * Throws ImmutableVersionError if the targeted version is verified.
   *
   * @param {string} workflowId
   * @param {number} versionNumber
   * @returns {Promise<{ deleted: boolean, versionNumber: number }>}
   */
  async deleteDraftVersion(workflowId, versionNumber) {
    return this._withLock(workflowId, async () => {
      const manifest = await this.getManifest(workflowId);
      if (!manifest) {
        throw new WorkflowNotFoundError(`Workflow "${workflowId}" not found.`, { workflowId });
      }

      if (manifest.activeVersion === versionNumber) {
        throw new ImmutableVersionError(
          `Cannot delete verified version ${versionNumber} of workflow "${workflowId}". Verified versions are immutable.`,
          { workflowId, version: versionNumber }
        );
      }

      const versionObj = await this.getVersion(workflowId, versionNumber);

      if (versionObj && versionObj.status === 'verified') {
        throw new ImmutableVersionError(
          `Cannot delete verified version ${versionNumber} of workflow "${workflowId}". Verified versions are immutable.`,
          { workflowId, version: versionNumber }
        );
      }

      if (!versionObj && manifest.draftVersion !== versionNumber) {
        throw new WorkflowNotFoundError(`Version ${versionNumber} of workflow "${workflowId}" not found.`, {
          workflowId,
          version: versionNumber,
        });
      }

      // Safe removal of draft file
      try {
        await fs.unlink(this._getVersionPath(workflowId, versionNumber));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }

      // Safe removal of any orphaned or intermediate evidence file for this draft
      try {
        await fs.unlink(this._getVerificationPath(workflowId, versionNumber));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }

      if (manifest.draftVersion === versionNumber) {
        manifest.draftVersion = null;
        manifest.timestamps.updatedAt = new Date().toISOString();
        validateManifest(manifest);

        await this._atomicWriteFile(
          this._getManifestPath(workflowId),
          JSON.stringify(manifest, null, 2)
        );
      }

      return { deleted: true, versionNumber };
    });
  }
}
