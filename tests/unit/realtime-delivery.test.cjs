const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePromise = import(pathToFileURL(path.resolve(__dirname, '../../src/realtime-delivery.mjs')));

test('deliverWithRetry recovers from transient failures and preserves terminal failures', async () => {
  const { deliverWithRetry } = await modulePromise;
  let calls = 0;
  const recovered = await deliverWithRetry(async () => {
    calls += 1;
    return calls < 3
      ? { ok: false, retryable: true, error: 'connection lost' }
      : { ok: true };
  }, { delaysMs: [0, 1, 1], sleep: async () => {} });
  assert.deepEqual({ ok: recovered.ok, attempts: recovered.attempts, calls }, { ok: true, attempts: 3, calls: 3 });

  calls = 0;
  const denied = await deliverWithRetry(async () => {
    calls += 1;
    return { ok: false, retryable: false, error: 'not allowed' };
  }, { delaysMs: [0, 1, 1], sleep: async () => {} });
  assert.equal(denied.attempts, 1);
  assert.equal(calls, 1);
});

test('delivery deduper collapses retries but permits the ID again after its TTL', async () => {
  const { createDeliveryDeduper } = await modulePromise;
  let clock = 1_000;
  const deduper = createDeliveryDeduper({ ttlMs: 100, now: () => clock });
  assert.equal(deduper.isDuplicate('invite-1'), false);
  assert.equal(deduper.isDuplicate('invite-1'), true);
  clock += 101;
  assert.equal(deduper.isDuplicate('invite-1'), false);
});

test('isStaleDelivery rejects genuinely old invites but tolerates missing or bad clocks', async () => {
  const { isStaleDelivery } = await modulePromise;
  const now = Date.parse('2026-07-14T12:10:01.000Z');
  assert.equal(isStaleDelivery('2026-07-14T12:00:00.000Z', 10 * 60_000, now), true);
  assert.equal(isStaleDelivery('2026-07-14T12:00:02.000Z', 10 * 60_000, now), false);
  assert.equal(isStaleDelivery('not-a-date', 10 * 60_000, now), false);
  assert.equal(isStaleDelivery('', 10 * 60_000, now), false);
});

test('personal-chat invite envelopes stay below the AGS payload limit without duplicating outer fields', async () => {
  const { PERSONAL_CHAT_PAYLOAD_MAX_BYTES, serializePersonalChatPayload } = await modulePromise;
  const encoded = serializePersonalChatPayload({
    type: 'chess-match-invite',
    inviteId: `invite-${'a'.repeat(36)}`,
    peerId: 'b'.repeat(36),
    sentAt: '2026-07-14T12:00:00.000Z',
    fromUserId: 'c'.repeat(32),
    fromName: '♟'.repeat(48),
    deliveryId: `invite-${'a'.repeat(36)}`,
  });

  assert.equal(encoded.ok, true);
  assert.ok(encoded.bytes <= PERSONAL_CHAT_PAYLOAD_MAX_BYTES);
  const payload = JSON.parse(encoded.value);
  assert.equal(payload.fromUserId, undefined);
  assert.equal(payload.deliveryId, undefined);
  assert.equal(payload.inviteId, `invite-${'a'.repeat(36)}`);
  assert.ok(Buffer.byteLength(payload.fromName, 'utf8') <= 32);
});

test('personal-chat error notifications are classified immediately instead of timing out', async () => {
  const { classifyPersonalChatResponse } = await modulePromise;
  assert.deepEqual(
    classifyPersonalChatResponse({ type: 'personalChatResponse', code: 0 }),
    { ok: true, retryable: false },
  );
  assert.deepEqual(
    classifyPersonalChatResponse({ type: 'errorNotif', code: 413 }),
    { ok: false, retryable: false, error: 'Invite data is too large to send.' },
  );
  assert.equal(classifyPersonalChatResponse({ type: 'errorNotif', code: 429 }).retryable, true);
});
