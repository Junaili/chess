const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const chatModulePromise = import(pathToFileURL(path.resolve(__dirname, '../../src/chat.mjs')));

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url, protocol) {
    this.url = url;
    this.protocol = protocol;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  emit(type, value) {
    const event = type === 'message' ? { data: value } : value;
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  respond(request, result = {}) {
    this.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      method: `${request.method}Response`,
      result,
    }));
  }

  reject(request, code, message) {
    this.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      method: `${request.method}Response`,
      error: { code, message },
    }));
  }
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

async function connectedClient(overrides = {}) {
  const { createAgsChatClient } = await chatModulePromise;
  FakeWebSocket.instances.length = 0;
  const client = createAgsChatClient({
    baseURL: 'https://example.accelbyte.test',
    namespace: 'chess',
    getAccessToken: () => 'header.payload.signature',
    getUserId: () => 'user-a',
    WebSocketImpl: FakeWebSocket,
    requestTimeoutMs: 50,
    sessionTopicTimeoutMs: 50,
    ...overrides,
  });
  const connecting = client.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.emit('message', JSON.stringify({
    jsonrpc: '2.0',
    method: 'eventConnected',
    params: { sessionId: 'chat-session-1' },
  }));
  await connecting;
  return { client, socket };
}

test('connects to the AGS Chat websocket with token and fragment envelope metadata', async () => {
  const { createAgsChatClient } = await chatModulePromise;
  FakeWebSocket.instances.length = 0;
  const states = [];
  const client = createAgsChatClient({
    baseURL: 'https://example.accelbyte.test/base',
    namespace: 'chess',
    getAccessToken: () => 'header.payload.signature',
    getUserId: () => 'user-a',
    WebSocketImpl: FakeWebSocket,
  });
  client.subscribeState(value => states.push(value.state));

  const connecting = client.connect();
  const socket = FakeWebSocket.instances[0];
  const url = new URL(socket.url);
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.pathname, '/chat/');
  assert.equal(url.searchParams.get('X-Ab-RpcEnvelopeStart'), 'CaSr');
  assert.equal(url.searchParams.get('X-Ab-RpcEnvelopeEnd'), 'CaEd');
  assert.equal(socket.protocol, 'header.payload.signature');

  const connectedEvent = JSON.stringify({
    jsonrpc: '2.0',
    method: 'eventConnected',
    params: { sessionId: 'chat-session-1' },
  });
  socket.emit('message', `CaSr${connectedEvent.slice(0, 30)}`);
  socket.emit('message', `${connectedEvent.slice(30)}CaEd`);
  await connecting;

  assert.equal(client.snapshot().state, 'connected');
  assert.deepEqual(states.slice(-2), ['connecting', 'connected']);
  client.disconnect();
});

test('creates a personal topic, restores history, sends once, and deduplicates the echo', async () => {
  const history = [{
    id: 'old-chat',
    topicId: 'personal-topic',
    from: 'user-b',
    message: 'Earlier move?',
    receivedAt: 1_700_000_000,
  }];
  const { client, socket } = await connectedClient({ loadHistory: async () => history });
  const received = [];
  client.subscribeMessages(message => received.push(message));

  const activating = client.activatePersonalChat('user-b');
  await tick();
  const createRequest = socket.sent.at(-1);
  assert.equal(createRequest.method, 'actionCreateTopic');
  assert.deepEqual(createRequest.params.members, ['user-a', 'user-b']);
  socket.respond(createRequest, { topicId: 'personal-topic' });
  await activating;

  assert.equal(client.snapshot().state, 'ready');
  assert.equal(client.snapshot().topicId, 'personal-topic');
  assert.equal(received.length, 1);
  assert.equal(received[0].source, 'history');

  const sending = client.send('Good game');
  await tick();
  const sendRequest = socket.sent.at(-1);
  assert.equal(sendRequest.method, 'sendChat');
  socket.respond(sendRequest, {
    chatId: 'new-chat',
    topicId: 'personal-topic',
    processed: 1_700_000_001,
  });
  await sending;
  socket.emit('message', JSON.stringify({
    jsonrpc: '2.0',
    method: 'eventNewChat',
    params: {
      chatId: 'new-chat',
      topicId: 'personal-topic',
      from: 'user-a',
      message: 'Good game',
      createdAt: 1_700_000_001,
    },
  }));
  await tick();

  assert.equal(received.filter(message => message.chatId === 'new-chat').length, 1);
  client.disconnect();
});

test('uses the added-to-topic event when a session topic ID is opaque', async () => {
  const { client, socket } = await connectedClient();
  client.prepareSessionChat();
  const activating = client.activateSessionChat('game-session-1');
  await tick();

  const expectedQuery = socket.sent.at(-1);
  assert.equal(expectedQuery.method, 'queryChat');
  assert.equal(expectedQuery.params.topicId, 's.game-session-1');
  socket.reject(expectedQuery, 11234, 'user is not a member of topic');
  await tick();

  socket.emit('message', JSON.stringify({
    jsonrpc: '2.0',
    method: 'eventAddedToTopic',
    params: { topicId: 's.opaque-topic-id' },
  }));
  await tick();
  const actualQuery = socket.sent.at(-1);
  assert.equal(actualQuery.method, 'queryChat');
  assert.equal(actualQuery.params.topicId, 's.opaque-topic-id');
  socket.respond(actualQuery, { data: [] });
  await activating;

  assert.equal(client.snapshot().topicId, 's.opaque-topic-id');
  assert.equal(client.snapshot().state, 'ready');
  client.disconnect();
});

test('skips REST history for session topics and queries history over WebSocket', async () => {
  let restHistoryCalls = 0;
  const { client, socket } = await connectedClient({
    loadHistory: async () => {
      restHistoryCalls += 1;
      return [];
    },
  });
  client.prepareSessionChat();

  const activating = client.activateSessionChat('game-session-1');
  await tick();

  const historyRequest = socket.sent.at(-1);
  assert.equal(restHistoryCalls, 0);
  assert.equal(historyRequest.method, 'queryChat');
  assert.equal(historyRequest.params.topicId, 's.game-session-1');
  socket.respond(historyRequest, { data: [] });
  await activating;

  assert.equal(client.snapshot().state, 'ready');
  client.disconnect();
});

test('skips REST history for AGS personal topics whose IDs begin with a hash', async () => {
  let restHistoryCalls = 0;
  const { client, socket } = await connectedClient({
    loadHistory: async () => {
      restHistoryCalls += 1;
      return [];
    },
  });
  const received = [];
  client.subscribeMessages(message => received.push(message));

  const activating = client.activatePersonalChat('user-b');
  await tick();
  const createRequest = socket.sent.at(-1);
  assert.equal(createRequest.method, 'actionCreateTopic');
  socket.respond(createRequest, { topicId: '#user-a,user-b' });
  await tick();

  const historyRequest = socket.sent.at(-1);
  assert.equal(restHistoryCalls, 0);
  assert.equal(historyRequest.method, 'queryChat');
  assert.equal(historyRequest.params.topicId, '#user-a,user-b');
  socket.respond(historyRequest, {
    data: [{
      chatId: 'old-chat',
      topicId: '#user-a,user-b',
      from: 'user-b',
      message: 'Earlier move?',
      createdAt: 1_700_000_000,
    }],
  });
  await activating;

  assert.equal(client.snapshot().state, 'ready');
  assert.equal(received.length, 1);
  assert.equal(received[0].source, 'history');
  client.disconnect();
});

test('surfaces AGS mute events and disables ready state', async () => {
  const { client, socket } = await connectedClient({ loadHistory: async () => [] });
  const activating = client.activatePersonalChat('user-b');
  await tick();
  socket.respond(socket.sent.at(-1), { topicId: 'personal-topic' });
  await activating;

  socket.emit('message', JSON.stringify({
    jsonrpc: '2.0',
    method: 'eventUserMuted',
    params: { topicId: 'personal-topic', remainingTime: 30 },
  }));
  await tick();

  assert.equal(client.snapshot().state, 'muted');
  assert.match(client.snapshot().detail, /muted/i);
  client.disconnect();
});

test('replaces the acknowledged local text when AGS returns an authoritative filtered message', async () => {
  const { client, socket } = await connectedClient({ loadHistory: async () => [] });
  const received = [];
  client.subscribeMessages(message => received.push(message));
  const activating = client.activatePersonalChat('user-b');
  await tick();
  socket.respond(socket.sent.at(-1), { topicId: 'personal-topic' });
  await activating;

  const sending = client.send('custom filtered phrase');
  await tick();
  socket.respond(socket.sent.at(-1), {
    chatId: 'filtered-chat',
    topicId: 'personal-topic',
    processed: 1_700_000_001,
  });
  await sending;
  socket.emit('message', JSON.stringify({
    jsonrpc: '2.0',
    method: 'eventNewChat',
    params: {
      chatId: 'filtered-chat',
      topicId: 'personal-topic',
      from: 'user-a',
      message: 'custom ******** phrase',
      createdAt: 1_700_000_001,
    },
  }));
  await tick();

  assert.equal(received.at(-1).source, 'update');
  assert.equal(received.at(-1).message, 'custom ******** phrase');
  client.disconnect();
});

test('refreshes the token over the active Chat websocket', async () => {
  const { client, socket } = await connectedClient();
  const refreshing = client.refreshToken('replacement.token.value');
  await tick();
  const request = socket.sent.at(-1);
  assert.equal(request.method, 'actionRefreshToken');
  assert.equal(request.params.token, 'replacement.token.value');
  socket.respond(request, {});
  assert.equal(await refreshing, true);
  client.disconnect();
});

test('PeerJS game frames contain no text-chat or chat-history payloads', () => {
  const appSource = fs.readFileSync(path.resolve(__dirname, '../../app.js'), 'utf8');
  assert.doesNotMatch(appSource, /type:\s*['"]chat['"]/);
  assert.doesNotMatch(appSource, /data\.type\s*===\s*['"]chat['"]/);
  assert.doesNotMatch(appSource, /type:\s*['"]resync['"][^}]*chatMessages/);
});
