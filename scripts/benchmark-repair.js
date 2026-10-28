/**
 * Super Memory — Phase 3C Inference & Repair Benchmark
 *
 * Evaluates configured model providers (Baseten, Meta, Modal, Fireworks) across up to
 * 12 representative workflow failure scenarios.
 *
 * Measures:
 * - Proposal validity (JSON parsing & strict schema compliance)
 * - Fixture repair accuracy (targeting correct element/action)
 * - Latency (wall-clock response duration in ms)
 * - Token usage (input, output, and total tokens)
 *
 * Security & Cost Safety:
 * - Never prints, logs, or exports API keys or credentials.
 * - Enforces bounded maxTokens and per-request timeouts.
 * - Safely skips unconfigured providers with clear notice.
 *
 * Usage:
 *   node scripts/benchmark-repair.js
 *   node --env-file=.env scripts/benchmark-repair.js
 *   node --env-file=.env scripts/benchmark-repair.js --cases=6
 */

import { createModelProvider } from '../src/models/index.js';
import {
  buildRepairPrompt,
  parseRepairResponse,
  validateRepairProposal,
  generateRepairProposal,
} from '../src/workflow/index.js';

// 12 Representative failure cases covering diverse UI changes and edge cases
const BENCHMARK_CASES = [
  {
    id: 'case_01_btn_place_order',
    description: 'Button renamed: "Submit Order" -> "Place Order"',
    expectedChange: { role: 'button', name: 'Place Order' },
    workflow: {
      workflowId: 'wf_bench_01',
      version: 1,
      inputs: [{ name: 'coupon', type: 'string', label: 'Coupon', required: true }],
      steps: [
        {
          id: 'step_order',
          order: 1,
          description: 'Click order button',
          action: 'clickByRole',
          params: { role: 'button', name: 'Submit Order', exact: true },
        },
      ],
      target: { origin: 'http://127.0.0.1:8080', startPath: '/checkout' },
      successCriteria: { finalPath: '/checkout' },
    },
    diagnostic: {
      workflowId: 'wf_bench_01',
      version: 1,
      category: 'ELEMENT_NOT_FOUND',
      error: 'Action failed: waiting for getByRole("button", { name: "Submit Order" }) timed out',
      failedStep: {
        id: 'step_order',
        order: 1,
        action: 'clickByRole',
        description: 'Click order button',
        expected: { role: 'button', name: 'Submit Order', exact: true },
      },
      page: {
        url: 'http://127.0.0.1:8080/checkout',
        title: 'Checkout Page',
        snapshot: {
          text: 'Order Summary Total: $45.00',
          elements: [
            { tag: 'input', role: 'textbox', name: 'Coupon' },
            { tag: 'button', role: 'button', name: 'Place Order' },
            { tag: 'a', role: 'link', name: 'Back to Cart' },
          ],
        },
      },
    },
  },
  {
    id: 'case_02_btn_proceed_checkout',
    description: 'Button renamed: "Checkout" -> "Proceed to Checkout"',
    expectedChange: { role: 'button', name: 'Proceed to Checkout' },
    workflow: {
      workflowId: 'wf_bench_02',
      version: 1,
      inputs: [],
      steps: [
        {
          id: 'step_cart_checkout',
          order: 1,
          description: 'Click checkout button',
          action: 'clickByRole',
          params: { role: 'button', name: 'Checkout', exact: true },
        },
      ],
      target: { origin: 'http://127.0.0.1:8080', startPath: '/cart' },
      successCriteria: { finalPath: '/checkout' },
    },
    diagnostic: {
      workflowId: 'wf_bench_02',
      version: 1,
      category: 'ELEMENT_NOT_FOUND',
      error: 'Action failed: waiting for getByRole("button", { name: "Checkout" }) timed out',
      failedStep: {
        id: 'step_cart_checkout',
        order: 1,
        action: 'clickByRole',
        description: 'Click checkout button',
        expected: { role: 'button', name: 'Checkout', exact: true },
      },
      page: {
        url: 'http://127.0.0.1:8080/cart',
        title: 'Your Cart',
        snapshot: {
          text: '2 Items in cart. Subtotal: $20.00',
          elements: [
            { tag: 'button', role: 'button', name: 'Continue Shopping' },
            { tag: 'button', role: 'button', name: 'Proceed to Checkout' },
          ],
        },
      },
    },
  },
  {
    id: 'case_03_btn_find_products',
    description: 'Button renamed: "Search" -> "Find Products"',
    expectedChange: { role: 'button', name: 'Find Products' },
    workflow: {
      workflowId: 'wf_bench_03',
      version: 1,
      inputs: [],
      steps: [
        {
          id: 'step_search',
          order: 1,
          description: 'Click search',
          action: 'clickByRole',
          params: { role: 'button', name: 'Search', exact: true },
        },
      ],
      target: { origin: 'http://127.0.0.1:8080', startPath: '/' },
      successCriteria: { finalPath: '/search' },
    },
    diagnostic: {
      workflowId: 'wf_bench_03',
      version: 1,
      category: 'ELEMENT_NOT_FOUND',
      error: 'Action failed: waiting for getByRole("button", { name: "Search" }) timed out',
      failedStep: {
        id: 'step_search',
        order: 1,
        action: 'clickByRole',
        description: 'Click search',
        expected: { role: 'button', name: 'Search', exact: true },
      },
      page: {
        url: 'http://127.0.0.1:8080/',
        title: 'Store Home',
        snapshot: {
          text: 'Browse our catalog of items.',
          elements: [
            { tag: 'input', role: 'textbox', name: 'Query' },
            { tag: 'button', role: 'button', name: 'Find Products' },
          ],
        },
      },
    },
  },
  {
    id: 'case_04_link_return_cart',
    description: 'Link text updated: "Back to Cart" -> "Return to Cart"',
    expectedChange: { role: 'link', name: 'Return to Cart' },
    workflow: {
      workflowId: 'wf_bench_04',
      version: 1,
      inputs: [],
      steps: [
        {
          id: 'step_back',
          order: 1,
          description: 'Click back link',
          action: 'clickByRole',
          params: { role: 'link', name: 'Back to Cart', exact: true },
        },
      ],
      target: { origin: 'http://127.0.0.1:8080', startPath: '/checkout' },
      successCriteria: { finalPath: '/cart' },
    },
    diagnostic: {
      workflowId: 'wf_bench_04',
      version: 1,
      category: 'ELEMENT_NOT_FOUND',
      error: 'Action failed: waiting for getByRole("link", { name: "Back to Cart" }) timed out',
      failedStep: {
        id: 'step_back',
        order: 1,
        action: 'clickByRole',
        description: 'Click back link',
        expected: { role: 'link', name: 'Back to Cart', exact: true },
      },
      page: {
        url: 'http://127.0.0.1:8080/checkout',
        title: 'Checkout Page',
        snapshot: {
          text: 'Payment Details',
          elements: [
            { tag: 'button', role: 'button', name: 'Pay Now' },
            { tag: 'a', role: 'link', name: 'Return to Cart' },
          ],
        },
      },
    },
  },
  {
    id: 'case_05_field_promo_code',
    description: 'Field label renamed: "Coupon Code" -> "Promo Code"',
    expectedChange: { action: 'fillByLabel', label: 'Promo Code' },
    workflow: {
      workflowId: 'wf_bench_05',
      version: 1,
      inputs: [{ name: 'coupon', type: 'string', label: 'Coupon', required: true }],
      steps: [
        {
          id: 'step_coupon',
          order: 1,
          description: 'Fill coupon code',
          action: 'fillByLabel',
          params: { label: 'Coupon Code', inputName: 'coupon', exact: true },
        },
      ],
      target: { origin: 'http://127.0.0.1:8080', startPath: '/cart' },
      successCriteria: { finalPath: '/cart' },
    },
    diagnostic: {
      workflowId: 'wf_bench_05',
      version: 1,
      category: 'ELEMENT_NOT_FOUND',
      error: 'Action failed: waiting for getByLabel("Coupon Code") timed out',
      failedStep: {
        id: 'step_coupon',
        order: 1,
        action: 'fillByLabel',
        description: 'Fill coupon code',
        expected: { label: 'Coupon Code', inputName: 'coupon', exact: true },
      },
      page: {
        url: 'http://127.0.0.1:8080/cart',
        title: 'Cart Review',
        snapshot: {
          text: 'Enter promo code to apply discount.',
          elements: [
            { tag: 'input', role: 'textbox', name: 'Promo Code', placeholder: 'Enter promo code' },
            { tag: 'button', role: 'button', name: 'Apply' },
          ],
        },
      },
    },
  },
  {
    id: 'case_06_field_email_address',
    description: 'Field label renamed: "Your Email" -> "Email Address"',
    expectedChange: { action: 'fillByLabel', label: 'Email Address' },
    workflow: {
      workflowId: 'wf_bench_06',
      version: 1,
      inputs: [{ name: 'email', type: 'string', label: 'Email', required: true }],
      steps: [
        {
          id: 'step_email',
          order: 1,
          description: 'Fill email',
          action: 'fillByLabel',
          params: { label: 'Your Email', inputName: 'email', exact: true },
        },
      ],
      target: { origin: 'http://127.0.0.1:8080', startPath: '/login' },
      successCriteria: { finalPath: '/login' },
    },
    diagnostic: {
      workflowId: 'wf_bench_06',
      version: 1,
      category: 'ELEMENT_NOT_FOUND',
      error: 'Action failed: waiting for getByLabel("Your Email") timed out',
      failedStep: {
        id: 'step_email',
        order: 1,
        action: 'fillByLabel',
        description: 'Fill email',
        expected: { label: 'Your Email', inputName: 'email', exact: true },
      },
      page: {
        url: 'http://127.0.0.1:8080/login',
        title: 'Sign In',
        snapshot: {
          text: 'Please enter your email to proceed.',
          elements: [
            { tag: 'input', role: 'textbox', name: 'Email Address', placeholder: 'user@example.com' },
            { tag: 'button', role: 'button', name: 'Continue' },
          ],
        },
      },
    },
  },
  {
    id: 'case_07_btn_dismiss_modal',
    description: 'Dialog close button renamed: "Close" -> "Dismiss"',
    expectedChange: { role: 'button', name: 'Dismiss' },
    workflow: {
      workflowId: 'wf_bench_07',
      version: 1,
      inputs: [],
      steps: [
        {
          id: 'step_close_modal',
          order: 1,
          description: 'Close notification modal',
          action: 'clickByRole',
          params: { role: 'button', name: 'Close', exact: true },
        },
      ],
      target: { origin: 'http://127.0.0.1:8080', startPath: '/dashboard' },
      successCriteria: { finalPath: '/dashboard' },
    },
    diagnostic: {
      workflowId: 'wf_bench_07',
      version: 1,
      category: 'ELEMENT_NOT_FOUND',
      error: 'Action failed: waiting for getByRole("button", { name: "Close" }) timed out',
      failedStep: {
        id: 'step_close_modal',
        order: 1,
        action: 'clickByRole',
        description: 'Close notification modal',
        expected: { role: 'button', name: 'Close', exact: true },
      },
      page: {
        url: 'http://127.0.0.1:8080/dashboard',
        title: 'User Dashboard',
        snapshot: {
          text: 'Special announcement: shipping is free today only.',
          elements: [
            { tag: 'button', role: 'button', name: 'Dismiss' },
            { tag: 'a', role: 'link', name: 'Learn More' },
          ],
        },
      },
    },
  },
  {
    id: 'case_08_btn_apply_filter',
    description: 'Button renamed: "Filter Items" -> "Apply Filters"',
    expectedChange: { role: 'button', name: 'Apply Filters' },
    workflow: {
      workflowId: 'wf_bench_08',
      version: 1,
      inputs: [],
      steps: [
        {
          id: 'step_filter',
          order: 1,
          description: 'Filter catalog',
          action: 'clickByRole',
          params: { role: 'button', name: 'Filter Items', exact: true },
        },
      ],
      target: { origin: 'http://127.0.0.1:8080', startPath: '/products' },
      successCriteria: { finalPath: '/products' },
    },
    diagnostic: {
      workflowId: 'wf_bench_08',
      version: 1,
      category: 'ELEMENT_NOT_FOUND',
      error: 'Action failed: waiting for getByRole("button", { name: "Filter Items" }) timed out',
      failedStep: {
        id: 'step_filter',
        order: 1,
        action: 'clickByRole',
        description: 'Filter catalog',
        expected: { role: 'button', name: 'Filter Items', exact: true },
      },
      page: {
        url: 'http://127.0.0.1:8080/products',
        title: 'Product Catalog',
        snapshot: {
          text: 'Filter products by price and category.',
          elements: [
            { tag: 'input', role: 'checkbox', name: 'In Stock' },
            { tag: 'button', role: 'button', name: 'Apply Filters' },
          ],
        },
      },
    },
  },
  {
    id: 'case_09_link_storefront',
    description: 'Nav link text updated: "Home" -> "Storefront"',
    expectedChange: { role: 'link', name: 'Storefront' },
    workflow: {
      workflowId: 'wf_bench_09',
      version: 1,
      inputs: [],
      steps: [
        {
          id: 'step_home_link',
          order: 1,
          description: 'Return home',
          action: 'clickByRole',
          params: { role: 'link', name: 'Home', exact: true },
        },
      ],
      target: { origin: 'http://127.0.0.1:8080', startPath: '/about' },
      successCriteria: { finalPath: '/' },
    },
    diagnostic: {
      workflowId: 'wf_bench_09',
      version: 1,
      category: 'ELEMENT_NOT_FOUND',
      error: 'Action failed: waiting for getByRole("link", { name: "Home" }) timed out',
      failedStep: {
        id: 'step_home_link',
        order: 1,
        action: 'clickByRole',
        description: 'Return home',
        expected: { role: 'link', name: 'Home', exact: true },
      },
      page: {
        url: 'http://127.0.0.1:8080/about',
        title: 'About Us',
        snapshot: {
          text: 'About our company and values.',
          elements: [
            { tag: 'a', role: 'link', name: 'Storefront' },
            { tag: 'a', role: 'link', name: 'Contact Us' },
          ],
        },
      },
    },
  },
  {
    id: 'case_10_field_delivery_address',
    description: 'Field label renamed: "Shipping Address" -> "Delivery Address"',
    expectedChange: { action: 'fillByLabel', label: 'Delivery Address' },
    workflow: {
      workflowId: 'wf_bench_10',
      version: 1,
      inputs: [{ name: 'address', type: 'string', label: 'Address', required: true }],
      steps: [
        {
          id: 'step_addr',
          order: 1,
          description: 'Fill address',
          action: 'fillByLabel',
          params: { label: 'Shipping Address', inputName: 'address', exact: true },
        },
      ],
      target: { origin: 'http://127.0.0.1:8080', startPath: '/shipping' },
      successCriteria: { finalPath: '/shipping' },
    },
    diagnostic: {
      workflowId: 'wf_bench_10',
      version: 1,
      category: 'ELEMENT_NOT_FOUND',
      error: 'Action failed: waiting for getByLabel("Shipping Address") timed out',
      failedStep: {
        id: 'step_addr',
        order: 1,
        action: 'fillByLabel',
        description: 'Fill address',
        expected: { label: 'Shipping Address', inputName: 'address', exact: true },
      },
      page: {
        url: 'http://127.0.0.1:8080/shipping',
        title: 'Shipping Details',
        snapshot: {
          text: 'Please specify where to deliver your parcel.',
          elements: [
            { tag: 'input', role: 'textbox', name: 'Delivery Address', placeholder: 'Street address' },
            { tag: 'button', role: 'button', name: 'Next Step' },
          ],
        },
      },
    },
  },
  {
    id: 'case_11_role_sign_in_link',
    description: 'Element changed role: button "Sign In" became link "Sign In"',
    expectedChange: { role: 'link', name: 'Sign In' },
    workflow: {
      workflowId: 'wf_bench_11',
      version: 1,
      inputs: [],
      steps: [
        {
          id: 'step_signin',
          order: 1,
          description: 'Click sign in',
          action: 'clickByRole',
          params: { role: 'button', name: 'Sign In', exact: true },
        },
      ],
      target: { origin: 'http://127.0.0.1:8080', startPath: '/' },
      successCriteria: { finalPath: '/login' },
    },
    diagnostic: {
      workflowId: 'wf_bench_11',
      version: 1,
      category: 'ELEMENT_NOT_FOUND',
      error: 'Action failed: waiting for getByRole("button", { name: "Sign In" }) timed out',
      failedStep: {
        id: 'step_signin',
        order: 1,
        action: 'clickByRole',
        description: 'Click sign in',
        expected: { role: 'button', name: 'Sign In', exact: true },
      },
      page: {
        url: 'http://127.0.0.1:8080/',
        title: 'Welcome',
        snapshot: {
          text: 'Welcome guest. Please sign in.',
          elements: [
            { tag: 'a', role: 'link', name: 'Sign In' },
            { tag: 'a', role: 'link', name: 'Create Account' },
          ],
        },
      },
    },
  },
  {
    id: 'case_12_missing_element_uncertainty',
    description: 'Element completely missing from page (requires high uncertainty in proposal)',
    expectedChange: null, // Model should detect no obvious replacement
    workflow: {
      workflowId: 'wf_bench_12',
      version: 1,
      inputs: [],
      steps: [
        {
          id: 'step_download',
          order: 1,
          description: 'Download report',
          action: 'clickByRole',
          params: { role: 'button', name: 'Download PDF', exact: true },
        },
      ],
      target: { origin: 'http://127.0.0.1:8080', startPath: '/reports' },
      successCriteria: { finalPath: '/reports' },
    },
    diagnostic: {
      workflowId: 'wf_bench_12',
      version: 1,
      category: 'ELEMENT_NOT_FOUND',
      error: 'Action failed: waiting for getByRole("button", { name: "Download PDF" }) timed out',
      failedStep: {
        id: 'step_download',
        order: 1,
        action: 'clickByRole',
        description: 'Download report',
        expected: { role: 'button', name: 'Download PDF', exact: true },
      },
      page: {
        url: 'http://127.0.0.1:8080/reports',
        title: 'Reports Page',
        snapshot: {
          text: 'No reports currently available.',
          elements: [
            { tag: 'a', role: 'link', name: 'Back to Home' },
          ],
        },
      },
    },
  },
];

async function runBenchmarkForProvider(providerName, casesToRun) {
  console.log(`\n======================================================`);
  console.log(`Evaluating Provider: "${providerName}"`);
  console.log(`======================================================`);

  let provider;
  try {
    provider = createModelProvider(providerName);
  } catch (err) {
    console.log(`[Skipped] Provider "${providerName}" cannot be created: ${err.message}`);
    return null;
  }

  if (!provider.apiKey) {
    console.log(`[Skipped] Provider "${providerName}": ${provider.envVarName} is not set in environment.`);
    return null;
  }

  console.log(`Model: ${provider.modelId}`);
  console.log(`Running ${casesToRun.length} benchmark scenarios (maxTokens=1500, timeout=30s)...\n`);

  const results = [];

  for (let i = 0; i < casesToRun.length; i++) {
    const testCase = casesToRun[i];
    process.stdout.write(`  [${i + 1}/${casesToRun.length}] ${testCase.id} (${testCase.description})... `);

    const startTime = performance.now();

    let proposalResult = null;
    let schemaValid = false;
    let matched = null;
    let hasUncertainty = null;
    let errorMessage = null;

    try {
      proposalResult = await generateRepairProposal(provider, testCase.diagnostic, testCase.workflow, {
        maxTokens: 1500,
        timeoutMs: 30000,
      });

      const parsed = proposalResult.proposal;
      schemaValid = true;

      // Comparison check against all relevant expected parameters
      if (testCase.expectedChange) {
        const change = parsed.proposedChange;
        let isMatch = true;

        if (testCase.expectedChange.action && change.action !== testCase.expectedChange.action) {
          isMatch = false;
        }
        if (testCase.expectedChange.role && change.params?.role !== testCase.expectedChange.role) {
          isMatch = false;
        }
        if (testCase.expectedChange.name && change.params?.name !== testCase.expectedChange.name) {
          isMatch = false;
        }
        if (testCase.expectedChange.label && change.params?.label !== testCase.expectedChange.label) {
          isMatch = false;
        }
        if (testCase.expectedChange.inputName && change.params?.inputName !== testCase.expectedChange.inputName) {
          isMatch = false;
        }
        if (testCase.expectedChange.exact !== undefined && change.params?.exact !== testCase.expectedChange.exact) {
          isMatch = false;
        }

        matched = isMatch;
      } else {
        // Safe abstention / missing element case: excluded from proposal match denominator
        matched = null;
        hasUncertainty = typeof parsed.uncertainty === 'string' && parsed.uncertainty.trim().length > 10;
      }
    } catch (err) {
      schemaValid = false;
      matched = testCase.expectedChange ? false : null;
      hasUncertainty = false;
      errorMessage = err.message;
    }

    const latencyMs = Math.round(performance.now() - startTime);
    const tokens = proposalResult?.usage?.totalTokens ?? null;

    if (schemaValid && matched === true) {
      console.log(`PASS (${latencyMs}ms, ${tokens ?? '?'} tokens)`);
    } else if (schemaValid && matched === null && hasUncertainty) {
      console.log(`PASS [Abstention Uncertainty] (${latencyMs}ms, ${tokens ?? '?'} tokens)`);
    } else if (schemaValid) {
      console.log(`PARTIAL (valid schema, different proposal: ${latencyMs}ms)`);
    } else {
      console.log(`FAIL (${errorMessage || 'Schema error'})`);
    }

    results.push({
      caseId: testCase.id,
      schemaValid,
      matched,
      hasUncertainty,
      isAbstentionCase: !testCase.expectedChange,
      latencyMs,
      tokens,
      error: errorMessage,
    });
  }

  const validCount = results.filter((r) => r.schemaValid).length;
  const evaluableCases = results.filter((r) => !r.isAbstentionCase);
  const matchedCount = evaluableCases.filter((r) => r.matched === true).length;
  const abstentionCases = results.filter((r) => r.isAbstentionCase);
  const uncertaintyCount = abstentionCases.filter((r) => r.hasUncertainty === true).length;

  const totalLatency = results.reduce((sum, r) => sum + r.latencyMs, 0);
  const avgLatency = Math.round(totalLatency / results.length);
  const totalTokens = results.reduce((sum, r) => sum + (r.tokens || 0), 0);

  return {
    provider: providerName,
    model: provider.modelId,
    totalCases: results.length,
    validProposals: validCount,
    matchedProposals: matchedCount,
    evaluableCount: evaluableCases.length,
    abstentionCount: abstentionCases.length,
    uncertaintyCount,
    validityRate: ((validCount / results.length) * 100).toFixed(1) + '%',
    proposalMatchRate: evaluableCases.length > 0 ? ((matchedCount / evaluableCases.length) * 100).toFixed(1) + '%' : 'N/A',
    avgLatencyMs: avgLatency,
    totalTokens,
    results,
  };
}

async function main() {
  console.log('--- Super Memory: Phase 3C Model Repair Benchmark ---');
  console.log('NOTICE: This benchmark evaluates proposal syntax validity and target-matching against');
  console.log('static expectations. It DOES NOT execute repaired workflows or demonstrate real-world repair runtime success.\n');

  // Parse command line arguments
  const args = process.argv.slice(2);
  let limit = BENCHMARK_CASES.length;
  for (const arg of args) {
    if (arg.startsWith('--cases=')) {
      const parsedLimit = parseInt(arg.split('=')[1], 10);
      if (parsedLimit > 0) limit = Math.min(parsedLimit, BENCHMARK_CASES.length);
    }
  }

  const activeCases = BENCHMARK_CASES.slice(0, limit);
  console.log(`Selected ${activeCases.length} / ${BENCHMARK_CASES.length} benchmark scenarios.`);

  const providers = ['baseten', 'meta', 'modal', 'fireworks'];
  const providerSummaries = [];

  for (const p of providers) {
    try {
      const summary = await runBenchmarkForProvider(p, activeCases);
      if (summary) {
        providerSummaries.push(summary);
      }
    } catch (err) {
      console.error(`Unexpected error testing ${p}:`, err.message);
    }
  }

  console.log('\n======================================================');
  console.log('SUMMARY BENCHMARK REPORT');
  console.log('NOTICE: proposalMatchRate reflects parameter matching against static expectations.');
  console.log('It does not prove executed repair correctness.');
  console.log('======================================================');

  if (providerSummaries.length === 0) {
    console.log('No providers had valid credentials configured in the environment.');
    console.log('To run benchmarks, configure BASETEN_API_KEY, META_API_KEY, etc. in .env');
    return;
  }

  console.table(
    providerSummaries.map((s) => ({
      Provider: s.provider,
      Model: s.model,
      'Cases Tested': s.totalCases,
      'Schema Valid': `${s.validProposals}/${s.totalCases} (${s.validityRate})`,
      'Proposal Match': `${s.matchedProposals}/${s.evaluableCount} (${s.proposalMatchRate})`,
      'Uncertainty Reported': `${s.uncertaintyCount}/${s.abstentionCount}`,
      'Avg Latency': `${s.avgLatencyMs} ms`,
      'Total Tokens': s.totalTokens,
    }))
  );
}

main().catch((err) => {
  console.error('Fatal benchmark error:', err);
  process.exit(1);
});

