/**
 * Super Memory — Model Provider Unit Tests
 *
 * Tests Baseten and Meta provider abstractions offline using Node.js's built-in
 * `node:test` and `node:assert` modules with mocked fetch injection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BasetenProvider,
  MetaProvider,
  createModelProvider,
  getPreferredRecoveryProvider,
  ProviderError,
  MissingApiKeyError,
  ApiError,
  TimeoutError,
  NetworkError,
  MalformedResponseError,
  extractTextContent,
  BASETEN_DEFAULT_BASE_URL,
  BASETEN_DEFAULT_MODEL,
  META_DEFAULT_BASE_URL,
  META_DEFAULT_MODEL,
} from '../../src/models/index.js';

describe('Model Provider Abstraction (Offline Test Suite)', () => {
  /**
   * Helper to construct mock fetch response objects.
   */
  function createMockResponse({
    ok = true,
    status = 200,
    statusText = 'OK',
    json = null,
    text = '',
  } = {}) {
    return {
      ok,
      status,
      statusText,
      json: async () => {
        if (json instanceof Error) throw json;
        return json;
      },
      text: async () => text,
    };
  }

  // 1. Successful string response content
  it('1. extracts and normalizes successful string response content', async () => {
    const mockData = {
      id: 'chatcmpl-baseten-1',
      model: 'meta-models/muse-spark-open-1026',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'Baseten connection successful!',
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    const provider = new BasetenProvider({
      apiKey: 'test-dummy-key',
      fetch: async () => createMockResponse({ json: mockData }),
    });

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    assert.equal(result.text, 'Baseten connection successful!');
    assert.equal(result.provider, 'baseten');
    assert.equal(result.model, 'meta-models/muse-spark-open-1026');
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.isTruncated, false);
    assert.deepEqual(result.usage, {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  // 2. Array-based response content
  it('2. extracts and concatenates array-based response content parts', async () => {
    const mockData = {
      id: 'chatcmpl-meta-1',
      model: 'muse-spark-1.3',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Step 1: ' },
              { type: 'text', text: 'Inspect the DOM.' },
            ],
          },
        },
      ],
    };

    const provider = new MetaProvider({
      apiKey: 'test-dummy-key',
      fetch: async () => createMockResponse({ json: mockData }),
    });

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'What is step 1?' }],
    });

    assert.equal(result.text, 'Step 1: Inspect the DOM.');
    assert.equal(result.provider, 'meta');
    assert.equal(result.model, 'muse-spark-1.3');
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.isTruncated, false);
    assert.equal(result.usage, null);
  });

  // 3. Missing API key
  it('3. throws MissingApiKeyError when API key is missing or blank', async () => {
    const baseten = new BasetenProvider({ apiKey: '', fetch: async () => {} });
    await assert.rejects(
      () => baseten.complete({ messages: [{ role: 'user', content: 'Hi' }] }),
      (err) => {
        assert(err instanceof MissingApiKeyError);
        assert.equal(err.code, 'MISSING_API_KEY');
        assert.equal(err.provider, 'baseten');
        assert.equal(err.envVarName, 'BASETEN_API_KEY');
        assert(!err.message.includes('Bearer'));
        return true;
      }
    );

    const meta = new MetaProvider({ apiKey: '   ', fetch: async () => {} });
    await assert.rejects(
      () => meta.complete({ messages: [{ role: 'user', content: 'Hi' }] }),
      (err) => {
        assert(err instanceof MissingApiKeyError);
        assert.equal(err.code, 'MISSING_API_KEY');
        assert.equal(err.provider, 'meta');
        assert.equal(err.envVarName, 'META_API_KEY');
        return true;
      }
    );
  });

  // 4. HTTP error responses with provider error messages
  it('4. throws ApiError on non-2xx responses with sanitized message', async () => {
    const provider = new BasetenProvider({
      apiKey: 'dummy-key',
      fetch: async () =>
        createMockResponse({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: { error: { message: 'Authentication credentials rejected.' } },
        }),
    });

    await assert.rejects(
      () => provider.complete({ messages: [{ role: 'user', content: 'Hi' }] }),
      (err) => {
        assert(err instanceof ApiError);
        assert.equal(err.code, 'API_ERROR');
        assert.equal(err.statusCode, 401);
        assert.equal(err.statusText, 'Unauthorized');
        assert.equal(err.responseBody, 'Authentication credentials rejected.');
        assert(err.message.includes('Authentication credentials rejected.'));
        assert(!err.message.includes('dummy-key'));
        return true;
      }
    );
  });

  // 5. Network failures and timeouts
  it('5a. throws NetworkError when network transport fails', async () => {
    const provider = new MetaProvider({
      apiKey: 'dummy-key',
      fetch: async () => {
        throw new TypeError('fetch failed: getaddrinfo ENOTFOUND');
      },
    });

    await assert.rejects(
      () => provider.complete({ messages: [{ role: 'user', content: 'Hi' }] }),
      (err) => {
        assert(err instanceof NetworkError);
        assert.equal(err.code, 'NETWORK_ERROR');
        assert.equal(err.provider, 'meta');
        assert(err.message.includes('fetch failed'));
        return true;
      }
    );
  });

  it('5b. throws TimeoutError when request exceeds timeoutMs', async () => {
    const provider = new BasetenProvider({
      apiKey: 'dummy-key',
      defaultTimeoutMs: 20,
      fetch: async (_url, { signal }) => {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'TimeoutError';
            reject(err);
          });
        });
      },
    });

    await assert.rejects(
      () => provider.complete({ messages: [{ role: 'user', content: 'Hi' }], timeoutMs: 10 }),
      (err) => {
        assert(err instanceof TimeoutError);
        assert.equal(err.code, 'TIMEOUT_ERROR');
        assert.equal(err.provider, 'baseten');
        assert.equal(err.timeoutMs, 10);
        return true;
      }
    );
  });

  // 6. Malformed response JSON or unexpected response shapes
  it('6a. throws MalformedResponseError on invalid JSON', async () => {
    const provider = new BasetenProvider({
      apiKey: 'dummy-key',
      fetch: async () =>
        createMockResponse({
          ok: true,
          status: 200,
          json: new SyntaxError('Unexpected token < in JSON at position 0'),
        }),
    });

    await assert.rejects(
      () => provider.complete({ messages: [{ role: 'user', content: 'Hi' }] }),
      (err) => {
        assert(err instanceof MalformedResponseError);
        assert.equal(err.code, 'MALFORMED_RESPONSE');
        assert.equal(err.provider, 'baseten');
        return true;
      }
    );
  });

  it('6b. throws MalformedResponseError when choices array is missing or empty', async () => {
    const provider = new MetaProvider({
      apiKey: 'dummy-key',
      fetch: async () =>
        createMockResponse({
          ok: true,
          status: 200,
          json: { id: 'meta-123', choices: [] },
        }),
    });

    await assert.rejects(
      () => provider.complete({ messages: [{ role: 'user', content: 'Hi' }] }),
      (err) => {
        assert(err instanceof MalformedResponseError);
        assert.equal(err.code, 'MALFORMED_RESPONSE');
        assert.equal(err.provider, 'meta');
        return true;
      }
    );
  });

  // 7. Token-usage and finish-reason normalization
  it('7. normalizes token-usage metrics and handles missing usage as null', async () => {
    const provider = new BasetenProvider({
      apiKey: 'dummy-key',
      fetch: async () =>
        createMockResponse({
          json: {
            choices: [{ finish_reason: 'stop', message: { content: 'Done' } }],
            usage: { prompt_tokens: 42, completion_tokens: 18, total_tokens: 60 },
          },
        }),
    });

    const result = await provider.complete({ messages: [{ role: 'user', content: 'Hi' }] });
    assert.deepEqual(result.usage, { inputTokens: 42, outputTokens: 18, totalTokens: 60 });
    assert.equal(result.finishReason, 'stop');

    const providerNoUsage = new BasetenProvider({
      apiKey: 'dummy-key',
      fetch: async () =>
        createMockResponse({
          json: {
            choices: [{ finish_reason: null, message: { content: 'Done' } }],
          },
        }),
    });

    const resultNoUsage = await providerNoUsage.complete({
      messages: [{ role: 'user', content: 'Hi' }],
    });
    assert.equal(resultNoUsage.usage, null);
    assert.equal(resultNoUsage.finishReason, null);
  });

  // 8. Correct endpoint, model, and authorization-header construction without printing secrets
  it('8. builds correct endpoint, model, and Bearer authorization header without leaking secrets', async () => {
    let capturedUrl = null;
    let capturedMethod = null;
    let capturedHeaders = null;
    let capturedBody = null;

    const secretKey = 'super-secret-token-xyz987';
    const provider = new BasetenProvider({
      apiKey: secretKey,
      baseUrl: 'https://custom.endpoint.com/v1/',
      modelId: 'custom-model-id',
      fetch: async (url, options) => {
        capturedUrl = url;
        capturedMethod = options.method;
        capturedHeaders = options.headers;
        capturedBody = JSON.parse(options.body);
        return createMockResponse({
          json: {
            choices: [{ finish_reason: 'stop', message: { content: 'Success' } }],
          },
        });
      },
    });

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'Test' }],
      maxTokens: 150,
    });

    assert.equal(capturedUrl, 'https://custom.endpoint.com/v1/chat/completions');
    assert.equal(capturedMethod, 'POST');
    assert.equal(capturedHeaders['Content-Type'], 'application/json');
    assert.equal(capturedHeaders['Authorization'], `Bearer ${secretKey}`);
    assert.equal(capturedBody.model, 'custom-model-id');
    assert.deepEqual(capturedBody.messages, [{ role: 'user', content: 'Test' }]);
    assert.equal(capturedBody.max_tokens, 150);
    assert.equal(result.text, 'Success');
  });

  // 9. All providers conform to the identical public contract
  it('9. ensures both Baseten and Meta conform to the identical public contract', async () => {
    const baseten = createModelProvider('baseten', {
      apiKey: 'dummy',
      fetch: async () =>
        createMockResponse({
          json: {
            model: 'meta-models/muse-spark-open-1026',
            choices: [{ finish_reason: 'stop', message: { content: 'A' } }],
          },
        }),
    });

    const meta = createModelProvider('meta', {
      apiKey: 'dummy',
      fetch: async () =>
        createMockResponse({
          json: {
            model: 'muse-spark-1.3',
            choices: [{ finish_reason: 'stop', message: { content: 'B' } }],
          },
        }),
    });

    const modal = createModelProvider('modal', {
      apiKey: 'dummy',
      fetch: async () =>
        createMockResponse({
          json: {
            model: 'meta-llama/llama-3.1-70b-instruct',
            choices: [{ finish_reason: 'stop', message: { content: 'C' } }],
          },
        }),
    });

    const fireworks = createModelProvider('fireworks', {
      apiKey: 'dummy',
      fetch: async () =>
        createMockResponse({
          json: {
            model: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
            choices: [{ finish_reason: 'stop', message: { content: 'D' } }],
          },
        }),
    });

    assert.equal(typeof baseten.complete, 'function');
    assert.equal(typeof meta.complete, 'function');
    assert.equal(typeof modal.complete, 'function');
    assert.equal(typeof fireworks.complete, 'function');
    assert.equal(baseten.provider, 'baseten');
    assert.equal(meta.provider, 'meta');
    assert.equal(modal.provider, 'modal');
    assert.equal(fireworks.provider, 'fireworks');

    const basetenRes = await baseten.complete({ messages: [{ role: 'user', content: 'Hi' }] });
    const metaRes = await meta.complete({ messages: [{ role: 'user', content: 'Hi' }] });
    const modalRes = await modal.complete({ messages: [{ role: 'user', content: 'Hi' }] });
    const fireworksRes = await fireworks.complete({ messages: [{ role: 'user', content: 'Hi' }] });

    const expectedKeys = ['text', 'provider', 'model', 'finishReason', 'isTruncated', 'usage'].sort();
    assert.deepEqual(Object.keys(basetenRes).sort(), expectedKeys);
    assert.deepEqual(Object.keys(metaRes).sort(), expectedKeys);
    assert.deepEqual(Object.keys(modalRes).sort(), expectedKeys);
    assert.deepEqual(Object.keys(fireworksRes).sort(), expectedKeys);
  });

  // 10. Truncated responses are identified without being mistaken for complete output
  it('10. identifies truncated responses (finish_reason = length) without mistaking for complete output', async () => {
    // Scenario A: Truncated during reasoning with null content
    const providerNull = new BasetenProvider({
      apiKey: 'dummy',
      fetch: async () =>
        createMockResponse({
          json: {
            choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null } }],
          },
        }),
    });

    const resNull = await providerNull.complete({ messages: [{ role: 'user', content: 'Hi' }] });
    assert.equal(resNull.finishReason, 'length');
    assert.equal(resNull.isTruncated, true);
    assert.equal(resNull.text, '');

    // Scenario B: Truncated mid-sentence with partial content
    const providerPartial = new MetaProvider({
      apiKey: 'dummy',
      fetch: async () =>
        createMockResponse({
          json: {
            choices: [
              {
                finish_reason: 'length',
                message: { role: 'assistant', content: 'Incomplete sentence...' },
              },
            ],
          },
        }),
    });

    const resPartial = await providerPartial.complete({ messages: [{ role: 'user', content: 'Hi' }] });
    assert.equal(resPartial.finishReason, 'length');
    assert.equal(resPartial.isTruncated, true);
    assert.equal(resPartial.text, 'Incomplete sentence...');
  });

  // Additional sanity tests
  it('validates input messages array format', async () => {
    const provider = new BasetenProvider({ apiKey: 'dummy', fetch: async () => {} });
    await assert.rejects(
      () => provider.complete({ messages: [] }),
      (err) => err.code === 'INVALID_INPUT'
    );
    await assert.rejects(
      () => provider.complete({ messages: null }),
      (err) => err.code === 'INVALID_INPUT'
    );
  });

  it('createModelProvider throws UNKNOWN_PROVIDER for invalid provider names', () => {
    assert.throws(
      () => createModelProvider('anthropic'),
      (err) => {
        assert.equal(err.code, 'UNKNOWN_PROVIDER');
        assert(err.message.includes('Supported providers: "baseten", "meta"'));
        return true;
      }
    );
  });

  it('extractTextContent handles string, parts array, and nulls safely', () => {
    assert.equal(extractTextContent('Simple text'), 'Simple text');
    assert.equal(extractTextContent([{ type: 'text', text: 'part1 ' }, { text: 'part2' }]), 'part1 part2');
    assert.equal(extractTextContent(null), '');
    assert.equal(extractTextContent(undefined), '');
    assert.equal(extractTextContent({}), '');
  });

  // Retries and Meta resolution
  it('BaseModelProvider retries on transient errors and succeeds', async () => {
    let callCount = 0;
    const provider = new BasetenProvider({
      apiKey: 'test-key',
      fetch: async () => {
        callCount++;
        if (callCount === 1) {
          return createMockResponse({
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            text: 'Busy',
          });
        }
        return createMockResponse({
          json: {
            model: 'meta-models/muse-spark-open-1026',
            choices: [{ message: { role: 'assistant', content: 'Recovered!' } }],
          },
        });
      },
    });

    const res = await provider.complete({
      messages: [{ role: 'user', content: 'test' }],
      retries: 2,
      retryDelayMs: 10,
    });

    assert.equal(callCount, 2);
    assert.equal(res.text, 'Recovered!');
  });

  it('BaseModelProvider does not retry non-transient 401 client error', async () => {
    let callCount = 0;
    const provider = new BasetenProvider({
      apiKey: 'test-key',
      fetch: async () => {
        callCount++;
        return createMockResponse({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: 'Invalid API Key',
        });
      },
    });

    await assert.rejects(
      () =>
        provider.complete({
          messages: [{ role: 'user', content: 'test' }],
          retries: 2,
          retryDelayMs: 10,
        }),
      (err) => {
        assert.equal(err.statusCode, 401);
        assert.equal(callCount, 1);
        return true;
      }
    );
  });

  it('getPreferredRecoveryProvider prioritizes Meta API, falls back to Baseten, and throws if none available', () => {
    // 1. Meta direct route
    const metaRoute = getPreferredRecoveryProvider({ apiKey: 'meta-direct-key' });
    assert.equal(metaRoute.provider, 'meta');

    // 2. Baseten route when no Meta key is present
    const origMetaEnv = process.env.META_API_KEY;
    const origModelEnv = process.env.MODEL_API_KEY;
    const origBasetenEnv = process.env.BASETEN_API_KEY;

    try {
      delete process.env.META_API_KEY;
      delete process.env.MODEL_API_KEY;
      process.env.BASETEN_API_KEY = 'baseten-test-key';

      const basetenRoute = getPreferredRecoveryProvider();
      assert.equal(basetenRoute.provider, 'baseten');
      assert.equal(basetenRoute.modelId, 'meta-models/muse-spark-open-1026');

      // 3. Fails cleanly when neither key is present
      delete process.env.BASETEN_API_KEY;
      assert.throws(
        () => getPreferredRecoveryProvider(),
        (err) => {
          assert.equal(err.code, 'NO_RECOVERY_PROVIDER');
          assert(err.message.includes('No Meta reasoning route available'));
          return true;
        }
      );
    } finally {
      if (origMetaEnv !== undefined) process.env.META_API_KEY = origMetaEnv;
      if (origModelEnv !== undefined) process.env.MODEL_API_KEY = origModelEnv;
      if (origBasetenEnv !== undefined) process.env.BASETEN_API_KEY = origBasetenEnv;
    }
  });

  // Hardened error handling & sanitization
  it('bounds oversized provider error responses to 500 characters and strips control characters', async () => {
    const hugeMessage = 'Error detail: ' + 'A'.repeat(1000) + '\x00\x1b[31mControlChar\x07';
    const provider = new BasetenProvider({
      apiKey: 'test-key',
      fetch: async () =>
        createMockResponse({
          ok: false,
          status: 500,
          statusText: 'Internal Error',
          json: { error: { message: hugeMessage } },
        }),
    });

    await assert.rejects(
      () => provider.complete({ messages: [{ role: 'user', content: 'test' }] }),
      (err) => {
        assert(err instanceof ApiError);
        assert(err.responseBody.length <= 500);
        assert(!err.responseBody.includes('\x00'));
        assert(!err.responseBody.includes('\x07'));
        return true;
      }
    );
  });

  it('masks API keys if echoed in provider error response body', async () => {
    const rawSecret = 'SUPER_SECRET_KEY_12345';
    const provider = new BasetenProvider({
      apiKey: rawSecret,
      fetch: async () =>
        createMockResponse({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          text: `Invalid credential ${rawSecret} supplied.`,
        }),
    });

    await assert.rejects(
      () => provider.complete({ messages: [{ role: 'user', content: 'test' }] }),
      (err) => {
        assert(err instanceof ApiError);
        assert(!err.message.includes(rawSecret));
        assert(!err.responseBody.includes(rawSecret));
        assert(err.responseBody.includes('[REDACTED]'));
        return true;
      }
    );
  });

  it('sanitizes provider and model identifiers returned in completion', async () => {
    const provider = new BasetenProvider({
      apiKey: 'test-key',
      fetch: async () =>
        createMockResponse({
          json: {
            model: 'meta-models/muse-spark-open-1026;\x1b[31minjection\x00',
            choices: [{ message: { role: 'assistant', content: 'hello' } }],
          },
        }),
    });

    const res = await provider.complete({ messages: [{ role: 'user', content: 'test' }] });
    assert(!res.model.includes('\x1b'));
    assert(!res.model.includes('\x00'));
    assert(!res.model.includes(';'));
    assert.equal(res.model, 'meta-models/muse-spark-open-102631minjection');
  });
});
