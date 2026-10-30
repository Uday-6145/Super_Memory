/**
 * Super Memory — Append-Only Audit Log
 *
 * Records significant managed-memory operations (import, promotion, backup,
 * restore) as JSON lines in <home>/audit.jsonl.
 *
 * Privacy contract: events are constructed only from the allow-listed fields
 * below. Runtime input values, passwords, page text, DOM snapshots, and model
 * prompts must never be passed to this module; unknown fields are stripped
 * on write as defense in depth.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const ALLOWED_FIELDS = [
  'type',
  'workflowId',
  'version',
  'contentHash',
  'source',
  'destination',
  'imported',
  'skipped',
  'backupId',
];

/**
 * Appends one audit event. Best-effort by design only at call sites that
 * explicitly catch; this function itself surfaces filesystem errors.
 *
 * @param {string} auditPath - Path to audit.jsonl
 * @param {object} event - Event with allow-listed fields
 * @returns {Promise<object>} The record as written
 */
export async function appendAuditEvent(auditPath, event) {
  const record = { timestamp: new Date().toISOString() };
  for (const field of ALLOWED_FIELDS) {
    if (event && event[field] !== undefined) {
      record[field] = event[field];
    }
  }
  if (typeof record.type !== 'string' || record.type.trim() === '') {
    throw new Error('Audit events require a non-empty "type".');
  }
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  await fs.appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

/**
 * Reads audit events back (read-only). Missing log means no events.
 *
 * @param {string} auditPath
 * @returns {Promise<object[]>}
 */
export async function readAuditEvents(auditPath) {
  let raw;
  try {
    raw = await fs.readFile(auditPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}
