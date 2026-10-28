/**
 * Super Memory — Filesystem Workflow Repository Unit & Integration Tests
 *
 * Validates:
 * - Lifecycle: initialization, creation, draft branching, updating, deleting
 * - Immutability: verified versions and evidence cannot be mutated or deleted
 * - Promotion & Crash Boundaries: crash-safe ordering; unverified versions never runnable
 * - Version Allocation: scans disk to ensure occupied/orphaned versions are never overwritten
 * - Corruption Handling: direct reads throw CorruptRecordError; list() returns diagnostic summaries
 * - Concurrency: per-workflow lock serializes mutations safely
 * - Path Traversal Safety: rejects dangerous paths and preserves directory boundaries
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  FileSystemWorkflowRepository,
  WorkflowError,
  WorkflowValidationError,
  InvalidWorkflowIdError,
  ImmutableVersionError,
  VersionConflictError,
  CorruptRecordError,
  WorkflowNotFoundError,
  calculateContentHash,
} from '../../src/workflow/index.js';

function createSampleWorkflowParams(id = 'wf_checkout_flow') {
  return {
    id,
    name: 'Checkout Flow',
    description: 'Automates customer checkout on store.',
    target: {
      origin: 'http://127.0.0.1:8080',
      startPath: '/checkout',
    },
    inputs: [
      {
        name: 'itemCode',
        type: 'string',
        label: 'Item Code',
        description: 'SKU to add',
        required: true,
      },
    ],
    steps: [
      {
        id: 'step_1',
        order: 1,
        description: 'Click Cart button',
        action: 'clickByRole',
        params: {
          role: 'button',
          name: 'Cart',
          exact: true,
          timeoutMs: 10000,
        },
        anchor: {
          role: 'button',
          name: 'Cart',
          tag: 'button',
          type: 'button',
        },
        verification: {
          type: 'textPresent',
          expected: 'Cart Panel',
        },
      },
      {
        id: 'step_2',
        order: 2,
        description: 'Fill item SKU',
        action: 'fillByLabel',
        params: {
          label: 'SKU Input',
          inputName: 'itemCode',
          exact: false,
          timeoutMs: 10000,
        },
        anchor: null,
        verification: null,
      },
    ],
    successCriteria: {
      finalPath: '/checkout',
      textPresent: 'Order Submitted',
    },
  };
}

function createSampleEvidence(versionObj) {
  const contentHash = calculateContentHash(versionObj);
  return {
    $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
    schemaVersion: '1.0.0',
    workflowId: versionObj.workflowId,
    version: versionObj.version,
    contentHash,
    runId: 'run_20261027_164500_abc123',
    verifiedAt: '2026-10-27T16:45:00.000Z',
    environment: {
      targetOrigin: 'http://127.0.0.1:8080',
      browserEngine: 'chromium',
      playwrightVersion: '1.64.1',
      nodeVersion: 'v22.19.0',
      platform: 'darwin-arm64',
    },
    stepResults: [
      {
        stepId: 'step_1',
        action: 'clickByRole',
        ok: true,
        durationMs: 45,
        verification: { type: 'textPresent', passed: true },
      },
      {
        stepId: 'step_2',
        action: 'fillByLabel',
        ok: true,
        durationMs: 30,
        verification: null,
      },
    ],
    successCriteriaResult: {
      passed: true,
      finalPath: '/checkout',
      textPresentFound: true,
    },
  };
}

describe('FileSystemWorkflowRepository', () => {
  let tempBaseDir;
  let repo;

  beforeEach(async () => {
    tempBaseDir = path.join(os.tmpdir(), `super-memory-repo-test-${randomUUID()}`);
    repo = new FileSystemWorkflowRepository({ baseDir: tempBaseDir });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Constructor & Initialization', () => {
    it('requires a valid baseDir string', () => {
      assert.throws(
        () => new FileSystemWorkflowRepository({}),
        (err) => err instanceof WorkflowError && err.message.includes('baseDir')
      );
      assert.throws(
        () => new FileSystemWorkflowRepository({ baseDir: '' }),
        (err) => err instanceof WorkflowError
      );
    });

    it('resolves baseDir to absolute path', () => {
      assert.ok(path.isAbsolute(repo.baseDir));
    });

    it('creates baseDir lazily on init()', async () => {
      await repo.init();
      const stat = await fs.stat(tempBaseDir);
      assert.ok(stat.isDirectory());
    });
  });

  describe('Workflow Creation', () => {
    it('creates initial draft version 1 and manifest.json', async () => {
      const params = createSampleWorkflowParams('wf_init_test');
      const { manifest, version } = await repo.createWorkflow(params);

      assert.equal(manifest.id, 'wf_init_test');
      assert.equal(manifest.activeVersion, null);
      assert.equal(manifest.draftVersion, 1);
      assert.equal(manifest.enabled, true);

      assert.equal(version.workflowId, 'wf_init_test');
      assert.equal(version.version, 1);
      assert.equal(version.status, 'draft');
      assert.equal(version.parentVersion, null);

      // Verify files created on disk
      const manifestOnDisk = await repo.getManifest('wf_init_test');
      assert.deepEqual(manifestOnDisk, manifest);

      const versionOnDisk = await repo.getVersion('wf_init_test', 1);
      assert.deepEqual(versionOnDisk, version);
    });

    it('rejects invalid workflow IDs', async () => {
      const invalidIds = ['INVALID_UPPERCASE', 'wf/slash', 'wf..dots', '', '   '];
      for (const id of invalidIds) {
        await assert.rejects(
          async () => repo.createWorkflow(createSampleWorkflowParams(id)),
          (err) => err instanceof InvalidWorkflowIdError || err instanceof WorkflowValidationError
        );
      }
    });

    it('rejects duplicate workflow creation', async () => {
      const params = createSampleWorkflowParams('wf_dup_test');
      await repo.createWorkflow(params);

      await assert.rejects(
        async () => repo.createWorkflow(params),
        (err) => err instanceof WorkflowError && err.code === 'WORKFLOW_ALREADY_EXISTS'
      );
    });

    it('rejects creation if orphaned version files exist on disk', async () => {
      const wfDir = path.join(tempBaseDir, 'wf_orphan_test', 'versions');
      await fs.mkdir(wfDir, { recursive: true });
      await fs.writeFile(path.join(wfDir, '1.json'), '{}');

      await assert.rejects(
        async () => repo.createWorkflow(createSampleWorkflowParams('wf_orphan_test')),
        (err) => err instanceof WorkflowError && err.code === 'ORPHANED_FILES_EXIST'
      );
    });

    it('rejects creation if orphaned verification files exist on disk', async () => {
      const verDir = path.join(tempBaseDir, 'wf_ver_orphan', 'verifications');
      await fs.mkdir(verDir, { recursive: true });
      await fs.writeFile(path.join(verDir, '1.evidence.json'), '{}');

      await assert.rejects(
        async () => repo.createWorkflow(createSampleWorkflowParams('wf_ver_orphan')),
        (err) => err instanceof WorkflowError && err.code === 'ORPHANED_FILES_EXIST'
      );
    });
  });

  describe('Reading Operations', () => {
    it('returns null for non-existent manifest', async () => {
      const result = await repo.getManifest('wf_nonexistent');
      assert.equal(result, null);
    });

    it('returns null for non-existent version', async () => {
      const result = await repo.getVersion('wf_nonexistent', 1);
      assert.equal(result, null);
    });

    it('returns null when querying active version on draft-only workflow', async () => {
      await repo.createWorkflow(createSampleWorkflowParams('wf_draft_only'));
      const active = await repo.getVersion('wf_draft_only');
      assert.equal(active, null);
    });

    it('returns null for non-existent verification evidence', async () => {
      await repo.createWorkflow(createSampleWorkflowParams('wf_no_evidence'));
      const evidence = await repo.getVerificationEvidence('wf_no_evidence', 1);
      assert.equal(evidence, null);
    });
  });

  describe('Verification & Promotion Lifecycle', () => {
    it('promotes draft to verified status with valid evidence and updates activeVersion', async () => {
      const { version: draftVersion } = await repo.createWorkflow(createSampleWorkflowParams('wf_verify_test'));
      const evidence = createSampleEvidence(draftVersion);

      const result = await repo.markVerified('wf_verify_test', 1, evidence);

      assert.equal(result.manifest.activeVersion, 1);
      assert.equal(result.manifest.draftVersion, null);
      assert.equal(result.version.status, 'verified');

      // Verify active version retrieval without explicit version number
      const activeVersion = await repo.getVersion('wf_verify_test');
      assert.equal(activeVersion.version, 1);
      assert.equal(activeVersion.status, 'verified');

      // Verify evidence retrieval
      const storedEvidence = await repo.getVerificationEvidence('wf_verify_test', 1);
      assert.deepEqual(storedEvidence, evidence);
    });

    it('rejects verification with mismatched content hash in evidence', async () => {
      const { version: draftVersion } = await repo.createWorkflow(createSampleWorkflowParams('wf_hash_mismatch'));
      const evidence = createSampleEvidence(draftVersion);
      evidence.contentHash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

      await assert.rejects(
        async () => repo.markVerified('wf_hash_mismatch', 1, evidence),
        (err) => err instanceof WorkflowValidationError && err.message.includes('contentHash')
      );

      // Verify state was untouched
      const manifest = await repo.getManifest('wf_hash_mismatch');
      assert.equal(manifest.activeVersion, null);
      assert.equal(manifest.draftVersion, 1);
    });

    it('rejects verification if any stepResult failed (ok: false)', async () => {
      const { version: draftVersion } = await repo.createWorkflow(createSampleWorkflowParams('wf_failed_step'));
      const evidence = createSampleEvidence(draftVersion);
      evidence.stepResults[0].ok = false;
      await assert.rejects(
        async () => repo.markVerified('wf_failed_step', 1, evidence),
        (err) => err instanceof WorkflowValidationError
      );
    });

    it('rejects markVerified when version is already active and verified', async () => {
      const { version: draftVersion } = await repo.createWorkflow(createSampleWorkflowParams('wf_already_verified'));
      const evidence = createSampleEvidence(draftVersion);
      await repo.markVerified('wf_already_verified', 1, evidence);

      await assert.rejects(
        async () => repo.markVerified('wf_already_verified', 1, evidence),
        (err) => err instanceof ImmutableVersionError && err.code === 'IMMUTABLE_VERSION'
      );
    });

    it('rejects markVerified on non-existent version', async () => {
      const { version: v1 } = await repo.createWorkflow(createSampleWorkflowParams('wf_nonexist_ver'));
      const dummyEvidence = createSampleEvidence(v1);

      await assert.rejects(
        async () => repo.markVerified('wf_nonexist_ver', 99, dummyEvidence),
        (err) => err instanceof WorkflowNotFoundError && err.code === 'WORKFLOW_NOT_FOUND'
      );
    });
  });

  describe('Draft Branching & Version Immutability', () => {
    it('branches a new draft version from active verified version', async () => {
      const { version: v1 } = await repo.createWorkflow(createSampleWorkflowParams('wf_branch_test'));
      await repo.markVerified('wf_branch_test', 1, createSampleEvidence(v1));

      // Branch v2 draft
      const v2Draft = await repo.createDraftVersion('wf_branch_test', {
        changeSummary: 'Update checkout steps.',
        steps: [
          {
            id: 'step_1',
            order: 1,
            description: 'Click New Cart button',
            action: 'clickByRole',
            params: { role: 'button', name: 'New Cart', exact: true, timeoutMs: 10000 },
            anchor: null,
            verification: null,
          },
        ],
      });

      assert.equal(v2Draft.version, 2);
      assert.equal(v2Draft.parentVersion, 1);
      assert.equal(v2Draft.status, 'draft');

      const manifest = await repo.getManifest('wf_branch_test');
      assert.equal(manifest.activeVersion, 1, 'Active version must remain 1 while draft 2 is prepared');
      assert.equal(manifest.draftVersion, 2);

      // Verify v1 record remains unchanged and verified
      const v1OnDisk = await repo.getVersion('wf_branch_test', 1);
      assert.equal(v1OnDisk.status, 'verified');
    });

    it('rejects branching when an active draft already exists', async () => {
      const { version: v1 } = await repo.createWorkflow(createSampleWorkflowParams('wf_branch_conflict'));
      await repo.markVerified('wf_branch_conflict', 1, createSampleEvidence(v1));

      await repo.createDraftVersion('wf_branch_conflict');

      // Second attempt to branch while draft exists must fail
      await assert.rejects(
        async () => repo.createDraftVersion('wf_branch_conflict'),
        (err) => err instanceof VersionConflictError && err.code === 'VERSION_CONFLICT'
      );
    });

    it('rejects branching if workflow has no active verified version', async () => {
      await repo.createWorkflow(createSampleWorkflowParams('wf_no_active_branch'));

      // Workflow only has draft 1, no activeVersion
      // First delete draft 1 to test empty state branch
      await repo.deleteDraftVersion('wf_no_active_branch', 1);

      await assert.rejects(
        async () => repo.createDraftVersion('wf_no_active_branch'),
        (err) => err instanceof WorkflowError && err.code === 'NO_ACTIVE_VERSION'
      );
    });

    it('updates draft version definition and preserves verified version', async () => {
      const { version: v1 } = await repo.createWorkflow(createSampleWorkflowParams('wf_update_draft'));
      await repo.markVerified('wf_update_draft', 1, createSampleEvidence(v1));
      await repo.createDraftVersion('wf_update_draft');

      const updated = await repo.updateDraftVersion('wf_update_draft', 2, {
        changeSummary: 'Refined checkout steps.',
      });

      assert.equal(updated.changeSummary, 'Refined checkout steps.');
      assert.equal(updated.version, 2);
      assert.equal(updated.status, 'draft');

      // Attempting to update verified version 1 must throw ImmutableVersionError
      await assert.rejects(
        async () => repo.updateDraftVersion('wf_update_draft', 1, { changeSummary: 'Illegal edit' }),
        (err) => err instanceof ImmutableVersionError
      );
    });

    it('deletes draft version and resets manifest draftVersion', async () => {
      const { version: v1 } = await repo.createWorkflow(createSampleWorkflowParams('wf_delete_draft'));
      await repo.markVerified('wf_delete_draft', 1, createSampleEvidence(v1));
      await repo.createDraftVersion('wf_delete_draft');

      const deleteRes = await repo.deleteDraftVersion('wf_delete_draft', 2);
      assert.equal(deleteRes.deleted, true);

      const manifest = await repo.getManifest('wf_delete_draft');
      assert.equal(manifest.draftVersion, null);
      assert.equal(manifest.activeVersion, 1);

      const v2 = await repo.getVersion('wf_delete_draft', 2);
      assert.equal(v2, null);

      // Attempting to delete verified version 1 must throw ImmutableVersionError
      await assert.rejects(
        async () => repo.deleteDraftVersion('wf_delete_draft', 1),
        (err) => err instanceof ImmutableVersionError
      );
    });
  });

  describe('Occupied & Orphaned Version Protection', () => {
    it('detects orphaned files on disk and allocates strictly higher version numbers', async () => {
      const { version: v1 } = await repo.createWorkflow(createSampleWorkflowParams('wf_orphan_alloc'));
      await repo.markVerified('wf_orphan_alloc', 1, createSampleEvidence(v1));

      // Simulate an orphaned version file "versions/5.json" created by an abandoned tool/script
      const versionsDir = path.join(tempBaseDir, 'wf_orphan_alloc', 'versions');
      await fs.writeFile(
        path.join(versionsDir, '5.json'),
        JSON.stringify({ ...v1, version: 5, status: 'draft' }, null, 2)
      );

      // createDraftVersion should inspect disk and allocate version 6, avoiding 5!
      const newDraft = await repo.createDraftVersion('wf_orphan_alloc');
      assert.equal(newDraft.version, 6);

      // The orphaned 5.json must be intact and not overwritten
      const orphaned5 = JSON.parse(await fs.readFile(path.join(versionsDir, '5.json'), 'utf8'));
      assert.equal(orphaned5.version, 5);
    });

    it('detects orphaned verification files on disk and avoids occupied version numbers', async () => {
      const { version: v1 } = await repo.createWorkflow(createSampleWorkflowParams('wf_ver_orphan_alloc'));
      await repo.markVerified('wf_ver_orphan_alloc', 1, createSampleEvidence(v1));

      // Simulate an orphaned verification file "verifications/3.evidence.json"
      const verDir = path.join(tempBaseDir, 'wf_ver_orphan_alloc', 'verifications');
      await fs.writeFile(
        path.join(verDir, '3.evidence.json'),
        JSON.stringify({ orphaned: true }, null, 2)
      );

      // createDraftVersion should allocate 4 to avoid colliding with occupied 3
      const newDraft = await repo.createDraftVersion('wf_ver_orphan_alloc');
      assert.equal(newDraft.version, 4);
    });
  });

  describe('Multi-File Crash / Failure Boundary Safety', () => {
    it('never exposes partially promoted workflow as runnable if manifest write is interrupted', async () => {
      const { version: v1 } = await repo.createWorkflow(createSampleWorkflowParams('wf_crash_boundary'));
      await repo.markVerified('wf_crash_boundary', 1, createSampleEvidence(v1));

      // Branch v2
      const v2 = await repo.createDraftVersion('wf_crash_boundary');
      const v2Evidence = createSampleEvidence(v2);

      // Simulate partial write of promotion: write evidence and sealed version 2 file,
      // but DO NOT update manifest.json (simulating crash before manifest update)
      const verPath = path.join(tempBaseDir, 'wf_crash_boundary', 'verifications', '2.evidence.json');
      const v2Path = path.join(tempBaseDir, 'wf_crash_boundary', 'versions', '2.json');
      await fs.writeFile(verPath, JSON.stringify(v2Evidence, null, 2));
      await fs.writeFile(v2Path, JSON.stringify({ ...v2, status: 'verified' }, null, 2));

      // Check operational runnable status:
      // Manifest activeVersion MUST STILL BE 1!
      const manifest = await repo.getManifest('wf_crash_boundary');
      assert.equal(manifest.activeVersion, 1);
      assert.equal(manifest.draftVersion, 2);

      // getVersion(id) returns active version -> MUST BE version 1!
      const runnableVersion = await repo.getVersion('wf_crash_boundary');
      assert.equal(runnableVersion.version, 1);

      // Recovery: Calling markVerified with matching evidence completes the interrupted promotion cleanly
      const recoveryResult = await repo.markVerified('wf_crash_boundary', 2, v2Evidence);
      assert.equal(recoveryResult.manifest.activeVersion, 2);
      assert.equal(recoveryResult.manifest.draftVersion, null);

      const finalActive = await repo.getVersion('wf_crash_boundary');
      assert.equal(finalActive.version, 2);
    });

    it('recovers safely when markVerified is interrupted after evidence write but before version sealing', async () => {
      const { version: v1 } = await repo.createWorkflow(createSampleWorkflowParams('wf_step1_crash'));
      await repo.markVerified('wf_step1_crash', 1, createSampleEvidence(v1));

      const v2 = await repo.createDraftVersion('wf_step1_crash');
      const v2Evidence = createSampleEvidence(v2);

      // Simulate crash after Step 1: evidence file is written, but version 2 remains draft
      const verPath = path.join(tempBaseDir, 'wf_step1_crash', 'verifications', '2.evidence.json');
      await fs.writeFile(verPath, JSON.stringify(v2Evidence, null, 2));

      // Active runnable version must still be version 1
      const runnable = await repo.getVersion('wf_step1_crash');
      assert.equal(runnable.version, 1);

      // Retry markVerified: recovers cleanly and promotes v2
      const recoveryResult = await repo.markVerified('wf_step1_crash', 2, v2Evidence);
      assert.equal(recoveryResult.manifest.activeVersion, 2);
      assert.equal(recoveryResult.manifest.draftVersion, null);
      assert.equal(recoveryResult.version.status, 'verified');

      const finalActive = await repo.getVersion('wf_step1_crash');
      assert.equal(finalActive.version, 2);
    });

    it('rejects markVerified recovery if persisted version file was tampered with after partial write', async () => {
      const { version: v1 } = await repo.createWorkflow(createSampleWorkflowParams('wf_tamper_crash'));
      await repo.markVerified('wf_tamper_crash', 1, createSampleEvidence(v1));

      const v2 = await repo.createDraftVersion('wf_tamper_crash');
      const v2Evidence = createSampleEvidence(v2);

      // Simulate crash after Step 2: evidence written, version sealed
      const verPath = path.join(tempBaseDir, 'wf_tamper_crash', 'verifications', '2.evidence.json');
      const v2Path = path.join(tempBaseDir, 'wf_tamper_crash', 'versions', '2.json');
      await fs.writeFile(verPath, JSON.stringify(v2Evidence, null, 2));

      // Tamper with the persisted version file
      const tamperedV2 = {
        ...v2,
        status: 'verified',
        target: { origin: 'http://127.0.0.1:8080', startPath: '/tampered-path' },
      };
      await fs.writeFile(v2Path, JSON.stringify(tamperedV2, null, 2));

      // Recovery attempt with original evidence must reject due to hash mismatch!
      await assert.rejects(
        async () => repo.markVerified('wf_tamper_crash', 2, v2Evidence),
        (err) => err instanceof WorkflowValidationError && err.message.includes('contentHash')
      );

      // Manifest activeVersion must remain 1 (tampered version NEVER promoted!)
      const manifest = await repo.getManifest('wf_tamper_crash');
      assert.equal(manifest.activeVersion, 1);
    });

    it('recovers cleanly when deleteDraftVersion is interrupted after file removal before manifest update', async () => {
      const { version: v1 } = await repo.createWorkflow(createSampleWorkflowParams('wf_del_crash'));
      await repo.markVerified('wf_del_crash', 1, createSampleEvidence(v1));

      // Branch v2 draft
      await repo.createDraftVersion('wf_del_crash');
      const manifestBefore = await repo.getManifest('wf_del_crash');
      assert.equal(manifestBefore.draftVersion, 2);

      // Simulate crash during deleteDraftVersion: unlink versions/2.json directly
      const v2Path = path.join(tempBaseDir, 'wf_del_crash', 'versions', '2.json');
      await fs.unlink(v2Path);

      // Verify file is missing but manifest still points to draftVersion 2
      assert.equal(await repo.getVersion('wf_del_crash', 2), null);
      assert.equal((await repo.getManifest('wf_del_crash')).draftVersion, 2);

      // Retry deleteDraftVersion: must heal the dangling pointer rather than throwing WorkflowNotFoundError
      const deleteResult = await repo.deleteDraftVersion('wf_del_crash', 2);
      assert.equal(deleteResult.deleted, true);
      assert.equal(deleteResult.versionNumber, 2);

      const manifestAfter = await repo.getManifest('wf_del_crash');
      assert.equal(manifestAfter.draftVersion, null);
      assert.equal(manifestAfter.activeVersion, 1);

      // Caller can now safely branch a new draft without VersionConflictError!
      const newDraft = await repo.createDraftVersion('wf_del_crash');
      assert.equal(newDraft.version, 2);
    });
  });

  describe('Enable / Disable State & List Operations', () => {
    it('toggles enabled state in manifest without modifying version records', async () => {
      const { version: v1 } = await repo.createWorkflow(createSampleWorkflowParams('wf_toggle_enable'));
      await repo.markVerified('wf_toggle_enable', 1, createSampleEvidence(v1));

      const v1Before = await repo.getVersion('wf_toggle_enable', 1);

      // Disable workflow
      const disabledManifest = await repo.setEnabled('wf_toggle_enable', false);
      assert.equal(disabledManifest.enabled, false);

      const v1After = await repo.getVersion('wf_toggle_enable', 1);
      assert.deepEqual(v1Before, v1After, 'Version record must remain completely identical');

      // Re-enable workflow
      const enabledManifest = await repo.setEnabled('wf_toggle_enable', true);
      assert.equal(enabledManifest.enabled, true);
    });

    it('filters enabled workflows with list({ enabledOnly: true })', async () => {
      await repo.createWorkflow(createSampleWorkflowParams('wf_enabled_1'));
      await repo.createWorkflow(createSampleWorkflowParams('wf_disabled_2'));
      await repo.setEnabled('wf_disabled_2', false);

      const all = await repo.list();
      assert.equal(all.length, 2);

      const enabledOnly = await repo.list({ enabledOnly: true });
      assert.equal(enabledOnly.length, 1);
      assert.equal(enabledOnly[0].id, 'wf_enabled_1');
    });
  });

  describe('Corruption Handling', () => {
    it('getManifest throws CorruptRecordError on corrupt JSON', async () => {
      await repo.createWorkflow(createSampleWorkflowParams('wf_corrupt_json'));
      const manifestPath = path.join(tempBaseDir, 'wf_corrupt_json', 'manifest.json');
      await fs.writeFile(manifestPath, '{ invalid json content ...');

      await assert.rejects(
        async () => repo.getManifest('wf_corrupt_json'),
        (err) => err instanceof CorruptRecordError && err.code === 'CORRUPT_RECORD'
      );

      // Ensure corrupt file was preserved on disk for diagnosis
      const rawContent = await fs.readFile(manifestPath, 'utf8');
      assert.ok(rawContent.startsWith('{ invalid json'));
    });

    it('getManifest throws CorruptRecordError on schema validation violation', async () => {
      await repo.createWorkflow(createSampleWorkflowParams('wf_corrupt_schema'));
      const manifestPath = path.join(tempBaseDir, 'wf_corrupt_schema', 'manifest.json');
      await fs.writeFile(manifestPath, JSON.stringify({ invalidField: 'illegal' }, null, 2));

      await assert.rejects(
        async () => repo.getManifest('wf_corrupt_schema'),
        (err) => err instanceof CorruptRecordError && err.code === 'CORRUPT_RECORD'
      );
    });

    it('getVersion throws CorruptRecordError on corrupt version file', async () => {
      await repo.createWorkflow(createSampleWorkflowParams('wf_corrupt_ver'));
      const verPath = path.join(tempBaseDir, 'wf_corrupt_ver', 'versions', '1.json');
      await fs.writeFile(verPath, 'not json at all');

      await assert.rejects(
        async () => repo.getVersion('wf_corrupt_ver', 1),
        (err) => err instanceof CorruptRecordError && err.code === 'CORRUPT_RECORD'
      );

      // File preserved
      assert.equal(await fs.readFile(verPath, 'utf8'), 'not json at all');
    });

    it('getVerificationEvidence throws CorruptRecordError on corrupt evidence file', async () => {
      const { version: v1 } = await repo.createWorkflow(createSampleWorkflowParams('wf_corrupt_evi'));
      await repo.markVerified('wf_corrupt_evi', 1, createSampleEvidence(v1));

      const eviPath = path.join(tempBaseDir, 'wf_corrupt_evi', 'verifications', '1.evidence.json');
      await fs.writeFile(eviPath, 'bad evidence data');

      await assert.rejects(
        async () => repo.getVerificationEvidence('wf_corrupt_evi', 1),
        (err) => err instanceof CorruptRecordError && err.code === 'CORRUPT_RECORD'
      );
    });

    it('list() returns diagnostic summaries for corrupt records without throwing', async () => {
      await repo.createWorkflow(createSampleWorkflowParams('wf_healthy'));
      await repo.createWorkflow(createSampleWorkflowParams('wf_broken'));

      // Corrupt one manifest
      const brokenManifest = path.join(tempBaseDir, 'wf_broken', 'manifest.json');
      await fs.writeFile(brokenManifest, '{ malformed');

      const results = await repo.list();
      assert.equal(results.length, 2);

      const healthy = results.find((r) => r.id === 'wf_healthy');
      assert.ok(healthy && !healthy.corrupt);
      assert.equal(healthy.enabled, true);

      const broken = results.find((r) => r.id === 'wf_broken');
      assert.ok(broken && broken.corrupt === true);
      assert.ok(typeof broken.error === 'string');
    });
  });

  describe('Concurrency & Lock Serialization', () => {
    it('serializes concurrent mutations on the same workflow without file corruption', async () => {
      const { version: v1 } = await repo.createWorkflow(createSampleWorkflowParams('wf_concurrency_test'));
      await repo.markVerified('wf_concurrency_test', 1, createSampleEvidence(v1));

      // Launch multiple simultaneous update calls (or setEnabled calls)
      const operations = Array.from({ length: 15 }, (_, i) =>
        repo.setEnabled('wf_concurrency_test', i % 2 === 0)
      );

      const results = await Promise.all(operations);
      assert.equal(results.length, 15);

      // Verify the final manifest is completely valid and reflects the last queued operation (14 % 2 === 0 -> true)
      const finalManifest = await repo.getManifest('wf_concurrency_test');
      assert.ok(finalManifest);
      assert.equal(typeof finalManifest.enabled, 'boolean');
      assert.equal(finalManifest.enabled, true);
    });

    it('enforces strict FIFO resolution on concurrent mutations', async () => {
      await repo.createWorkflow(createSampleWorkflowParams('wf_fifo_test'));

      const updates = [
        repo.updateDraftVersion('wf_fifo_test', 1, { changeSummary: 'update 1' }),
        repo.updateDraftVersion('wf_fifo_test', 1, { changeSummary: 'update 2' }),
        repo.updateDraftVersion('wf_fifo_test', 1, { changeSummary: 'update 3' }),
        repo.updateDraftVersion('wf_fifo_test', 1, { changeSummary: 'final update' }),
      ];

      await Promise.all(updates);

      const finalDraft = await repo.getVersion('wf_fifo_test', 1);
      assert.equal(finalDraft.changeSummary, 'final update');
    });

    it('continues lock queue execution when an earlier operation rejects', async () => {
      await repo.createWorkflow(createSampleWorkflowParams('wf_lock_err'));

      // Task 1 will fail because version 99 does not exist
      const task1 = repo.updateDraftVersion('wf_lock_err', 99, { changeSummary: 'fail' });

      // Task 2 should execute after task 1 fails
      const task2 = repo.setEnabled('wf_lock_err', false);

      await assert.rejects(
        async () => task1,
        (err) => err instanceof WorkflowNotFoundError
      );

      const manifest = await task2;
      assert.equal(manifest.enabled, false);

      const onDisk = await repo.getManifest('wf_lock_err');
      assert.equal(onDisk.enabled, false);
    });

    it('serializes mutations across multiple repository instances sharing the same baseDir', async () => {
      const repoA = new FileSystemWorkflowRepository({ baseDir: tempBaseDir });
      const repoB = new FileSystemWorkflowRepository({ baseDir: tempBaseDir });

      await repoA.createWorkflow(createSampleWorkflowParams('wf_multi_repo'));

      const operations = [
        repoA.setEnabled('wf_multi_repo', false),
        repoB.setEnabled('wf_multi_repo', true),
        repoA.setEnabled('wf_multi_repo', false),
        repoB.setEnabled('wf_multi_repo', true),
      ];

      const results = await Promise.all(operations);
      assert.equal(results.length, 4);

      const manifestA = await repoA.getManifest('wf_multi_repo');
      const manifestB = await repoB.getManifest('wf_multi_repo');

      assert.equal(manifestA.enabled, true);
      assert.deepEqual(manifestA, manifestB);
    });

    it('allows concurrent operations on distinct workflows without cross-blocking', async () => {
      const params1 = createSampleWorkflowParams('wf_concurrent_a');
      const params2 = createSampleWorkflowParams('wf_concurrent_b');

      const [res1, res2] = await Promise.all([
        repo.createWorkflow(params1),
        repo.createWorkflow(params2),
      ]);

      assert.equal(res1.manifest.id, 'wf_concurrent_a');
      assert.equal(res2.manifest.id, 'wf_concurrent_b');
    });
  });

  describe('Path Traversal & Security', () => {
    it('rejects path traversal attempts on all methods', async () => {
      const maliciousIds = ['../escape', '..', '/etc/passwd', 'foo/bar', 'foo\\bar'];

      for (const id of maliciousIds) {
        await assert.rejects(
          async () => repo.getManifest(id),
          (err) => err instanceof InvalidWorkflowIdError || err instanceof WorkflowValidationError
        );
        await assert.rejects(
          async () => repo.getVersion(id, 1),
          (err) => err instanceof InvalidWorkflowIdError || err instanceof WorkflowValidationError
        );
        await assert.rejects(
          async () => repo.createWorkflow(createSampleWorkflowParams(id)),
          (err) => err instanceof InvalidWorkflowIdError || err instanceof WorkflowValidationError
        );
      }
    });

    it('rejects symlink escape attempts pointing outside baseDir', async () => {
      await repo.init();
      const outsideDir = path.join(os.tmpdir(), `super-memory-outside-${randomUUID()}`);
      await fs.mkdir(outsideDir, { recursive: true });

      try {
        const symlinkPath = path.join(tempBaseDir, 'wf_symlink');
        await fs.symlink(outsideDir, symlinkPath);

        await assert.rejects(
          async () => repo.getManifest('wf_symlink'),
          (err) => err instanceof WorkflowValidationError && err.message.includes('Symlink escape detected')
        );

        await assert.rejects(
          async () => repo.createWorkflow(createSampleWorkflowParams('wf_symlink')),
          (err) => err instanceof WorkflowValidationError && err.message.includes('Symlink escape detected')
        );
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe('Temporary File Cleanup', () => {
    it('cleans stale temporary files while preserving active recent ones', async () => {
      await repo.createWorkflow(createSampleWorkflowParams('wf_temp_cleanup'));
      const versionsDir = path.join(tempBaseDir, 'wf_temp_cleanup', 'versions');

      const staleTmp = path.join(versionsDir, '.tmp_stale_123');
      const freshTmp = path.join(versionsDir, '.tmp_fresh_456');

      await fs.writeFile(staleTmp, 'stale temp data');
      await fs.writeFile(freshTmp, 'fresh temp data');

      // Backdate staleTmp mtime by 2 hours
      const twoHoursAgo = new Date(Date.now() - 7200000);
      await fs.utimes(staleTmp, twoHoursAgo, twoHoursAgo);

      // Run cleanStaleTempFiles with maxAgeMs = 1 hour (3600000 ms)
      const purged = await repo.cleanStaleTempFiles({ maxAgeMs: 3600000 });
      assert.equal(purged, 1);

      // Verify stale file was unlinked
      await assert.rejects(
        async () => fs.stat(staleTmp),
        (err) => err.code === 'ENOENT'
      );

      // Verify fresh file remains intact
      const freshStat = await fs.stat(freshTmp);
      assert.ok(freshStat.isFile());
    });
  });
});

