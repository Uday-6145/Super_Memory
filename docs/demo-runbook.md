# Super Memory — Video Demonstration Runbook & Recording Guide

This runbook guides presenters through recording a crisp, 2–3 minute video demonstration of Super Memory's model-assisted workflow recovery.

> **Demonstration Scope & Integrity:**  
> This demonstration executes against a controlled, local synthetic e-commerce fixture (`127.0.0.1`). It highlights Super Memory's safety invariants, draft isolation, structured Meta reasoning, real Playwright browser trial verification, and explicit promotion gating. It is a focused demonstration of recovery capabilities under representative UI updates, not a claim that all arbitrary real-world web failures can be automatically resolved.

---

## 1. Pre-Recording Preparation

### Screen & Terminal Setup
1. **Resolution:** 1080p (1920×1080) or 1440p recorded area.
2. **Font Size:** Terminal font 14–16pt (e.g. Menlo, JetBrains Mono, or SF Mono) for high-definition video legibility.
3. **Layout:**
   - **Terminal-Only View:** Full screen terminal running `npm run demo`.
   - **Side-by-Side View (Recommended):** Terminal on left half, Chromium window on right half using `--no-headless`.
4. **Credential Safety:** Never display `cat .env` or echo API keys during the recording. The demonstration runner automatically verifies credentials silently and redacts secrets from all terminal output.

### Choose Execution Mode

| Mode | Command | When to Use |
| :--- | :--- | :--- |
| **Live Meta Model (Recommended)** | `npm run demo`<br>or `node --env-file=.env scripts/demo-recovery.js --no-headless` | Uses live Meta reasoning model (`muse-spark-1.3`). Requires `META_API_KEY` (or `BASETEN_API_KEY`) in `.env`. |
| **Offline Deterministic Mode** | `npm run demo:offline`<br>or `node scripts/demo-recovery.js --offline --no-headless` | 100% offline using deterministic mock provider. Zero credentials needed; ideal for offline rehearsals or backup takes. |

---

## 2. Provider Resolution & Runtime Routing

Super Memory resolves reasoning providers in strict priority order via `getPreferredRecoveryProvider()`:
1. **Primary Model:** Direct Meta Model API (`meta :: muse-spark-1.3`) when `META_API_KEY` is present.
2. **Alternative Model:** Baseten-hosted Meta model (`meta-models/muse-spark-open-1026`) when `META_API_KEY` is absent and `BASETEN_API_KEY` is present, or when explicitly requested via `--provider baseten`.
3. **No Automatic Runtime Failover:** Provider selection occurs at startup. If direct Meta is selected and encounters a transient network outage mid-request, it does *not* automatically fail over to Baseten. Keep provider configurations distinct and report provider status truthfully.

---

## 3. Video Recording Script & Timeline (2–3 Minutes)

Run the demonstration using:
```bash
node --env-file=.env scripts/demo-recovery.js --no-headless
```

### Stage-by-Stage Script

| Stage | Target Time | What Appears on Screen | Presenter Narration Script | Key Invariant Highlighted |
| :--- | :---: | :--- | :--- | :--- |
| **Intro & Baseline Playback** | `0:00 - 0:25` | Banner displayed; `[STEP 1]` and `[STEP 2]` execute.<br>Browser window launches, inputs coupon code `SUPER2026`, clicks `"Submit Order"`, reaches `/complete`.<br>`Playback succeeded! Active version v1 finished`. | *"Welcome to Super Memory. We begin with a verified workflow—active version 1—automating an e-commerce checkout. It navigates to our store, enters a coupon, and clicks 'Submit Order'. Playback succeeds cleanly."* | **Baseline Verified:** Normal playback executes only active verified versions. |
| **Breaking UI Change** | `0:25 - 0:40` | `[STEP 3] Simulate Website UI Modernization`.<br>Event log shows checkout button updated from `"Submit Order"` to `"Complete Order"`. | *"Now, the target website deploys a UI update: the 'Submit Order' button is renamed to 'Complete Order'. In conventional automation, this breaking change halts scheduled jobs."* | **Deterministic Failure:** Website changes cause element locator timeouts. |
| **Workflow Failure & Diagnosis** | `0:40 - 0:55` | `[STEP 4]` executes.<br>Browser fails waiting for `"Submit Order"`.<br>`Playback failed: active version v1 encountered an error: clickByRole timed out`.<br>Failure category `ELEMENT_NOT_FOUND` logged. | *"When Super Memory replays active version 1, it safely fails on the outdated selector. Notice that it captures sanitized diagnostics and a live DOM snapshot without exposing runtime secrets."* | **Safe Diagnostics:** Secret inputs (`SUPER2026`) are redacted from diagnostics and error logs. |
| **Model Repair & Draft Branching** | `0:55 - 1:20` | `[STEP 5] Trigger Model-Assisted Repair Diagnosis`.<br>`Generating repair proposal using Meta reasoning model...`<br>Proposal received: `"Button label changed from 'Submit Order' to 'Complete Order'"`.<br>`Successfully created unapproved draft v2`. | *"We invoke the repair flow. Super Memory prompts Meta's reasoning model, muse-spark-1.3, with the sanitized failure diagnostics and available interactive elements. Meta identifies the renamed button and generates a structured, schema-compliant repair proposal. Crucially, Super Memory creates an isolated, unapproved draft v2—active version 1 remains locked."* | **Draft Isolation:** Model proposals can only create unapproved drafts; active versions are immutable. |
| **Operator Review (Read-Only Diff)** | `1:20 - 1:40` | `[STEP 6]` and `[STEP 7]` execute.<br>Structured color diff displayed showing `- Submit Order` and `+ Complete Order`.<br>`[STEP 7]` verifies that normal playback still runs `v1` and still fails. | *"As an operator, I can inspect the proposed change before anything touches production. The diff is strictly read-only. And notice our safety check in Step 7: ordinary playback strictly continues to run active version 1 and still fails. Unapproved drafts are never executed in production."* | **Read-Only Inspection:** Reviewing a proposal does not alter state or execute untrusted drafts. |
| **Genuine Browser Trial** | `1:40 - 2:05` | `[STEP 8] Execute Genuine Draft Trial Verification`.<br>Browser launches in trial mode on draft `v2`.<br>Clicks `"Complete Order"`, verifies success criteria `/complete`.<br>`TRIAL VERDICT: PASSED`.<br>Evidence saved to `.staging/`. | *"Next, we trial draft v2 in a real Playwright browser context. The trial fills the coupon and clicks 'Complete Order'. All success criteria pass. Super Memory stages verification evidence bound directly to the draft's cryptographic content hash. But notice: a successful trial does NOT auto-promote."* | **Real Trial Evidence:** Evidence requires genuine browser execution; drafts never auto-promote. |
| **Explicit Promotion Gating** | `2:05 - 2:25` | `[STEP 9] Operator Confirms Explicit Promotion`.<br>CLI command echoes confirmation token:<br>`promote --confirm "PROMOTE wf_demo_recovery"`.<br>`Promotion successful! Active version is now v2. Draft cleared.` | *"Promotion requires explicit operator confirmation. We verify the trial evidence hash, supply the confirmation token, and promote v2 to active status. The unapproved draft is cleared, and any disabled workflow state is strictly preserved."* | **Explicit Promotion Gating:** Promotion requires human-in-the-loop confirmation and valid evidence. |
| **Recovered Playback & Wrap-Up** | `2:25 - 2:45` | `[STEP 10] Ordinary Playback Succeeds on Promoted v2`.<br>Browser runs promoted active `v2` and succeeds in ~2200ms.<br>Summary banner displayed. | *"Finally, ordinary playback resumes. It now executes promoted active version 2 and finishes successfully. The workflow is fully healed with complete provenance, zero secret leakage, and total operator control. Thank you."* | **Verified Recovery:** Workflow is restored to operational health with full audit provenance. |

---

## 4. Troubleshooting & Fallback Procedures

### Scenario A: `META_API_KEY` Missing or Rate-Limited
- **Symptom:** Runner reports missing credentials or an API 429 rate limit from Meta.
- **Remedy:** 
  1. If `BASETEN_API_KEY` is present in `.env`, run with explicit Baseten provider:
     ```bash
     node --env-file=.env scripts/demo-recovery.js --live
     ```
  2. Or seamlessly fall back to offline deterministic mock mode:
     ```bash
     npm run demo:offline
     ```
  - State clearly to viewers: *"For this rehearsal/take, we are demonstrating the deterministic offline simulation route."*

### Scenario B: Chromium Headed Window Fails to Open
- **Symptom:** Display errors on headless environments or missing display servers (`DISPLAY` not set).
- **Remedy:** Drop `--no-headless` and run standard headless mode:
  ```bash
  npm run demo
  ```
  The runner's ANSI terminal output shows step-by-step progress, duration, and status indicators without requiring an active graphical desktop.

### Scenario C: Interrupted Demonstration Cleanup
- **Symptom:** Demo was forcibly terminated (e.g. `kill -9`) leaving a stale temporary directory in `/tmp`.
- **Remedy:** Clean up orphaned demo directories safely:
  ```bash
  rm -rf /tmp/super-memory-demo-*
  ```
  *(Note: The runner never touches real repository workflows in `./workflows` or `.super-memory`.)*

