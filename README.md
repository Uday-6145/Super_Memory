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
