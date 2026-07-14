const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const networkPromise = import(pathToFileURL(path.resolve(__dirname, '../../src/network.mjs')));

test('fetchWithTimeout returns a successful response and clears its deadline', async () => {
  const { fetchWithTimeout } = await networkPromise;
  const expected = { ok: true };
  const result = await fetchWithTimeout('/ok', {}, 50, async () => expected);
  assert.equal(result, expected);
});

test('fetchWithTimeout aborts a stalled request with an actionable timeout error', async () => {
  const { fetchWithTimeout } = await networkPromise;
  const stalledFetch = (_input, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  await assert.rejects(
    fetchWithTimeout('/slow', {}, 5, stalledFetch),
    error => error?.code === 'ETIMEDOUT' && error?.timeoutMs === 5,
  );
});

test('fetchWithTimeout preserves a caller cancellation instead of reporting a timeout', async () => {
  const { fetchWithTimeout } = await networkPromise;
  const upstream = new AbortController();
  const stalledFetch = (_input, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('caller cancelled');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  const request = fetchWithTimeout('/cancelled', { signal: upstream.signal }, 100, stalledFetch);
  upstream.abort();
  await assert.rejects(request, error => error?.name === 'AbortError' && error?.code !== 'ETIMEDOUT');
});

test('friendlyNetworkError hides raw browser transport messages', async () => {
  const { friendlyNetworkError, NetworkTimeoutError } = await networkPromise;
  assert.match(friendlyNetworkError(new NetworkTimeoutError(10)), /took too long/i);
  assert.match(friendlyNetworkError(new Error('Failed to fetch')), /could not reach/i);
});
