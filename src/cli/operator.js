/**
 * Super Memory — Operator CLI Core
 *
 * Implements the operator experience for Phase 3D:
 * - List workflows and inspect operational state
 * - Read-only review of proposed repair diffs (secret-safe)
 * - Safe trial execution of draft versions (genuine Playwright verification)
 * - Explicit operator-confirmed promotion with content-hash-bound evidence verification:
 *   Evidence is bound to the workflow ID, version, and content hash. This detects draft
 *   changes after trial, but the staged JSON evidence is not cryptographically signed
 *   and is trusted within the local-operator trust model.
 * - Normal playback and model-assisted repair orchestration
 *
 * Invariants & Guarantees:
 * - Active verified version remains unchanged while drafts are pending
 * - Ordinary playback strictly rejects unverified drafts
 * - Only the current draft can be trialed or promoted
 * - Failed trials cannot produce valid promotion evidence
 * - Successful trials never automatically promote
 * - No shell execution, direct code injection, or secret leakage
 * - Promotion preserves disabled state without silently enabling
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';

import {
  FileSystemWorkflowRepository,
  WorkflowPlayer,
  validateRuntimeInputs,
  calculateContentHash,
  validateVerificationEvidence,
  verifyEvidenceMatchesWorkflow,
  collectFailureDiagnostic,
  generateRepairProposal,
  applyRepairToDraft,
  redactSecrets,
  WorkflowError,
  WorkflowValidationError,
  WorkflowNotFoundError,
} from '../workflow/index.js';

import { createBrowserRuntime } from '../browser/index.js';
import {
  createModelProvider,
  getPreferredRecoveryProvider,
} from '../models/index.js';
import {
  validateTaskIntent,
  findMatchingWorkflow,
  DiscoveryOrchestrator,
  parseNaturalLanguageTask,
} from '../discovery/index.js';
import {
  resolveWorkflowsDir,
  detectLegacyWorkflowsDir,
  ensureSuperMemoryHome,
  getHomePaths,
  HOME_ENV_VAR,
} from '../config/home.js';
import { appendAuditEvent } from '../config/audit.js';
import { scanRepositoryIntegrity } from '../workflow/integrity.js';

/**
 * Returns the default staging path for trial verification evidence.
 * Placed inside `<baseDir>/.staging/` so repository version scanners ignore it.
 *
 * @param {string} baseDir
 * @param {string} workflowId
 * @param {number} draftVersion
 * @returns {string}
 */
export function getStagedEvidencePath(baseDir, workflowId, draftVersion) {
  return path.join(path.resolve(baseDir), '.staging', `${workflowId}-draft-${draftVersion}.evidence.json`);
}

/**
 * Ensures the local synthetic fixture server is running if the target origin is on port 8080.
 *
 * @param {string} targetOrigin
 * @returns {Promise<import('node:http').Server|null>}
 */
async function ensureLocalFixtureIfTargeted(targetOrigin) {
  if (!targetOrigin) return null;
  try {
    const url = new URL(targetOrigin);
    if ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && (url.port === '8080' || !url.port)) {
      const isListening = await new Promise((resolve) => {
        const req = http.get('http://127.0.0.1:8080/store', { timeout: 300 }, (res) => {
          res.resume();
          resolve(true);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
      });

      if (!isListening) {
        const { startFixtureServer } = await import('../../scripts/serve-fixture.js');
        return await startFixtureServer(8080);
      }
    }
  } catch {}
  return null;
}

/**
 * Reads and validates a JSON inputs file without echoing its contents or secrets.
 *
 * @param {string} inputsPath
 * @returns {Promise<Record<string, string>>}
 */
export async function loadInputs(inputsPath) {
  if (!inputsPath) return {};
  const resolved = path.resolve(inputsPath);
  let content;
  try {
    content = await fs.readFile(resolved, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new WorkflowError(`Inputs file not found: "${inputsPath}".`);
    }
    throw new WorkflowError(`Failed to read inputs file "${inputsPath}": ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new WorkflowError(`Invalid JSON in inputs file "${inputsPath}": ${err.message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WorkflowError(`Inputs file "${inputsPath}" must contain a JSON object mapping input names to string values.`);
  }

  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val !== 'string') {
      throw new WorkflowError(`Input "${key}" must be a string value (received ${typeof val}).`);
    }
  }

  return parsed;
}

/**
 * Collects known sensitive values for output redaction from runtime input
 * objects and explicit secret lists. Only non-empty strings are collected.
 *
 * @param {...(object|Array)} sources - Input objects (values used) or secret arrays
 * @returns {string[]}
 */
export function deriveSecrets(...sources) {
  const out = [];
  for (const source of sources) {
    if (!source) continue;
    const values = Array.isArray(source) ? source : Object.values(source);
    for (const value of values) {
      if (typeof value === 'string' && value.trim().length > 0) {
        out.push(value);
      }
    }
  }
  return out;
}

/**
 * Establishes the single validated source of truth for effective runtime
 * inputs during discovery: the merge of TaskIntent parameters and any
 * separately supplied runtime inputs (direct object or --inputs file).
 *
 * Rules (fail closed; error messages name inputs, never values):
 * - Every runtime input must be declared as a task parameter.
 * - When both sources supply a non-empty value for the same input, the
 *   values must agree exactly; a conflict is rejected rather than silently
 *   preferring one source across discovery, lookup, and playback.
 * - An empty intent value means "supplied at runtime" and is filled from
 *   the runtime inputs; otherwise the intent value is the effective value.
 *
 * @param {object} intent - Validated TaskIntent
 * @param {object} runtimeInputs - Runtime input values by name
 * @returns {Record<string, string>} Effective runtime inputs by name
 */
export function resolveEffectiveInputs(intent, runtimeInputs = {}) {
  if (!runtimeInputs || typeof runtimeInputs !== 'object' || Array.isArray(runtimeInputs)) {
    throw new WorkflowError('Runtime inputs must be an object mapping input names to string values.');
  }

  const declared = new Map();
  for (const param of intent?.parameters || []) {
    if (param && typeof param.name === 'string') {
      declared.set(param.name, param);
    }
  }

  const inputs = {};
  for (const [name, value] of Object.entries(runtimeInputs)) {
    if (typeof value !== 'string') {
      throw new WorkflowError(`Runtime input "${name}" must be a string value.`);
    }
    if (!declared.has(name)) {
      throw new WorkflowError(
        `Runtime input "${name}" is not declared in the task intent parameters. Declare it in the intent or remove it from the inputs file.`
      );
    }
    const intentValue = declared.get(name).value;
    if (typeof intentValue === 'string' && intentValue !== '' && value !== intentValue) {
      throw new WorkflowError(
        `Runtime input "${name}" conflicts with the task intent parameter of the same name. Provide one consistent value in the intent and the inputs file.`
      );
    }
    inputs[name] = value;
  }

  for (const param of intent?.parameters || []) {
    if (param && typeof param.name === 'string' && inputs[param.name] === undefined) {
      inputs[param.name] = param.value;
    }
  }

  return inputs;
}

/**
 * Formats a clean ASCII table for workflow listings.
 *
 * @param {Array<string>} headers
 * @param {Array<Array<string>>} rows
 * @returns {string}
 */
export function formatTable(headers, rows) {
  const colWidths = headers.map((h, i) => {
    let max = h.length;
    for (const r of rows) {
      if (r[i] && r[i].length > max) {
        max = r[i].length;
      }
    }
    return max;
  });

  const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join('   ');
  const separatorLine = colWidths.map((w) => '-'.repeat(w)).join('   ');
  const dataLines = rows.map((r) =>
    r.map((val, i) => (val || '').padEnd(colWidths[i])).join('   ')
  );

  return [headerLine, separatorLine, ...dataLines].join('\n');
}

/**
 * Compares an active version and a draft version and produces a human-readable,
 * secret-safe diff identifying exact step, target, input, and success criteria changes.
 *
 * @param {object|null} activeVersion
 * @param {object} draftVersion
 * @param {object} [options]
 * @param {string[]} [options.secrets]
 * @returns {string}
 */
export function renderDiff(activeVersion, draftVersion, { secrets = [] } = {}) {
  const out = [];

  out.push('================================================================================');
  out.push(`REPAIR PROPOSAL REVIEW: ${draftVersion.workflowId}`);
  out.push('================================================================================');
  out.push(`Draft Version:   v${draftVersion.version}`);
  out.push(`Parent Version:  ${draftVersion.parentVersion ? `v${draftVersion.parentVersion}` : 'none'}`);
  out.push(`Active Version:  ${activeVersion ? `v${activeVersion.version}` : 'none (draft-only)'}`);
  out.push(`Change Summary:  ${redactSecrets(draftVersion.changeSummary || '(no summary provided)', secrets)}`);

  let draftHash = 'unknown';
  let activeHash = null;
  try {
    draftHash = calculateContentHash(draftVersion);
  } catch {}
  if (activeVersion) {
    try {
      activeHash = calculateContentHash(activeVersion);
    } catch {}
  }
  out.push(`Content Hash:    ${activeHash ? `${activeHash.slice(0, 16)}... -> ` : ''}${draftHash.slice(0, 16)}...`);

  if (!activeVersion) {
    out.push('\n--- Initial Draft Version (No parent active version to diff against) ---');
    for (const step of draftVersion.steps || []) {
      const stepId = redactSecrets(step.id || '', secrets);
      const stepParams = redactSecrets(JSON.stringify(step.params || {}), secrets);
      const stepDesc = step.description ? ` (${redactSecrets(step.description, secrets)})` : '';
      out.push(`  [Added Step ${step.order}] ${step.action} (${stepId})${stepDesc}: ${stepParams}`);
    }
    out.push('================================================================================');
    return out.join('\n');
  }

  // 1. Step Changes
  out.push('\n--- Step Changes ---');
  const activeSteps = activeVersion.steps || [];
  const draftSteps = draftVersion.steps || [];
  const maxSteps = Math.max(activeSteps.length, draftSteps.length);

  let hasStepChanges = false;
  for (let i = 0; i < maxSteps; i++) {
    const a = activeSteps[i];
    const d = draftSteps[i];

    if (a && d) {
      const aJson = JSON.stringify({ action: a.action, description: a.description, params: a.params, verification: a.verification });
      const dJson = JSON.stringify({ action: d.action, description: d.description, params: d.params, verification: d.verification });

      if (aJson === dJson && a.id === d.id) {
        const dId = redactSecrets(d.id || '', secrets);
        const dParams = formatStepParams(d.params, secrets);
        out.push(`  [Unchanged] Step ${d.order} (${dId}): ${d.action} ${dParams}`);
      } else {
        hasStepChanges = true;
        const dId = redactSecrets(d.id || '', secrets);
        out.push(`  [Modified]  Step ${d.order} (${dId}):`);
        if (a.action !== d.action) {
          out.push(`    - action: ${a.action}`);
          out.push(`    + action: ${d.action}`);
        }
        if (a.description !== d.description) {
          out.push(`    - description: ${redactSecrets(a.description || '', secrets)}`);
          out.push(`    + description: ${redactSecrets(d.description || '', secrets)}`);
        }
        if (JSON.stringify(a.params) !== JSON.stringify(d.params)) {
          out.push(`    - target: ${redactSecrets(JSON.stringify(a.params || {}), secrets)}`);
          out.push(`    + target: ${redactSecrets(JSON.stringify(d.params || {}), secrets)}`);
        }
        if (JSON.stringify(a.verification) !== JSON.stringify(d.verification)) {
          out.push(`    - verification: ${redactSecrets(JSON.stringify(a.verification || null), secrets)}`);
          out.push(`    + verification: ${redactSecrets(JSON.stringify(d.verification || null), secrets)}`);
        }
      }
    } else if (!a && d) {
      hasStepChanges = true;
      const dId = redactSecrets(d.id || '', secrets);
      const dParams = redactSecrets(JSON.stringify(d.params || {}), secrets);
      out.push(`  [Added]     Step ${d.order} (${dId}): ${d.action} ${dParams}`);
      if (d.description) {
        out.push(`              description: ${redactSecrets(d.description, secrets)}`);
      }
      if (d.verification) {
        out.push(`              verification: ${redactSecrets(JSON.stringify(d.verification), secrets)}`);
      }
    } else if (a && !d) {
      hasStepChanges = true;
      const aId = redactSecrets(a.id || '', secrets);
      const aParams = redactSecrets(JSON.stringify(a.params || {}), secrets);
      out.push(`  [Removed]   Step ${a.order} (${aId}): ${a.action} ${aParams}`);
      if (a.description) {
        out.push(`              description: ${redactSecrets(a.description, secrets)}`);
      }
      if (a.verification) {
        out.push(`              verification: ${redactSecrets(JSON.stringify(a.verification), secrets)}`);
      }
    }
  }

  if (!hasStepChanges && activeSteps.length === draftSteps.length) {
    out.push('  (No step differences detected)');
  }

  // 2. Target Changes
  out.push('\n--- Target Changes ---');
  const aTarget = activeVersion.target || {};
  const dTarget = draftVersion.target || {};
  let targetChanged = false;
  if (aTarget.origin !== dTarget.origin) {
    targetChanged = true;
    out.push(`  - origin: ${redactSecrets(aTarget.origin || '', secrets)}`);
    out.push(`  + origin: ${redactSecrets(dTarget.origin || '', secrets)}`);
  }
  if (aTarget.startPath !== dTarget.startPath) {
    targetChanged = true;
    out.push(`  - startPath: ${redactSecrets(aTarget.startPath || '', secrets)}`);
    out.push(`  + startPath: ${redactSecrets(dTarget.startPath || '', secrets)}`);
  }
  if (!targetChanged) {
    out.push('  (No target changes)');
  }

  // 3. Input Declaration Changes
  out.push('\n--- Input Changes ---');
  const aInputs = JSON.stringify(activeVersion.inputs || []);
  const dInputs = JSON.stringify(draftVersion.inputs || []);
  if (aInputs !== dInputs) {
    out.push(`  - inputs: ${redactSecrets(aInputs, secrets)}`);
    out.push(`  + inputs: ${redactSecrets(dInputs, secrets)}`);
  } else {
    out.push('  (No input declaration changes)');
  }

  // 4. Success Criteria Changes
  out.push('\n--- Success Criteria Changes ---');
  const aSC = JSON.stringify(activeVersion.successCriteria || {});
  const dSC = JSON.stringify(draftVersion.successCriteria || {});
  if (aSC !== dSC) {
    out.push(`  - criteria: ${redactSecrets(aSC, secrets)}`);
    out.push(`  + criteria: ${redactSecrets(dSC, secrets)}`);
  } else {
    out.push('  (No success criteria changes)');
  }

  out.push('\nStatus: UNAPPROVED DRAFT (Untrusted until trialed and explicitly promoted)');
  out.push('================================================================================');

  return out.join('\n');
}

function formatStepParams(params, secrets = []) {
  if (!params || typeof params !== 'object') return '';
  const parts = [];
  if (params.role) parts.push(`role: "${redactSecrets(params.role, secrets)}"`);
  if (params.name) parts.push(`name: "${redactSecrets(params.name, secrets)}"`);
  if (params.label) parts.push(`label: "${redactSecrets(params.label, secrets)}"`);
  if (params.inputName) parts.push(`inputName: "${redactSecrets(params.inputName, secrets)}"`);
  return parts.length > 0 ? `(${parts.join(', ')})` : '';
}

/**
 * Super Memory Operator CLI Core Handler
 */
export class OperatorCLI {
  /**
   * @param {object} [options]
   * @param {FileSystemWorkflowRepository} [options.repository]
   * @param {string} [options.workflowsDir]
   * @param {object} [options.browserRuntime]
   * @param {object} [options.modelProvider]
   * @param {boolean} [options.allowLocalhost=false]
   * @param {boolean} [options.headless=true]
   * @param {object} [options.io]
   */
  constructor({
    repository,
    workflowsDir,
    homeDir,
    browserRuntime,
    modelProvider,
    allowLocalhost = false,
    headless = true,
    io = {},
  } = {}) {
    // Repository resolution: explicit -w/argument wins, then WORKFLOWS_DIR,
    // then the managed Super Memory home repository. homeDir (or the
    // SUPER_MEMORY_HOME env var) redirects the managed home, e.g. in tests.
    const env = homeDir ? { ...process.env, [HOME_ENV_VAR]: homeDir } : process.env;
    const resolved = resolveWorkflowsDir({ explicit: workflowsDir, env });
    this.homeDir = resolved.home;
    this.homePaths = getHomePaths(resolved.home);
    this.workflowsDirSource = resolved.source;
    this.workflowsDir = resolved.workflowsDir;
    this.repo = repository || new FileSystemWorkflowRepository({ baseDir: this.workflowsDir });
    this.browserRuntime = browserRuntime;
    this.modelProvider = modelProvider;
    this.allowLocalhost = Boolean(allowLocalhost);
    this.headless = Boolean(headless);

    this.stdin = io.stdin || process.stdin;
    this.stdout = io.stdout || process.stdout;
    this.stderr = io.stderr || process.stderr;
  }

  /** True when the active repository is the managed home repository. */
  _isManagedRepository() {
    return (
      typeof this.repo?.baseDir === 'string' &&
      path.resolve(this.repo.baseDir) === this.homePaths.workflows
    );
  }

  /**
   * Appends a privacy-safe audit event for managed-memory operations.
   * Only allow-listed fields are recorded; audit failures never break the
   * operation they describe.
   */
  async _audit(event, { managedOnly = true } = {}) {
    if (managedOnly && !this._isManagedRepository()) return;
    try {
      await appendAuditEvent(this.homePaths.audit, event);
    } catch {}
  }

  write(msg = '') {
    if (this.stdout && typeof this.stdout.write === 'function') {
      this.stdout.write(msg + '\n');
    }
  }

  writeErr(msg = '') {
    if (this.stderr && typeof this.stderr.write === 'function') {
      this.stderr.write(msg + '\n');
    }
  }

  /**
   * Capability A: List workflows
   */
  async list({ enabledOnly = false } = {}) {
    const workflows = await this.repo.list({ enabledOnly });
    if (!workflows || workflows.length === 0) {
      this.write(`No workflows found in repository (${this.workflowsDir}).`);
      return [];
    }

    const headers = ['WORKFLOW ID', 'STATUS', 'ACTIVE', 'DRAFT', 'NAME'];
    const rows = workflows.map((wf) => {
      if (wf.corrupt) {
        return [wf.id || 'unknown', 'CORRUPT', '-', '-', `[Corrupt: ${wf.error || 'Invalid manifest'}]`];
      }
      return [
        wf.id,
        wf.enabled ? 'enabled' : 'disabled',
        wf.activeVersion ? `v${wf.activeVersion}` : 'none',
        wf.draftVersion ? `v${wf.draftVersion} (draft)` : 'none',
        wf.name || '',
      ];
    });

    this.write(formatTable(headers, rows));
    return workflows;
  }

  /**
   * Capability B: Inspect a workflow
   *
   * Workflow-authored content is redacted against supplied runtime inputs so a
   * coincidental secret value in a description or parameter cannot leak.
   */
  async inspect(workflowId, { inputsPath, inputs: directInputs, secrets: customSecrets = [] } = {}) {
    if (!workflowId) {
      throw new WorkflowError('Missing workflow ID for inspect command.');
    }

    let secrets = deriveSecrets(customSecrets, directInputs);
    if (!directInputs && inputsPath) {
      try {
        secrets = [...secrets, ...deriveSecrets(await loadInputs(inputsPath))];
      } catch {}
    }

    const manifest = await this.repo.getManifest(workflowId);
    if (!manifest) {
      throw new WorkflowNotFoundError(`Workflow "${workflowId}" not found in repository.`, { workflowId });
    }

    const stepLine = (step) =>
      `    Step ${step.order}: ${step.action} [${redactSecrets(step.id || '', secrets)}] ${formatStepParams(step.params, secrets)}${step.description ? ` (${redactSecrets(step.description, secrets)})` : ''}`;

    this.write('================================================================================');
    this.write(`WORKFLOW: ${manifest.id}`);
    this.write('================================================================================');
    this.write(`Name:         ${redactSecrets(manifest.name || '', secrets)}`);
    this.write(`Description:  ${redactSecrets(manifest.description || '', secrets)}`);
    this.write(`Status:       ${manifest.enabled ? 'ENABLED' : 'DISABLED'}`);
    this.write(`Created:      ${manifest.timestamps?.createdAt || 'unknown'}`);
    this.write(`Updated:      ${manifest.timestamps?.updatedAt || 'unknown'}`);

    // Active Version Details
    if (manifest.activeVersion) {
      const activeVer = await this.repo.getVersion(workflowId, manifest.activeVersion);
      if (activeVer) {
        const hash = calculateContentHash(activeVer);
        this.write(`\n[Active Version: v${activeVer.version} (verified)]`);
        this.write(`  Content Hash:    ${hash}`);
        this.write(`  Target:          ${redactSecrets(activeVer.target?.origin || '', secrets)}${redactSecrets(activeVer.target?.startPath || '', secrets)}`);
        this.write(`  Total Steps:     ${activeVer.steps?.length || 0}`);
        for (const step of activeVer.steps || []) {
          this.write(stepLine(step));
        }
        this.write(`  Success Criteria: ${redactSecrets(JSON.stringify(activeVer.successCriteria || {}), secrets)}`);

        // Evidence details
        const evidence = await this.repo.getVerificationEvidence(workflowId, activeVer.version);
        if (evidence) {
          this.write('  Verification Evidence:');
          this.write(`    Verified At:   ${evidence.verifiedAt || 'unknown'}`);
          this.write(`    Playwright:    ${evidence.environment?.playwrightVersion || 'unknown'}`);
          this.write(`    Browser:       ${evidence.environment?.browserEngine || 'unknown'}`);
          this.write(`    Run ID:        ${evidence.runId || 'unknown'}`);
        }
      }
    } else {
      this.write('\n[Active Version: None (Draft-only workflow)]');
    }

    // Draft Version Details
    if (manifest.draftVersion) {
      const draftVer = await this.repo.getVersion(workflowId, manifest.draftVersion);
      if (draftVer) {
        const draftHash = calculateContentHash(draftVer);
        this.write(`\n[Draft Version: v${draftVer.version} (unapproved draft)] <-- PENDING OPERATOR REVIEW`);
        this.write(`  Parent Version:  ${draftVer.parentVersion ? `v${draftVer.parentVersion}` : 'none'}`);
        this.write(`  Content Hash:    ${draftHash}`);
        this.write(`  Change Summary:  ${redactSecrets(draftVer.changeSummary || '(no summary)', secrets)}`);
        this.write(`  Total Steps:     ${draftVer.steps?.length || 0}`);
        for (const step of draftVer.steps || []) {
          this.write(stepLine(step));
        }
        this.write(`  Success Criteria: ${redactSecrets(JSON.stringify(draftVer.successCriteria || {}), secrets)}`);
      }
    } else {
      this.write('\n[Draft Version: None]');
    }

    // Declared Inputs
    const refVersion = (manifest.activeVersion && (await this.repo.getVersion(workflowId, manifest.activeVersion))) ||
      (manifest.draftVersion && (await this.repo.getVersion(workflowId, manifest.draftVersion)));

    if (refVersion && refVersion.inputs && refVersion.inputs.length > 0) {
      this.write('\n[Declared Inputs]');
      for (const input of refVersion.inputs) {
        const reqStr = input.required ? 'required' : 'optional';
        this.write(`  - ${input.name} (${input.type}, ${reqStr}): ${redactSecrets(input.description || '', secrets)}`);
      }
    } else {
      this.write('\n[Declared Inputs: None]');
    }

    this.write('================================================================================');
    return manifest;
  }

  /**
   * Capability C: Review proposed repair (Strictly read-only)
   */
  async review(workflowId, { inputsPath, inputs: directInputs, secrets: customSecrets = [] } = {}) {
    if (!workflowId) {
      throw new WorkflowError('Missing workflow ID for review command.');
    }

    const manifest = await this.repo.getManifest(workflowId);
    if (!manifest) {
      throw new WorkflowNotFoundError(`Workflow "${workflowId}" not found in repository.`, { workflowId });
    }

    if (!manifest.draftVersion) {
      this.write(`Workflow "${workflowId}" has no pending draft repair.`);
      return null;
    }

    const draftVersion = await this.repo.getVersion(workflowId, manifest.draftVersion);
    if (!draftVersion) {
      throw new WorkflowNotFoundError(
        `Draft version ${manifest.draftVersion} for workflow "${workflowId}" not found on disk.`,
        { workflowId, version: manifest.draftVersion }
      );
    }

    const activeVersion = manifest.activeVersion
      ? await this.repo.getVersion(workflowId, manifest.activeVersion)
      : null;

    let secrets = deriveSecrets(customSecrets, directInputs);
    if (!directInputs && inputsPath) {
      try {
        secrets = [...secrets, ...deriveSecrets(await loadInputs(inputsPath))];
      } catch {}
    }

    const diffText = renderDiff(activeVersion, draftVersion, { secrets });
    this.write(diffText);
    return { activeVersion, draftVersion, diff: diffText };
  }

  /**
   * Capability D: Trial a draft using real browser verification
   */
  async trial(workflowId, { inputsPath, inputs: directInputs, evidenceOut, allowLocalhost, headless } = {}) {
    if (!workflowId) {
      throw new WorkflowError('Missing workflow ID for trial command.');
    }

    const manifest = await this.repo.getManifest(workflowId);
    if (!manifest) {
      throw new WorkflowNotFoundError(`Workflow "${workflowId}" not found in repository.`, { workflowId });
    }

    if (!manifest.draftVersion) {
      throw new WorkflowError(`Workflow "${workflowId}" has no draft version for verification.`);
    }

    const draftVersion = await this.repo.getVersion(workflowId, manifest.draftVersion);
    if (!draftVersion) {
      throw new WorkflowNotFoundError(
        `Draft version ${manifest.draftVersion} for workflow "${workflowId}" not found on disk.`,
        { workflowId, version: manifest.draftVersion }
      );
    }

    const inputs = directInputs || (await loadInputs(inputsPath));
    const secrets = deriveSecrets(inputs);

    // Validate inputs against draft declarations early
    validateRuntimeInputs(draftVersion.inputs || [], inputs, workflowId);

    const isLocalhostAllowed = allowLocalhost ?? this.allowLocalhost;
    const isHeadless = headless ?? this.headless;

    const player = new WorkflowPlayer({
      repository: this.repo,
      browserRuntime: this.browserRuntime,
      allowLocalhost: isLocalhostAllowed,
      headless: isHeadless,
    });

    this.write('================================================================================');
    this.write(`TRIAL DRAFT EXECUTION: ${workflowId} (Draft v${draftVersion.version})`);
    this.write('================================================================================');
    this.write(`Target Origin: ${draftVersion.target?.origin || 'unknown'}`);
    this.write(`Parent Version: v${draftVersion.parentVersion || 'none'}`);
    this.write('\nExecuting steps...');

    let autoFixtureServer = null;
    if (isLocalhostAllowed) {
      autoFixtureServer = await ensureLocalFixtureIfTargeted(draftVersion.target?.origin);
    }

    let trialResult;
    try {
      trialResult = await player.playDraftForVerification(workflowId, inputs, {
        allowLocalhost: isLocalhostAllowed,
      });
    } finally {
      if (!this.browserRuntime) {
        await player.close();
      }
      if (autoFixtureServer) {
        await new Promise((res) => autoFixtureServer.close(res)).catch(() => {});
      }
    }

    // Display sanitized step results
    for (const sr of trialResult.runResult.stepResults || []) {
      const okTag = sr.ok ? '[OK]    ' : '[FAILED]';
      const dur = typeof sr.durationMs === 'number' ? `(${sr.durationMs}ms)` : '';
      this.write(`  ${okTag} Step: ${sr.action} [${sr.stepId}] ${dur}`);
      if (!sr.ok && sr.error) {
        this.write(`           Error: ${redactSecrets(sr.error, secrets)}`);
      }
    }

    // Display success criteria
    const sc = trialResult.runResult.successCriteriaResult;
    const scTag = sc?.passed ? '[PASSED]' : '[FAILED]';
    this.write(`\nSuccess Criteria: ${scTag} ${redactSecrets(sc?.details || '', secrets)}`);

    this.write('--------------------------------------------------------------------------------');

    if (trialResult.candidatePromotionReady) {
      this.write('TRIAL VERDICT: PASSED (Candidate Ready For Explicit Promotion)');
      this.write(`Content Hash:  ${trialResult.evidence.contentHash}`);
      this.write(`Run ID:        ${trialResult.evidence.runId}`);
      this.write(`Verified At:   ${trialResult.evidence.verifiedAt}`);

      // Save staged evidence
      const targetPath = evidenceOut ? path.resolve(evidenceOut) : getStagedEvidencePath(this.repo.baseDir, workflowId, draftVersion.version);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, JSON.stringify(trialResult.evidence, null, 2), 'utf8');

      this.write(`\nEvidence saved to: ${targetPath}`);
      this.write('\nIMPORTANT: This draft has NOT been promoted.');
      this.write('Ordinary playback continues executing active verified version.');
      this.write(`To explicitly promote, run:\n  node scripts/super-memory.js promote ${workflowId}`);
      this.write('================================================================================');

      return {
        success: true,
        trialResult,
        evidencePath: targetPath,
      };
    } else {
      this.write('TRIAL VERDICT: FAILED (Not Ready For Promotion)');
      this.write('Draft remains unverified. Failed trials cannot produce valid promotion evidence.');

      // Clean up only the CLI-owned internal staged evidence file in .staging
      // so a failed run cannot leave stale staged evidence eligible for promotion.
      // Never delete a caller-owned or user-specified custom evidenceOut file.
      const defaultStagedPath = getStagedEvidencePath(this.repo.baseDir, workflowId, draftVersion.version);
      try {
        await fs.unlink(defaultStagedPath);
      } catch {}

      this.write('================================================================================');
      return {
        success: false,
        trialResult,
      };
    }
  }

  /**
   * Capability E: Explicitly promote a verified draft
   */
  async promote(workflowId, { evidencePath, evidence: directEvidence, confirm, isInteractive, inputsPath, inputs: directInputs, secrets: customSecrets = [] } = {}) {
    if (!workflowId) {
      throw new WorkflowError('Missing workflow ID for promote command.');
    }

    const manifest = await this.repo.getManifest(workflowId);
    if (!manifest) {
      throw new WorkflowNotFoundError(`Workflow "${workflowId}" not found in repository.`, { workflowId });
    }

    if (!manifest.draftVersion) {
      throw new WorkflowError(`Workflow "${workflowId}" has no draft version to promote.`);
    }

    const draftVersion = await this.repo.getVersion(workflowId, manifest.draftVersion);
    if (!draftVersion) {
      throw new WorkflowNotFoundError(
        `Draft version ${manifest.draftVersion} for workflow "${workflowId}" not found on disk.`,
        { workflowId, version: manifest.draftVersion }
      );
    }

    // Locate and load evidence
    let evidence = directEvidence;
    let evidenceSourcePath = null;
    if (!evidence) {
      evidenceSourcePath = evidencePath
        ? path.resolve(evidencePath)
        : getStagedEvidencePath(this.repo.baseDir, workflowId, draftVersion.version);

      try {
        const raw = await fs.readFile(evidenceSourcePath, 'utf8');
        evidence = JSON.parse(raw);
      } catch (err) {
        throw new WorkflowError(
          `No trial verification evidence found for draft v${draftVersion.version} at "${evidenceSourcePath}". ` +
            `Draft must be trialed successfully via "super-memory trial ${workflowId} --inputs <file>" before promotion.`
        );
      }
    }

    // Validate evidence schema and invariants
    validateVerificationEvidence(evidence);

    if (evidence.workflowId !== workflowId) {
      throw new WorkflowValidationError(
        `Verification evidence workflowId ("${evidence.workflowId}") does not match target workflow ("${workflowId}").`
      );
    }

    if (evidence.version !== draftVersion.version) {
      throw new WorkflowValidationError(
        `Verification evidence version (v${evidence.version}) does not match draft version (v${draftVersion.version}).`
      );
    }

    // Recompute current disk content hash and verify against evidence
    const computedHash = calculateContentHash(draftVersion);
    verifyEvidenceMatchesWorkflow(evidence, draftVersion, computedHash);

    // Require all steps to have passed and criteria passed
    if (!evidence.successCriteriaResult || !evidence.successCriteriaResult.passed) {
      throw new WorkflowValidationError('Cannot promote draft: trial evidence reports that success criteria failed.');
    }

    for (const sr of evidence.stepResults || []) {
      if (!sr.ok) {
        throw new WorkflowValidationError(`Cannot promote draft: step "${sr.stepId}" failed during trial verification.`);
      }
    }

    let secrets = deriveSecrets(customSecrets, directInputs);
    if (!directInputs && inputsPath) {
      try {
        secrets = [...secrets, ...deriveSecrets(await loadInputs(inputsPath))];
      } catch {}
    }

    // Display Pre-Promotion Summary
    this.write('================================================================================');
    this.write(`CONFIRM PROMOTION: ${workflowId}`);
    this.write('================================================================================');
    this.write(`Workflow:        ${workflowId}`);
    this.write(`Current Active:  ${manifest.activeVersion ? `v${manifest.activeVersion}` : 'none'}`);
    this.write(`Promoting Draft: v${draftVersion.version}`);
    this.write(`Change Summary:  ${redactSecrets(draftVersion.changeSummary || '(no summary)', secrets)}`);
    this.write(`Content Hash:    ${computedHash}`);
    this.write(`Verified At:     ${evidence.verifiedAt}`);
    this.write(`Run ID:          ${evidence.runId}`);
    this.write(`Enabled Status:  ${manifest.enabled ? 'ENABLED' : 'DISABLED'} (Preserved)`);
    this.write('--------------------------------------------------------------------------------');

    // Operator Confirmation Check
    const expectedConfirmation = `PROMOTE ${workflowId}`;
    let isConfirmed = false;

    if (confirm !== undefined && confirm !== null) {
      if (typeof confirm === 'string' && confirm.trim() === expectedConfirmation) {
        isConfirmed = true;
      } else if (confirm === true) {
        isConfirmed = true;
      } else {
        isConfirmed = false;
      }
    } else {
      // Interactive or piped confirmation
      const rl = readline.createInterface({
        input: this.stdin,
        output: this.stdout,
      });

      try {
        const answer = await rl.question(
          `To confirm promotion of draft v${draftVersion.version} to active status, type "${expectedConfirmation}": `
        );
        isConfirmed = answer.trim() === expectedConfirmation;
      } finally {
        rl.close();
      }
    }

    if (!isConfirmed) {
      this.write(`Promotion cancelled by operator. (Expected "${expectedConfirmation}")`);
      return { promoted: false, reason: 'cancelled' };
    }

    // Atomic promotion through validated repository lifecycle
    const promotionResult = await this.repo.markVerified(workflowId, draftVersion.version, evidence);
    await this._audit({
      type: 'promotion',
      workflowId,
      version: draftVersion.version,
      contentHash: evidence.contentHash,
    });

    // Clean up staged evidence file if it exists
    if (evidenceSourcePath) {
      try {
        await fs.unlink(evidenceSourcePath);
      } catch {}
    }

    this.write('--------------------------------------------------------------------------------');
    this.write(`Promotion successful! Workflow "${workflowId}" active version is now v${draftVersion.version}.`);
    this.write('Draft version has been cleared.');
    this.write('================================================================================');

    return {
      promoted: true,
      manifest: promotionResult.manifest,
      version: promotionResult.version,
      evidence: promotionResult.evidence,
    };
  }

  /**
   * Helper: Play active verified version (ordinary playback)
   */
  /**
   * Runs a read-only integrity scan over the active repository.
   */
  async integrityScan() {
    const report = await scanRepositoryIntegrity(this.repo.baseDir);
    if (report.totals.workflows === 0) {
      this.write(`Integrity scan: repository at "${report.baseDir}" is empty.`);
      return report;
    }
    for (const workflow of report.workflows) {
      if (workflow.ok) {
        this.write(`  OK: ${workflow.id}`);
      } else {
        for (const issue of workflow.issues) {
          this.write(`  [${issue.code}] ${workflow.id}: ${issue.message}`);
        }
      }
    }
    this.write(
      report.ok
        ? `Integrity scan passed: ${report.totals.workflows} workflow(s), ${report.totals.versions} version(s), no issues.`
        : `Integrity scan found ${report.totals.issues} issue(s) across ${report.totals.workflows} workflow(s). The repository was not modified.`
    );
    return report;
  }

  async play(workflowId, { inputsPath, inputs: directInputs, allowLocalhost, headless } = {}) {
    if (!workflowId) {
      throw new WorkflowError('Missing workflow ID for play command.');
    }

    const inputs = directInputs || (await loadInputs(inputsPath));
    const secrets = deriveSecrets(inputs);
    const isLocalhostAllowed = allowLocalhost ?? this.allowLocalhost;
    const isHeadless = headless ?? this.headless;

    const player = new WorkflowPlayer({
      repository: this.repo,
      browserRuntime: this.browserRuntime,
      allowLocalhost: isLocalhostAllowed,
      headless: isHeadless,
    });

    let autoFixtureServer = null;
    if (isLocalhostAllowed) {
      try {
        const manifest = await this.repo.getManifest(workflowId);
        if (manifest?.activeVersion) {
          const activeVer = await this.repo.getVersion(workflowId, manifest.activeVersion);
          autoFixtureServer = await ensureLocalFixtureIfTargeted(activeVer?.target?.origin);
        }
      } catch {}
    }

    try {
      this.write(`Executing active verified version for workflow "${workflowId}"...`);
      const result = await player.play(workflowId, inputs, { allowLocalhost: isLocalhostAllowed });
      if (result.ok) {
        this.write(`Playback succeeded! Active version v${result.version} finished in ${result.durationMs}ms.`);
      } else {
        this.write(`Playback failed: active version v${result.version} encountered an error: ${redactSecrets(result.error, secrets)}`);
      }
      return result;
    } finally {
      if (!this.browserRuntime) {
        await player.close();
      }
      if (autoFixtureServer) {
        await new Promise((res) => autoFixtureServer.close(res)).catch(() => {});
      }
    }
  }

  /**
   * Helper: Model-assisted failure diagnosis and unapproved draft proposal generation
   */
  async repair(workflowId, { inputsPath, inputs: directInputs, provider, retries, allowLocalhost, headless } = {}) {
    if (!workflowId) {
      throw new WorkflowError('Missing workflow ID for repair command.');
    }

    const manifest = await this.repo.getManifest(workflowId);
    if (!manifest) {
      throw new WorkflowNotFoundError(`Workflow "${workflowId}" not found.`, { workflowId });
    }

    if (!manifest.activeVersion) {
      throw new WorkflowError(`Workflow "${workflowId}" has no active verified version to repair.`);
    }

    const activeVersion = await this.repo.getVersion(workflowId, manifest.activeVersion);
    const inputs = directInputs || (await loadInputs(inputsPath));
    const secrets = deriveSecrets(inputs);

    const isLocalhostAllowed = allowLocalhost ?? this.allowLocalhost;
    const isHeadless = headless ?? this.headless;

    const player = new WorkflowPlayer({
      repository: this.repo,
      browserRuntime: this.browserRuntime,
      allowLocalhost: isLocalhostAllowed,
      headless: isHeadless,
    });

    this.write(`Running active verified version v${manifest.activeVersion} to diagnose failure...`);

    let runResult;
    try {
      runResult = await player.play(workflowId, inputs, { allowLocalhost: isLocalhostAllowed });
    } finally {
      if (!this.browserRuntime) {
        await player.close();
      }
    }

    if (runResult.ok) {
      this.write(`Active version v${manifest.activeVersion} passed without errors. No repair needed.`);
      return { repaired: false, reason: 'active_passed' };
    }

    this.write(`Active version playback failed: ${redactSecrets(runResult.error, secrets)}`);
    this.write('Collecting failure diagnostics and DOM snapshot...');

    const failedStep = activeVersion.steps?.find((s) => s.id === runResult.failedStepId) || null;
    const diagnostic =
      runResult.diagnostic ||
      (await collectFailureDiagnostic({
        workflowId,
        version: activeVersion.version,
        error: runResult.error,
        failedStep,
        session: null,
        secrets,
      }));

    this.write(`Failure Category: ${diagnostic.category}`);
    this.write('Generating repair proposal using Meta reasoning model...');

    let modelProvider = provider || this.modelProvider;
    if (typeof modelProvider === 'string') {
      if (modelProvider === 'mock' || modelProvider === 'offline') {
        let callCount = 0;
        modelProvider = {
          provider: 'meta',
          modelId: 'muse-spark-1.3-discovery-mock',
          async complete({ prompt, messages } = {}) {
            const lastMsg = (messages && messages[messages.length - 1]?.content) || prompt || '';
            if (lastMsg.includes('/store')) {
              if (callCount === 0) {
                callCount++;
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
            if (lastMsg.includes('/cart')) {
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
            if (lastMsg.includes('/checkout')) {
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
      } else {
        modelProvider = createModelProvider(modelProvider);
      }
    } else if (!modelProvider) {
      modelProvider = getPreferredRecoveryProvider();
    }
    const proposalResult = await generateRepairProposal(
      modelProvider,
      diagnostic,
      activeVersion,
      retries !== undefined ? { retries } : {}
    );
    const proposal = proposalResult.proposal;

    this.write(`Proposal received for step "${proposal.stepId}": ${redactSecrets(proposal.suspectedCause, secrets)}`);
    this.write('Applying proposal to create unapproved draft version...');

    const draft = await applyRepairToDraft(this.repo, proposal, {
      changeSummary: proposal.suspectedCause,
      secrets,
    });

    this.write(`\nSuccessfully created unapproved draft v${draft.version}.`);
    this.write(`To review diff:   node scripts/super-memory.js review ${workflowId}`);
    this.write(`To trial draft:   node scripts/super-memory.js trial ${workflowId} --inputs <file>`);
    this.write(`To promote draft: node scripts/super-memory.js promote ${workflowId}`);

    return { repaired: true, draft, proposal };
  }

  /**
   * Discovers a new workflow or reuses an existing matching workflow for a task.
   *
   * @param {string|object} taskIntentOrObjective - TaskIntent object, JSON string, or NL objective string
   * @param {object} [options]
   * @param {string} [options.intentPath] - Path to JSON file containing TaskIntent
   * @param {string} [options.origin] - Target origin
   * @param {string} [options.startPath='/'] - Start path
   * @param {Array<{ name: string, value: string }>} [options.parameters=[]]
   * @param {string} [options.inputsPath] - Path to JSON file containing runtime input parameters
   * @param {object} [options.inputs] - Direct input parameters
   * @param {string|object} [options.provider] - Model provider
   * @param {boolean} [options.allowLocalhost]
   * @param {boolean} [options.headless]
   * @param {Function} [options.approveAction] - Explicit approval callback for consequential discovery actions
   * @param {string|null} [options.journalDir] - Scratch directory for the discovery session journal (default: managed home journals/; null disables)
   * @returns {Promise<object>}
   */
  async discover(taskIntentOrObjective, {
    intentPath,
    origin,
    startPath = '/',
    parameters = [],
    inputsPath,
    inputs: directInputs,
    provider,
    allowLocalhost,
    headless,
    approveAction,
    journalDir,
  } = {}) {
    // Default discovery journals live in the managed home when operating on
    // the managed repository; scratch-repository runs keep the historical
    // system-temp scratch location. An explicit journalDir (including null
    // to disable) always wins. The journal creates its directory lazily.
    const effectiveJournalDir =
      journalDir === undefined
        ? this._isManagedRepository()
          ? this.homePaths.journals
          : path.join(os.tmpdir(), 'super-memory-discovery-journal')
        : journalDir;
    let intent;
    let preloadedInputs;
    if (intentPath) {
      const resolved = path.resolve(intentPath);
      let raw;
      try {
        raw = await fs.readFile(resolved, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw new Error(`Intent file not found: ${resolved}`);
        }
        throw err;
      }
      try {
        intent = JSON.parse(raw);
      } catch (err) {
        throw new Error(`Failed to parse JSON in intent file "${resolved}": ${err.message}`);
      }
      validateTaskIntent(intent);
    } else if (taskIntentOrObjective && typeof taskIntentOrObjective === 'object') {
      intent = taskIntentOrObjective;
      validateTaskIntent(intent);
    } else if (typeof taskIntentOrObjective === 'string' && taskIntentOrObjective.trim().startsWith('{')) {
      intent = JSON.parse(taskIntentOrObjective);
      validateTaskIntent(intent);
    } else {
      const request = String(taskIntentOrObjective || '').trim();
      if (!request) {
        throw new Error('A task objective is required. Provide plain text plus --origin, or provide --intent <path>.');
      }
      if (!origin) {
        throw new Error('Plain-language discovery requires an explicit --origin. The model must not invent a target origin.');
      }
      const loadedParams = directInputs || (inputsPath ? await loadInputs(inputsPath) : {});
      preloadedInputs = loadedParams;
      const fixedParams = Array.isArray(parameters) && parameters.length > 0
        ? parameters
        : Object.entries(loadedParams).map(([name, value]) => ({ name, value: String(value) }));

      let nlProvider = provider || this.modelProvider;
      if (typeof nlProvider === 'string') {
        if (nlProvider === 'mock' || nlProvider === 'offline') {
          throw new Error(
            'Plain-language discovery requires a real model provider for intent parsing; "mock"/"offline" cannot interpret free text. Provide --intent <path> for deterministic offline use.'
          );
        }
        nlProvider = createModelProvider(nlProvider);
      } else if (!nlProvider) {
        try {
          nlProvider = getPreferredRecoveryProvider();
        } catch {
          throw new Error(
            'Plain-language discovery requires META_API_KEY, MODEL_API_KEY, or BASETEN_API_KEY. Otherwise provide --intent <path> for deterministic offline use.'
          );
        }
      }
      if (!nlProvider || typeof nlProvider.complete !== 'function') {
        throw new Error('Plain-language discovery requires a model provider with a complete() method.');
      }

      try {
        intent = await parseNaturalLanguageTask({
          provider: nlProvider,
          request,
          targetOrigin: origin,
          startPath,
          fixedParameters: fixedParams,
        });
      } catch (err) {
        if (err && err.needsClarification) {
          throw new Error(`Ambiguous task request: ${err.message} Refine the objective or provide --intent <path>.`);
        }
        throw err;
      }
    }

    // Single source of truth for effective runtime inputs: intent parameters
    // reconciled with any separately supplied runtime inputs. Conflicts,
    // undeclared runtime inputs, and non-string values are rejected here so
    // discovery, lookup, secrets, and playback can never silently diverge.
    const runtimeInputs = directInputs || preloadedInputs || (inputsPath ? await loadInputs(inputsPath) : {});
    const effectiveInputs = resolveEffectiveInputs(intent, runtimeInputs);
    intent = {
      ...intent,
      parameters: (intent.parameters || []).map((param) => ({
        ...param,
        value: effectiveInputs[param.name],
      })),
    };
    validateTaskIntent(intent);

    const isLocalhostAllowed = allowLocalhost ?? this.allowLocalhost;
    const isHeadless = headless ?? this.headless;

    // Step 1: Check existing workflows for lookup match
    this.write(`Checking existing workflows for reusable match on origin "${intent.targetOrigin}"...`);
    const match = await findMatchingWorkflow(this.repo, intent);

    if (match.ambiguous) {
      const lookupSecrets = deriveSecrets((intent.parameters || []).map((p) => p.value));
      this.writeErr(
        `Ambiguous workflow lookup: ${match.candidates.length} verified workflows match "${redactSecrets(intent.objective || '', lookupSecrets)}". ` +
          `Refine the objective, parameters, or success conditions instead of running an uncertain workflow.`
      );
      return {
        action: 'ambiguous',
        candidates: match.candidates,
        trace: [],
      };
    }

    if (match.match) {
      this.write(`\n[Lookup Hit] Found existing verified workflow "${match.workflowId}" (v${match.version}).`);
      this.write('Reusing verified workflow without model discovery calls...');

      const inputs = effectiveInputs;

      const playResult = await this.play(match.workflowId, {
        inputs,
        allowLocalhost: isLocalhostAllowed,
        headless: isHeadless,
      });

      return {
        action: 'reused',
        workflowId: match.workflowId,
        version: match.version,
        result: playResult,
      };
    }

    // Step 2: Discovery session
    this.write('[Lookup Miss] No matching workflow found. Initiating discovery session...');

    let modelProvider = provider || this.modelProvider;
    if (typeof modelProvider === 'string') {
      if (modelProvider === 'mock' || modelProvider === 'offline') {
        let callCount = 0;
        modelProvider = {
          provider: 'meta',
          modelId: 'muse-spark-1.3-discovery-mock',
          async complete({ prompt, messages } = {}) {
            const lastMsg = (messages && messages[messages.length - 1]?.content) || prompt || '';
            if (lastMsg.includes('/store')) {
              if (callCount === 0) {
                callCount++;
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
            if (lastMsg.includes('/cart')) {
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
            if (lastMsg.includes('/checkout')) {
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
      } else {
        modelProvider = createModelProvider(modelProvider);
      }
    } else if (!modelProvider) {
      modelProvider = getPreferredRecoveryProvider();
    }

    let ownRuntime = null;
    let runtime = this.browserRuntime;
    if (!runtime) {
      ownRuntime = await createBrowserRuntime({ headless: isHeadless });
      runtime = ownRuntime;
    }

    let autoFixtureServer = null;
    if (isLocalhostAllowed) {
      autoFixtureServer = await ensureLocalFixtureIfTargeted(intent.targetOrigin);
    }

    try {
      const orchestrator = new DiscoveryOrchestrator({
        browserRuntime: runtime,
        modelProvider,
        allowLocalhost: isLocalhostAllowed,
        approveAction,
        journalDir: effectiveJournalDir,
        onEvent: (ev) => {
          if (ev.event === 'observe') {
            this.write(`  [Step ${ev.stepIndex + 1}] Observing ${ev.url} (${ev.elementsCount} elements)`);
          } else if (ev.event === 'decide') {
            this.write(`  [Step ${ev.stepIndex + 1}] Action: ${ev.action} -> ${ev.name || ev.label || ''}`);
          }
        },
      });

      const discoveryRes = await orchestrator.runDiscovery(intent);

      if (discoveryRes.status !== 'SUCCESS') {
        this.writeErr(`Discovery failed: ${discoveryRes.status} (${discoveryRes.reason || 'unverifiable'})`);
        if (orchestrator.lastJournalPath) {
          this.writeErr(`Scratch journal retained at: ${orchestrator.lastJournalPath} (diagnostic only; never auto-resumed)`);
        }
        return {
          action: 'failed',
          status: discoveryRes.status,
          reason: discoveryRes.reason,
          trace: discoveryRes.trace,
          journalPath: orchestrator.lastJournalPath,
        };
      }

      this.write('\nDiscovery outcome verified! Converting trace to candidate workflow draft...');
      await this.repo.createWorkflow({
        id: discoveryRes.candidate.workflowId,
        name: discoveryRes.candidate.changeSummary || 'Discovered Workflow',
        description: discoveryRes.candidate.changeSummary || 'Discovered Workflow',
        target: discoveryRes.candidate.target,
        inputs: discoveryRes.candidate.inputs,
        steps: discoveryRes.candidate.steps,
        successCriteria: discoveryRes.candidate.successCriteria,
        schemaVersion: discoveryRes.candidate.schemaVersion,
      });

      this.write(`Successfully created workflow "${discoveryRes.candidate.workflowId}" with unapproved draft v1.`);
      this.write(`Content Hash:     ${discoveryRes.contentHash}`);
      this.write(`To review draft:  node scripts/super-memory.js inspect ${discoveryRes.candidate.workflowId}`);
      this.write(`To trial draft:   node scripts/super-memory.js trial ${discoveryRes.candidate.workflowId} --inputs <file>`);
      this.write(`To promote draft: node scripts/super-memory.js promote ${discoveryRes.candidate.workflowId}`);

      return {
        action: 'discovered',
        workflowId: discoveryRes.candidate.workflowId,
        draft: discoveryRes.candidate,
        contentHash: discoveryRes.contentHash,
        trace: discoveryRes.trace,
      };
    } finally {
      if (ownRuntime) {
        await ownRuntime.close().catch(() => {});
      }
      if (autoFixtureServer) {
        await new Promise((res) => autoFixtureServer.close(res)).catch(() => {});
      }
    }
  }

  /**
   * CLI Dispatcher / Command Router
   *
   * @param {string[]} argv
   * @returns {Promise<number>} Exit code
   */
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        'workflows-dir': { type: 'string', short: 'w' },
        'inputs': { type: 'string', short: 'i' },
        'intent': { type: 'string' },
        'origin': { type: 'string' },
        'start-path': { type: 'string' },
        'evidence': { type: 'string' },
        'evidence-out': { type: 'string' },
        'confirm': { type: 'string' },
        'yes': { type: 'boolean', short: 'y' },
        'allow-localhost': { type: 'boolean' },
        'headless': { type: 'boolean', default: true },
        'enabled-only': { type: 'boolean' },
        'provider': { type: 'string' },
        'retries': { type: 'string' },
        'offline': { type: 'boolean' },
        'help': { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: false,
    });

    if (values.help || positionals.length === 0) {
      this.printHelp();
      return 0;
    }

    if (values['workflows-dir']) {
      this.workflowsDir = path.resolve(values['workflows-dir']);
      this.workflowsDirSource = 'explicit';
      this.repo = new FileSystemWorkflowRepository({ baseDir: this.workflowsDir });
    } else if (this.workflowsDirSource === 'home') {
      // Never silently hide a pre-existing ./workflows repository: warn with
      // explicit migration guidance. Nothing is imported automatically.
      try {
        const legacy = await detectLegacyWorkflowsDir({ home: this.homeDir });
        if (legacy) {
          this.writeErr(`Warning: ${legacy.message}`);
        }
      } catch {}
    }

    const command = positionals[0];
    const targetId = positionals[1];

    try {
      switch (command) {
        case 'list':
        case 'ls':
          await this.list({ enabledOnly: Boolean(values['enabled-only']) });
          return 0;

        case 'integrity':
        case 'verify':
          return (await this.integrityScan()).ok ? 0 : 1;

        case 'inspect':
          if (!targetId) {
            this.writeErr('Error: Missing required argument <workflowId> for "inspect".');
            return 1;
          }
          await this.inspect(targetId, { inputsPath: values.inputs });
          return 0;

        case 'review':
          if (!targetId) {
            this.writeErr('Error: Missing required argument <workflowId> for "review".');
            return 1;
          }
          await this.review(targetId, { inputsPath: values.inputs });
          return 0;

        case 'trial':
          if (!targetId) {
            this.writeErr('Error: Missing required argument <workflowId> for "trial".');
            return 1;
          }
          const trialResult = await this.trial(targetId, {
            inputsPath: values.inputs,
            evidenceOut: values['evidence-out'],
            allowLocalhost: values['allow-localhost'],
            headless: values.headless !== false,
          });
          return trialResult.success ? 0 : 1;

        case 'promote':
          if (!targetId) {
            this.writeErr('Error: Missing required argument <workflowId> for "promote".');
            return 1;
          }
          const promoteResult = await this.promote(targetId, {
            evidencePath: values.evidence,
            confirm: values.confirm || values.yes,
            inputsPath: values.inputs,
          });
          return promoteResult.promoted ? 0 : 1;

        case 'play':
        case 'run':
          if (!targetId) {
            this.writeErr('Error: Missing required argument <workflowId> for "play".');
            return 1;
          }
          const playResult = await this.play(targetId, {
            inputsPath: values.inputs,
            allowLocalhost: values['allow-localhost'],
            headless: values.headless !== false,
          });
          return playResult.ok ? 0 : 1;

        case 'repair':
          if (!targetId) {
            this.writeErr('Error: Missing required argument <workflowId> for "repair".');
            return 1;
          }
          await this.repair(targetId, {
            inputsPath: values.inputs,
            provider: values.provider,
            retries: values.retries !== undefined ? Number.parseInt(values.retries, 10) : undefined,
            allowLocalhost: values['allow-localhost'],
            headless: values.headless !== false,
          });
          return 0;

        case 'discover':
          await this.discover(targetId, {
            intentPath: values.intent,
            origin: values.origin,
            startPath: values['start-path'],
            inputsPath: values.inputs,
            provider: values.offline ? 'mock' : values.provider,
            allowLocalhost: values['allow-localhost'],
            headless: values.headless !== false,
          });
          return 0;

        default:
          this.writeErr(`Error: Unknown command "${command}". Run "super-memory --help" for available commands.`);
          return 1;
      }
    } catch (err) {
      this.writeErr(`Error: ${err.message}`);
      return 1;
    }
  }

  printHelp() {
    this.write(`
Super Memory — Operator CLI for Intelligent Recovery & Discovery

Usage:
  super-memory <command> [argument] [options]

Commands:
  list                          List all workflows and their active/draft status
  inspect <workflowId>          Inspect details, active version, draft, and verification state
  review <workflowId>           Review proposed repair diff between active version and draft
  trial <workflowId>            Execute draft in trial mode with provided inputs
  promote <workflowId>          Explicitly promote verified draft to active verified version
  play <workflowId>             Execute active verified workflow version
  repair <workflowId>           Diagnose failure and generate unapproved repair draft via Meta model
  discover [taskOrIntent]       Discover and synthesize a new workflow or reuse matching workflow
                              (plain text needs --origin and a real model provider; --intent is offline-safe)
  integrity                     Read-only integrity scan of the active repository

Options:
  --workflows-dir, -w <path>    Workflow repository root directory (default: managed home, SUPER_MEMORY_HOME)
  --inputs, -i <path>           JSON file containing workflow runtime inputs
  --intent <path>               Path to TaskIntent JSON file (for discover)
  --origin <url>                Target origin URL (for discover)
  --start-path <path>           Starting relative path (for discover)
  --evidence <path>             Path to trial verification evidence (for promote)
  --evidence-out <path>         Path to write trial verification evidence (for trial)
  --confirm <phrase>            Operator confirmation phrase (PROMOTE <workflowId>)
  --yes, -y                     Accept confirmation non-interactively
  --retries <n>                 Provider retry attempts for repair (default: 1; 0 disables retries)
  --allow-localhost             Allow navigation to loopback addresses (for local testing)
  --headless                    Run browser in headless mode (default: true)
  --enabled-only                Filter workflow list to only enabled workflows
  --help, -h                    Show this help message
`);
  }
}

/**
 * Top-level CLI entry point
 *
 * @param {string[]} [argv=process.argv.slice(2)]
 * @param {object} [io]
 * @returns {Promise<number>}
 */
export async function runCli(argv = process.argv.slice(2), io = {}) {
  const cli = new OperatorCLI({ io });
  return await cli.run(argv);
}
