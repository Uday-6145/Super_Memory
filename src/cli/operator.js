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

import fs from 'node:fs/promises';
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
import { getPreferredRecoveryProvider } from '../models/index.js';

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
    workflowsDir = process.env.WORKFLOWS_DIR || './workflows',
    browserRuntime,
    modelProvider,
    allowLocalhost = false,
    headless = true,
    io = {},
  } = {}) {
    this.workflowsDir = path.resolve(workflowsDir);
    this.repo = repository || new FileSystemWorkflowRepository({ baseDir: this.workflowsDir });
    this.browserRuntime = browserRuntime;
    this.modelProvider = modelProvider;
    this.allowLocalhost = Boolean(allowLocalhost);
    this.headless = Boolean(headless);

    this.stdin = io.stdin || process.stdin;
    this.stdout = io.stdout || process.stdout;
    this.stderr = io.stderr || process.stderr;
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
   */
  async inspect(workflowId) {
    if (!workflowId) {
      throw new WorkflowError('Missing workflow ID for inspect command.');
    }

    const manifest = await this.repo.getManifest(workflowId);
    if (!manifest) {
      throw new WorkflowNotFoundError(`Workflow "${workflowId}" not found in repository.`, { workflowId });
    }

    this.write('================================================================================');
    this.write(`WORKFLOW: ${manifest.id}`);
    this.write('================================================================================');
    this.write(`Name:         ${manifest.name}`);
    this.write(`Description:  ${manifest.description}`);
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
        this.write(`  Target:          ${activeVer.target?.origin || ''}${activeVer.target?.startPath || ''}`);
        this.write(`  Total Steps:     ${activeVer.steps?.length || 0}`);
        for (const step of activeVer.steps || []) {
          this.write(`    Step ${step.order}: ${step.action} [${step.id}] ${formatStepParams(step.params)}`);
        }
        this.write(`  Success Criteria: ${JSON.stringify(activeVer.successCriteria || {})}`);

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
        this.write(`  Change Summary:  ${draftVer.changeSummary || '(no summary)'}`);
        this.write(`  Total Steps:     ${draftVer.steps?.length || 0}`);
        for (const step of draftVer.steps || []) {
          this.write(`    Step ${step.order}: ${step.action} [${step.id}] ${formatStepParams(step.params)}`);
        }
        this.write(`  Success Criteria: ${JSON.stringify(draftVer.successCriteria || {})}`);
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
        this.write(`  - ${input.name} (${input.type}, ${reqStr}): ${input.description || ''}`);
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

    let secrets = [...customSecrets];
    if (directInputs && typeof directInputs === 'object') {
      const extracted = Object.values(directInputs).filter((v) => typeof v === 'string' && v.trim().length > 0);
      secrets = [...secrets, ...extracted];
    } else if (inputsPath) {
      try {
        const loaded = await loadInputs(inputsPath);
        const extracted = Object.values(loaded).filter((v) => typeof v === 'string' && v.trim().length > 0);
        secrets = [...secrets, ...extracted];
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
    const secrets = Object.values(inputs).filter((v) => typeof v === 'string' && v.trim().length > 0);

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

    let trialResult;
    try {
      trialResult = await player.playDraftForVerification(workflowId, inputs, {
        allowLocalhost: isLocalhostAllowed,
      });
    } finally {
      if (!this.browserRuntime) {
        await player.close();
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

    let secrets = [...customSecrets];
    if (directInputs && typeof directInputs === 'object') {
      const extracted = Object.values(directInputs).filter((v) => typeof v === 'string' && v.trim().length > 0);
      secrets = [...secrets, ...extracted];
    } else if (inputsPath) {
      try {
        const loaded = await loadInputs(inputsPath);
        const extracted = Object.values(loaded).filter((v) => typeof v === 'string' && v.trim().length > 0);
        secrets = [...secrets, ...extracted];
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
  async play(workflowId, { inputsPath, inputs: directInputs, allowLocalhost, headless } = {}) {
    if (!workflowId) {
      throw new WorkflowError('Missing workflow ID for play command.');
    }

    const inputs = directInputs || (await loadInputs(inputsPath));
    const isLocalhostAllowed = allowLocalhost ?? this.allowLocalhost;
    const isHeadless = headless ?? this.headless;

    const player = new WorkflowPlayer({
      repository: this.repo,
      browserRuntime: this.browserRuntime,
      allowLocalhost: isLocalhostAllowed,
      headless: isHeadless,
    });

    try {
      this.write(`Executing active verified version for workflow "${workflowId}"...`);
      const result = await player.play(workflowId, inputs, { allowLocalhost: isLocalhostAllowed });
      if (result.ok) {
        this.write(`Playback succeeded! Active version v${result.version} finished in ${result.durationMs}ms.`);
      } else {
        this.write(`Playback failed: active version v${result.version} encountered an error: ${result.error}`);
      }
      return result;
    } finally {
      if (!this.browserRuntime) {
        await player.close();
      }
    }
  }

  /**
   * Helper: Model-assisted failure diagnosis and unapproved draft proposal generation
   */
  async repair(workflowId, { inputsPath, inputs: directInputs, provider, allowLocalhost, headless } = {}) {
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
    const secrets = Object.values(inputs).filter((v) => typeof v === 'string' && v.trim().length > 0);

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

    this.write(`Active version playback failed: ${runResult.error}`);
    this.write('Collecting failure diagnostics and DOM snapshot...');

    const failedStep = activeVersion.steps?.find((s) => s.id === runResult.failedStepId) || null;
    const diagnostic = await collectFailureDiagnostic({
      workflowId,
      version: activeVersion.version,
      error: runResult.error,
      failedStep,
      session: null,
      secrets,
    });

    this.write(`Failure Category: ${diagnostic.category}`);
    this.write('Generating repair proposal using Meta reasoning model...');

    const modelProvider = provider || this.modelProvider || getPreferredRecoveryProvider();
    const proposalResult = await generateRepairProposal(modelProvider, diagnostic, activeVersion);
    const proposal = proposalResult.proposal;

    this.write(`Proposal received for step "${proposal.stepId}": ${proposal.suspectedCause}`);
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
        'evidence': { type: 'string' },
        'evidence-out': { type: 'string' },
        'confirm': { type: 'string' },
        'yes': { type: 'boolean', short: 'y' },
        'allow-localhost': { type: 'boolean' },
        'headless': { type: 'boolean', default: true },
        'enabled-only': { type: 'boolean' },
        'provider': { type: 'string' },
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
      this.repo = new FileSystemWorkflowRepository({ baseDir: this.workflowsDir });
    }

    const command = positionals[0];
    const targetId = positionals[1];

    try {
      switch (command) {
        case 'list':
        case 'ls':
          await this.list({ enabledOnly: Boolean(values['enabled-only']) });
          return 0;

        case 'inspect':
          if (!targetId) {
            this.writeErr('Error: Missing required argument <workflowId> for "inspect".');
            return 1;
          }
          await this.inspect(targetId);
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
Super Memory — Operator CLI for Intelligent Recovery

Usage:
  super-memory <command> [workflowId] [options]

Commands:
  list                          List all workflows and their active/draft status
  inspect <workflowId>          Inspect details, active version, draft, and verification state
  review <workflowId>           Review proposed repair diff between active version and draft
  trial <workflowId>            Execute draft in trial mode with provided inputs
  promote <workflowId>          Explicitly promote verified draft to active verified version
  play <workflowId>             Execute active verified workflow version
  repair <workflowId>           Diagnose failure and generate unapproved repair draft via Meta model

Options:
  --workflows-dir, -w <path>    Workflow repository root directory (default: ./workflows)
  --inputs, -i <path>           JSON file containing workflow runtime inputs
  --evidence <path>             Path to trial verification evidence (for promote)
  --evidence-out <path>         Path to write trial verification evidence (for trial)
  --confirm <phrase>            Operator confirmation phrase (PROMOTE <workflowId>)
  --yes, -y                     Accept confirmation non-interactively
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
