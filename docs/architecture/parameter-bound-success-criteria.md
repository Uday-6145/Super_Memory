# Parameter-Bound Success Criteria (schemaVersion 1.1.0)

Status: implemented. This document describes how a workflow verifies the
actual requested runtime value (for example the specific product added to a
cart) without creating a separate workflow per value.

## Representation

Under `schemaVersion: "1.0.0"`, success criteria values are literal strings:

```json
{
  "schemaVersion": "1.0.0",
  "successCriteria": {
    "finalPath": "/cart",
    "textPresent": "Paneer Toast"
  }
}
```

Under `schemaVersion: "1.1.0"`, the `pageTitle`, `textPresent`, and
`textAbsent` criteria may instead be a value-source object that references a
declared workflow input:

```json
{
  "schemaVersion": "1.1.0",
  "inputs": [
    { "name": "search_item", "type": "string", "label": "Search Item", "required": true }
  ],
  "successCriteria": {
    "finalPath": "/cart",
    "textPresent": { "input": "search_item" }
  }
}
```

Rules:

- The object form is exactly `{"input": "<declared-input-name>"}`. No other
  keys are allowed. It is inert data, never parsed as a template.
- `finalPath` remains literal-only. Navigation targets are never
  input-driven.
- References are valid only under `1.1.0`. A `1.0.0` workflow containing a
  reference is rejected. A `1.1.0` workflow may mix literals and references.
- References must name an input declared in the same workflow version.
  Validation rejects undeclared references at schema validation, at
  task-intent validation, at candidate construction, and (by validated input
  checking) at playback.
- Step-level `verification.expected` remains literal-only.

The same representation is used in task intents during discovery:
`{"type": "textPresent", "input": "search_item"}` alongside literal
`{"type": "finalPath", "expected": "/cart"}`.

## Resolution and data flow

1. Effective runtime inputs are established once. During discovery, the
   TaskIntent parameters and any separately supplied runtime inputs
   (`--inputs` file or direct inputs) are reconciled by
   `resolveEffectiveInputs`: undeclared runtime inputs, non-string values,
   and conflicting non-empty values are rejected with an error that names
   the input, never its value. The reconciled values then drive lookup,
   discovery, secret redaction, and playback identically.
2. At playback and during discovery, references are resolved locally from
   the validated runtime inputs inside the trusted runtime
   (`resolveSuccessCriteria`). A preflight check runs immediately after
   ordinary runtime-input validation and before any browser session is
   created: missing, empty, or non-string referenced values fail closed
   there, so no workflow action can execute with an unverifiable outcome.
   The evaluation-time resolution remains as a defense-in-depth backstop.
3. Raw page evidence is evaluated locally. Resolved values are runtime
   secrets: they are covered by the existing secret-redaction lists and
   never appear in model requests, journals, diagnostics, evidence, CLI
   output, or error messages. Verification evidence records booleans only
   (`textPresentFound`, etc.), never matched content.
4. The content hash covers the criteria verbatim, including reference
   objects and `schemaVersion`. Runtime values are not part of the workflow
   definition, so the same version verifies any supplied product.

## Lookup semantics

Structural matching and runtime-value resolution are separate:

- A saved `{"input": "search_item"}` criterion structurally matches a
  request condition bound to the same input name, so one parameterized
  workflow matches both `Paneer Toast` and `Fresh Paneer Pizza` requests
  when the corresponding input is supplied.
- Against a literal request condition, the saved reference is resolved with
  the request's own parameter values and the resolved literals are
  compared.
- A saved literal (for example `Paneer Toast`) matches only the request's
  resolved literal value. A literal `Paneer Toast` workflow does not match
  a `Fresh Paneer Pizza` request.

## Reference authorization

- Structured intents (`--intent`, API objects) are validated
  deterministically: references must name declared task parameters.
- Natural-language parsing is stricter: the model may bind a condition only
  to a caller-supplied fixed parameter (from `--inputs` / declared
  parameters). Model-invented references are rejected; the operator is
  directed to provide the input or a literal condition.
- Candidate construction only converts validated intent conditions; the
  model never writes workflow criteria directly.

## Backward compatibility

- Existing `1.0.0` workflows are unchanged: literal criteria validate, hash,
  play back, and promote exactly as before. Repository creation defaults to
  `1.0.0`; purely literal discovered candidates remain `1.0.0`.
- Branching or updating a `1.1.0` draft preserves its schema version.
  Verified-version immutability, hash revalidation at playback, genuine
  trial evidence, and explicit promotion are unchanged.
- Already-promoted workflows (for example literal-criteria workflows in
  scratch repositories) are not modified or migrated. Parameterized
  workflows should be created and trialed in a separate scratch repository.

## Limitations

- Criterion matching remains substring-based and case-sensitive, as with
  literal criteria. Whitespace or casing differences in page text fail
  closed rather than matching loosely.
- Tooling that only understands `1.0.0` cannot read `1.1.0` drafts; there is
  a single codebase in this repository, so this is a version-skew note for
  external consumers, not an in-repo migration.
- A referenced optional input that is not supplied (or is empty) fails a
  preflight check before any browser session or workflow action begins, in
  both playback and discovery. It is never treated as an empty-string match
  and the criterion is never silently skipped.
