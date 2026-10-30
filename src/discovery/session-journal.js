/**
 * Super Memory — Discovery Session Scratch Journal
 *
 * Crash-safe, minimal execution journal for active discovery sessions. This is
 * diagnostic scratch state only: it is stored outside the authoritative
 * workflow repository, never makes a workflow playable or promotable, and is
 * never executed from. Recovery is operator-driven; automatic resumption is
 * explicitly refused.
 *
 * Safety rules enforced here:
 * - Atomic writes (temp file + fsync + rename) so interrupted writes can never
 *   present as a falsely valid checkpoint.
 * - Only hashes and counts of page content are persisted — never raw input
 *   values, passwords, cookies, tokens, page text, element names, snapshots,
 *   or model prompts.
 * - Consequential-action attempts are recorded as hashes, so a future
 *   controller can detect prior attempts without ever replaying them.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { WorkflowError } from '../workflow/errors.js';

export const DISCOVERY_JOURNAL_VERSION = '1.0.0';
export const DISCOVERY_JOURNAL_FILE_PATTERN = /^discovery-.*\.json$/;

export class DiscoveryJournalError extends WorkflowError {
  constructor(message, details = {}) {
    super(message, { code: 'DISCOVERY_JOURNAL_ERROR', cause: details.cause });
    this.name = 'DiscoveryJournalError';
    this.path = details.path || null;
  }
}

export class JournalResumeRefusedError extends WorkflowError {
  constructor(message, details = {}) {
    super(message, { code: 'JOURNAL_RESUME_REFUSED', cause: details.cause });
    this.name = 'JournalResumeRefusedError';
    this.path = details.path || null;
  }
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

export function sanitizeJournalTaskId(taskId) {
  const safe = String(taskId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
  return safe || 'untitled_task';
}

const JOURNAL_RECORD_KEYS = [
  'journalVersion',
  'status',
  'taskId',
  'objectiveHash',
  'targetOrigin',
  'startPath',
  'parameterNames',
  'stepIndex',
  'modelCallCount',
  'totalTokensUsed',
  'lastObservation',
  'attemptedConsequentialKeyHashes',
  'reason',
  'updatedAt',
];

const LAST_OBSERVATION_KEYS = ['origin', 'pathHash', 'titleHash', 'textHash', 'elementsCount'];

function isHex64(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function validateJournalRecord(record, { expectedTaskId = null } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new DiscoveryJournalError('Discovery journal record must be a non-null object.');
  }
  const keys = Object.keys(record).sort();
  const expected = [...JOURNAL_RECORD_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new DiscoveryJournalError('Discovery journal record has unexpected keys; refusing to trust it.');
  }
  if (record.journalVersion !== DISCOVERY_JOURNAL_VERSION) {
    throw new DiscoveryJournalError(`Unsupported discovery journal version "${record.journalVersion}".`);
  }
  if (typeof record.status !== 'string' || record.status.trim() === '') {
    throw new DiscoveryJournalError('Discovery journal record must carry a non-empty status.');
  }
  if (typeof record.taskId !== 'string' || record.taskId.trim() === '') {
    throw new DiscoveryJournalError('Discovery journal record must carry a taskId.');
  }
  if (expectedTaskId !== null && record.taskId !== expectedTaskId) {
    throw new DiscoveryJournalError('Discovery journal taskId does not match the expected session.');
  }
  if (!isHex64(record.objectiveHash)) {
    throw new DiscoveryJournalError('Discovery journal objectiveHash must be a SHA-256 hex digest.');
  }
  if (typeof record.targetOrigin !== 'string' || typeof record.startPath !== 'string') {
    throw new DiscoveryJournalError('Discovery journal must carry targetOrigin and startPath strings.');
  }
  if (!Array.isArray(record.parameterNames) || record.parameterNames.some((name) => typeof name !== 'string')) {
    throw new DiscoveryJournalError('Discovery journal parameterNames must be an array of strings.');
  }
  for (const field of ['stepIndex', 'modelCallCount', 'totalTokensUsed']) {
    if (!Number.isFinite(record[field]) || record[field] < 0) {
      throw new DiscoveryJournalError(`Discovery journal field "${field}" must be a non-negative number.`);
    }
  }
  const observation = record.lastObservation;
  if (observation !== null && (typeof observation !== 'object' || Array.isArray(observation))) {
    throw new DiscoveryJournalError('Discovery journal lastObservation must be an object or null.');
  }
  if (observation !== null) {
    const observationKeys = Object.keys(observation).sort();
    const expectedObservationKeys = [...LAST_OBSERVATION_KEYS].sort();
    if (
      observationKeys.length !== expectedObservationKeys.length ||
      observationKeys.some((key, index) => key !== expectedObservationKeys[index])
    ) {
      throw new DiscoveryJournalError('Discovery journal lastObservation has unexpected keys.');
    }
    if (typeof observation.origin !== 'string') {
      throw new DiscoveryJournalError('Discovery journal observation origin must be a string.');
    }
    for (const field of ['pathHash', 'titleHash', 'textHash']) {
      if (!isHex64(observation[field])) {
        throw new DiscoveryJournalError(`Discovery journal observation field "${field}" must be a SHA-256 hex digest.`);
      }
    }
    if (!Number.isFinite(observation.elementsCount) || observation.elementsCount < 0) {
      throw new DiscoveryJournalError('Discovery journal elementsCount must be a non-negative number.');
    }
  }
  if (
    !Array.isArray(record.attemptedConsequentialKeyHashes) ||
    record.attemptedConsequentialKeyHashes.some((value) => !isHex64(value))
  ) {
    throw new DiscoveryJournalError('Discovery journal attemptedConsequentialKeyHashes must be SHA-256 hex digests.');
  }
  if (typeof record.reason !== 'string') {
    throw new DiscoveryJournalError('Discovery journal reason must be a string.');
  }
  if (typeof record.updatedAt !== 'string' || Number.isNaN(Date.parse(record.updatedAt))) {
    throw new DiscoveryJournalError('Discovery journal updatedAt must be an ISO timestamp string.');
  }
  return true;
}

export class DiscoverySessionJournal {
  /**
   * @param {object} options
   * @param {string} options.journalDir - Scratch directory outside the workflow repository
   * @param {string} options.taskId - Discovery task identifier
   * @param {string[]} [options.secrets] - Runtime values redacted out of free-text fields
   */
  constructor({ journalDir, taskId, secrets = [] } = {}) {
    if (typeof journalDir !== 'string' || journalDir.trim() === '') {
      throw new DiscoveryJournalError('A journalDir outside the workflow repository is required.');
    }
    this.journalDir = journalDir;
    this.taskId = sanitizeJournalTaskId(taskId);
    this.secrets = Array.isArray(secrets) ? secrets.filter((s) => typeof s === 'string' && s) : [];
    this.journalPath = path.join(this.journalDir, `discovery-${this.taskId}-${Date.now()}.json`);
  }

  _summarizeObservation(observation) {
    if (!observation || typeof observation !== 'object') {
      return null;
    }
    let origin = '';
    let pathname = '';
    try {
      const parsed = new URL(observation.url || '');
      origin = parsed.origin;
      pathname = parsed.pathname;
    } catch {}
    return {
      origin,
      pathHash: sha256Hex(pathname),
      titleHash: sha256Hex(observation.title || ''),
      textHash: sha256Hex(observation.text || ''),
      elementsCount: Array.isArray(observation.elements) ? observation.elements.length : 0,
    };
  }

  _buildRecord({ status, intent, stepIndex, modelCallCount, totalTokensUsed, lastObservation, attemptedConsequentialKeys, reason }) {
    return {
      journalVersion: DISCOVERY_JOURNAL_VERSION,
      status,
      taskId: this.taskId,
      objectiveHash: sha256Hex(intent?.objective || ''),
      targetOrigin: intent?.targetOrigin || '',
      startPath: intent?.startPath || '',
      parameterNames: (intent?.parameters || []).map((param) => param.name).filter((name) => typeof name === 'string'),
      stepIndex: Number.isFinite(stepIndex) ? stepIndex : 0,
      modelCallCount: Number.isFinite(modelCallCount) ? modelCallCount : 0,
      totalTokensUsed: Number.isFinite(totalTokensUsed) ? totalTokensUsed : 0,
      lastObservation: this._summarizeObservation(lastObservation),
      attemptedConsequentialKeyHashes: (attemptedConsequentialKeys || []).map((key) => sha256Hex(key)),
      reason: typeof reason === 'string' ? reason.slice(0, 500) : '',
      updatedAt: new Date().toISOString(),
    };
  }

  async _atomicWriteRecord(record) {
    validateJournalRecord(record, { expectedTaskId: this.taskId });
    const content = JSON.stringify(record, null, 2);
    await fs.mkdir(this.journalDir, { recursive: true });
    const tmpPath = `${this.journalPath}.tmp-${process.pid}`;
    const fileHandle = await fs.open(tmpPath, 'w');
    try {
      await fileHandle.writeFile(content, 'utf8');
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }
    await fs.rename(tmpPath, this.journalPath);
  }

  async checkpoint(data) {
    try {
      await this._atomicWriteRecord(this._buildRecord({ status: 'in-progress', ...data }));
    } catch (err) {
      try {
        await fs.unlink(`${this.journalPath}.tmp-${process.pid}`);
      } catch {}
      throw err;
    }
    return this.journalPath;
  }

  /**
   * Records a terminal status. A SUCCESS terminal deletes the scratch journal
   * because the completed candidate lives in the workflow repository.
   */
  async finalize(status, data = {}) {
    if (status === 'SUCCESS') {
      await this.discard();
      return { deleted: true, path: this.journalPath };
    }
    await this._atomicWriteRecord(this._buildRecord({ status, ...data }));
    return { deleted: false, path: this.journalPath };
  }

  async discard() {
    try {
      await fs.unlink(this.journalPath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  static async read(journalPath) {
    let raw;
    try {
      raw = await fs.readFile(journalPath, 'utf8');
    } catch (err) {
      throw new DiscoveryJournalError(`Cannot read discovery journal at "${journalPath}": ${err.message}.`, { path: journalPath });
    }
    let record;
    try {
      record = JSON.parse(raw);
    } catch (err) {
      throw new DiscoveryJournalError(`Discovery journal at "${journalPath}" is not valid JSON (possibly an interrupted write).`, { path: journalPath });
    }
    validateJournalRecord(record);
    return record;
  }

  /**
   * Lists interrupted (still in-progress) sessions. Terminal journals are
   * retained on disk but not reported as incomplete; unreadable files are
   * reported as corrupt rather than silently skipped.
   */
  static async listIncomplete(journalDir) {
    let entries;
    try {
      entries = await fs.readdir(journalDir);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { incomplete: [], corrupt: [] };
      }
      throw err;
    }
    const incomplete = [];
    const corrupt = [];
    for (const entry of entries.sort()) {
      if (!DISCOVERY_JOURNAL_FILE_PATTERN.test(entry) || entry.includes('.tmp-')) {
        continue;
      }
      const journalPath = path.join(journalDir, entry);
      try {
        const record = await DiscoverySessionJournal.read(journalPath);
        if (record.status === 'in-progress') {
          incomplete.push({
            path: journalPath,
            taskId: record.taskId,
            targetOrigin: record.targetOrigin,
            startPath: record.startPath,
            status: record.status,
            stepIndex: record.stepIndex,
            modelCallCount: record.modelCallCount,
            attemptedConsequentialCount: record.attemptedConsequentialKeyHashes.length,
            updatedAt: record.updatedAt,
          });
        }
      } catch (err) {
        corrupt.push({ path: journalPath, error: err.message });
      }
    }
    return { incomplete, corrupt };
  }

  /**
   * Proves an interrupted session is detectable, then refuses automatic
   * resumption. Interrupted sessions require a controlled operator restart;
   * replaying journal state could repeat an action whose outcome was uncertain.
   */
  static async refuseResume(journalPath) {
    const record = await DiscoverySessionJournal.read(journalPath);
    throw new JournalResumeRefusedError(
      `Automatic resumption is refused for interrupted discovery session "${record.taskId}" ` +
        `(status ${record.status}, step ${record.stepIndex}). Start a controlled restart with operator review instead.`,
      { path: journalPath }
    );
  }
}
