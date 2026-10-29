# Super Memory

Super Memory is an adaptive AI browser agent that remembers verified workflows, checks website changes, and recovers when saved workflows become outdated.

## Core Goals

- **Verified Workflow Memory**: Remember verified workflows for high reliability and lower execution costs on repeated tasks.
- **Change Detection**: Proactively detect website layout and DOM modifications before executing saved workflows.
- **Self-Healing Recovery**: Intelligently adapt and recover when saved workflows break due to website drift.

---

## Model Provider Abstraction (`src/models/`)

Super Memory decouples high-level agent logic from specific LLM providers via a common text-completion interface:

```javascript
import { createModelProvider } from './src/models/index.js';

const provider = createModelProvider('baseten'); // or 'meta'
const result = await provider.complete({
  messages: [{ role: 'user', content: 'Navigate to target URL.' }],
  maxTokens: 200,
});

console.log(result.text);
console.log(result.provider);    // 'baseten' | 'meta'
console.log(result.model);       // effective model identifier
console.log(result.finishReason); // 'stop' | 'length' | null
console.log(result.isTruncated);  // true if cut off by token limit
console.log(result.usage);        // { inputTokens, outputTokens, totalTokens } | null
```

### Supported Providers

| Provider | Default Base URL | Default Model | Environment Variable |
| :--- | :--- | :--- | :--- |
| **Baseten** | `https://inference.baseten.co/v1` | `meta-models/muse-spark-open-1026` | `BASETEN_API_KEY` |
| **Meta** | `https://api.meta.ai/v1` | `muse-spark-1.3` | `META_API_KEY` |

---

## Browser Execution Foundation (`src/browser/`)

Super Memory includes a modular, hermetic browser runtime built directly on Playwright Chromium.

```javascript
import { createBrowserRuntime } from './src/browser/index.js';

const runtime = createBrowserRuntime({ headless: true });
const session = await runtime.createSession();

try {
  // Safe navigation with protocol, embedded credential, and loopback checks
  const nav = await session.navigate('https://example.com');
  console.log(`Loaded: ${nav.title} (${nav.status})`);

  // Bounded DOM snapshot (excludes passwords/form values and strips URL queries/fragments)
  const snapshot = await session.getSnapshot({ maxTextLength: 4000, maxElements: 50 });
  console.log('Visible elements:', snapshot.elements.length);

  // Accessible locator actions
  await session.fillByLabel({ label: 'Username', value: 'my_user' });
  await session.clickByRole({ role: 'button', name: 'Submit' });
} finally {
  await session.close();
  await runtime.close();
}
```

### Browser Architecture

- **`BrowserRuntime` (`src/browser/browser-runtime.js`)**: Manages the Chromium browser process lifecycle, handles process launch and safe idempotent shutdown, and tracks active sessions.
- **`BrowserSession` (`src/browser/browser-session.js`)**: Owns an isolated, ephemeral `BrowserContext` and `Page`. Enforces `http:`/`https:` protocol restrictions, rejects embedded credentials, blocks localhost/loopback by default, extracts bounded DOM summaries without capturing input values, and provides accessible locator actions (`clickByRole`, `fillByLabel`).
- **`BrowserError` hierarchy (`src/browser/errors.js`)**: Cleanly categorized errors (`NavigationError`, `ActionError`, `TimeoutError`) with sanitized messages.

### Browser Session Isolation & Security Guarantees

1. **Context Isolation:** Each `BrowserSession` receives a completely fresh, in-memory `BrowserContext`. Cookies, local storage, and cache are never shared between sessions.
2. **Zero Disk Persistence:** No sessions, storage state, or user profile directories are written to disk.
3. **No Personal Data Reuse:** The runtime strictly uses Playwright-managed Chromium and never attaches to or reads from the host machine's personal Chrome profile.
4. **Credential Protection:** Form field values, passwords (`<input type="password">`), cookies, and storage contents are strictly excluded from DOM snapshots. Page URLs (`snapshot.url`) and anchor targets (`href`) have query strings and hash fragments stripped to avoid accidental token or session leakage in snapshot metadata.
5. **Loopback Protection:** Navigation to loopback or localhost destinations is blocked by default and requires explicit opt-in (`allowLocalhost: true`) for local test fixtures.
6. **Known Security Limitations:** A general SSRF and domain allowlist/blocklist network access policy is not yet implemented. This runtime is not yet safe for unrestricted, unvalidated model-directed web navigation.

### Browser Installation

Install the required Chromium binary:
```bash
npx playwright install chromium
```

---

## Environment Variables

Copy `.env.example` to `.env` to configure your local credentials:

```bash
cp .env.example .env
```

| Variable | Description | Default |
| :--- | :--- | :--- |
| `BASETEN_API_KEY` | Baseten API secret key | *(Required for Baseten live calls)* |
| `BASETEN_BASE_URL` | Baseten API base URL | `https://inference.baseten.co/v1` |
| `BASETEN_MODEL_ID` | Baseten model identifier | `meta-models/muse-spark-open-1026` |
| `META_API_KEY` | Meta API secret key | *(Required for Meta live calls)* |
| `META_BASE_URL` | Meta Model API base URL | `https://api.meta.ai/v1` |
| `META_MODEL_ID` | Meta model identifier | `muse-spark-1.3` |

> **Security Note:** `.env` is ignored by Git and must never be committed or logged. Browser tests and offline model tests require zero API keys.

---

## Testing Guide

### 1. Complete Offline Test Suite
Discovers and executes both model unit tests and browser integration tests across platforms:

```bash
npm test
```

### 2. Model-Only Unit Tests (Fast & Zero-Cost)
Runs model provider tests with mock dependency injection. No network calls and no API credentials required:

```bash
npm run test:models
```

### 3. Browser Integration Tests (Localhost Fixtures Only)
Tests browser launch, context isolation, navigation, bounded snapshots, and accessible element actions exclusively against an in-process local HTTP server on `127.0.0.1`:

```bash
npm run test:browser
```

### 4. Live Model Smoke Tests (Manual & Requires Valid Credentials)
Executes a single live request against the respective provider to verify network connectivity and token generation:

```bash
# Smoke test Baseten (Muse Spark Open)
npm run test:baseten

# Smoke test Meta (Muse Spark)
npm run test:meta
```

---

## Operator CLI for Intelligent Recovery (`scripts/super-memory.js`)

Super Memory includes a focused Operator CLI for inspecting workflows, reviewing model-proposed repairs, trialing unapproved drafts with real browser verification, and explicitly promoting verified versions.

### 1. Setup & Execution

Run the CLI directly via Node.js or npm:

```bash
# Using npm script:
npm run cli -- <command> [workflowId] [options]

# Or invoking the script directly:
node scripts/super-memory.js <command> [workflowId] [options]
```

### 2. Available Commands & Examples

| Command | Description | Example |
| :--- | :--- | :--- |
| `list` | Lists all workflows, active versions, pending draft status, and enabled states. | `node scripts/super-memory.js list` |
| `inspect <id>` | Displays workflow details, active version, pending draft, and verification metadata. | `node scripts/super-memory.js inspect wf_checkout` |
| `review <id>` | Read-only unified diff comparing active version against current pending draft. | `node scripts/super-memory.js review wf_checkout` |
| `trial <id>` | Runs genuine browser trial on the draft version using Playwright and stages evidence. | `node scripts/super-memory.js trial wf_checkout --inputs inputs.json` |
| `promote <id>` | Explicitly promotes a verified draft to active status after confirmation. | `node scripts/super-memory.js promote wf_checkout` |
| `play <id>` | Executes the active verified version (ordinary playback). | `node scripts/super-memory.js play wf_checkout --inputs inputs.json` |
| `repair <id>` | Detects failure on active version, queries Meta model, and branches an unapproved draft. | `node scripts/super-memory.js repair wf_checkout --inputs inputs.json` |

### 3. Safe Runtime Inputs

Inputs must be supplied via a local JSON file mapping declared input names to string values:

```json
{
  "coupon": "SAVE20",
  "shippingAddress": "123 Market St"
}
```

**Security Guarantees & Redaction Limits:**
- Input values are never printed to `stdout` or `stderr`.
- Supplied runtime inputs and recognized credential patterns (e.g. bearer tokens, API keys, passwords) are treated as secrets and redacted from DOM snapshots, repair prompts, diagnostics, change summaries, diffs, and error logs.
- Plain objects with string values only; nested payloads, arrays, and non-string types are rejected.
- **Redaction Limits:** Redaction is guaranteed for supplied runtime inputs and recognized credential patterns. However, arbitrary unknown secrets embedded directly in workflow-authored content (such as hardcoded strings in step descriptions or target names) may not always be detectable without being declared in inputs or matching recognized patterns.

### 4. Reviewing and Trialing a Repair

The review and trial lifecycle maintains strict boundaries:
- **Read-Only Review:** `review <id>` displays a unified diff highlighting modified, added, or removed steps, targets, and criteria. Reviewing does not modify repository state or regenerate model proposals.
- **Hermetic Browser Trial:** `trial <id>` executes `WorkflowPlayer.playDraftForVerification()`, applying real Playwright Chromium navigation, accessible actions, and predicate evaluations.
- **No Auto-Promotion:** A successful trial **never** automatically promotes a draft. Ordinary playback (`play <id>`) strictly continues to run the active version.
- **Fail-Closed Evidence:** If any step fails or success criteria are not met, the trial verdict is marked `FAILED` and no promotion evidence is generated.

### 5. Explicit Promotion Lifecycle

Promotion requires intentional operator confirmation:
1. **Trial Evidence Verification:** The draft must have passed trial execution. Evidence is bound to the workflow ID, version, and content hash. This detects draft changes after trial, but the staged JSON evidence is not cryptographically signed and is trusted within the local-operator trust model.
2. **Draft Change Detection:** If the draft definition was altered after the trial, promotion is strictly rejected due to a content hash mismatch.
3. **Explicit Confirmation Token:** In interactive mode, the operator must type:
   ```text
   PROMOTE <workflowId>
   ```
   In automated/CI environments, the `--confirm "PROMOTE <workflowId>"` flag is required.
4. **Preserved State:** Promotion updates `activeVersion` and clears `draftVersion`, but **never** silently enables a disabled workflow.

---

## Complete Recovery Demonstration (`scripts/demo-recovery.js`)

Super Memory provides an automated, reproducible end-to-end demonstration runner that spins up an isolated temporary repository and a local HTTP website fixture, executes the complete recovery lifecycle, and verifies all safety invariants:

```bash
# Run demonstration with live Meta reasoning model (requires META_API_KEY or BASETEN_API_KEY in .env):
npm run demo

# Or run 100% offline using deterministic mock provider (zero credentials needed, runs anywhere):
npm run demo:offline

# To run with a visible Chromium browser window:
node --env-file=.env scripts/demo-recovery.js --no-headless
```

### Demonstration Steps & Invariant Verifications

1. **Step 1 — Baseline Creation:** Creates an initial workflow (`wf_demo_recovery`) in a temporary workspace, trials it in Chromium, and promotes it to active `v1`.
2. **Step 2 — Baseline Playback:** Confirms that ordinary playback (`play`) executes active `v1` successfully.
3. **Step 3 — Breaking Change:** Updates the synthetic checkout page button from `"Submit Order"` to `"Complete Order"`.
4. **Step 4 — Playback Failure:** Verifies that active `v1` fails safely on the renamed button, capturing an `ELEMENT_NOT_FOUND` diagnostic and DOM snapshot without leaking secrets.
5. **Step 5 — Model Repair:** Meta reasoning model (`muse-spark-1.3`) analyzes the failure and DOM snapshot, proposing `clickByRole` targeting `"Complete Order"`. Validates schema and branches unapproved draft `v2`.
6. **Step 6 — Operator Review:** Displays a read-only unified diff highlighting the exact step modification.
7. **Step 7 — Draft Isolation:** Confirms that ordinary playback (`play`) strictly continues to run active `v1` and still fails (unapproved drafts are never executed in normal playback).
8. **Step 8 — Draft Trial:** Executes a genuine browser trial on draft `v2`, verifies that the success criteria (`/complete`) passed, and stages verification evidence bound to the draft content hash.
9. **Step 9 — Explicit Promotion:** Verifies that promotion requires intentional confirmation (`PROMOTE wf_demo_recovery`), transitions active version to `v2`, and clears the draft.
10. **Step 10 — Recovered Playback:** Confirms that ordinary playback now executes promoted active `v2` and succeeds!

---

## Safety Invariants & Limitations

1. **Origin Confinement:** All workflow steps, navigations, and redirects remain strictly confined to the workflow's declared target origin.
2. **Loopback Protection:** Localhost and loopback destinations (`127.0.0.1`, `::1`, `localhost`) are blocked by default and require `--allow-localhost`.
3. **No Direct Model Code Execution:** LLMs generate structured repair proposals adhering to strict JSON schemas (`role`, `name`, `label`); arbitrary JavaScript evaluation or shell execution is prohibited.
4. **Offline Test Suite:** The default test suite (`npm test`) runs 100% offline using hermetic mock providers and local HTTP servers with zero inference credits spent.
