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

> **Security Note:** `.env` is ignored by Git and must never be committed or logged.

---

## Testing Guide

### 1. Offline Unit Tests (Fast & Zero-Cost)
Uses Node.js's built-in `node:test` runner with mock dependency injection. No network calls are made and no API credentials are required:

```bash
npm test
```

### 2. Live Smoke Tests (Manual & Requires Valid Credentials)
Executes a single live request against the respective provider to verify network connectivity, authentication, and token generation:

```bash
# Smoke test Baseten (Muse Spark Open)
npm run test:baseten

# Smoke test Meta (Muse Spark)
npm run test:meta
```
