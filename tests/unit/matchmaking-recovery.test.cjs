const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePromise = import(pathToFileURL(path.resolve(__dirname, '../../src/matchmaking-recovery.mjs')));

test('parses the AGS OnMatchFound base64 notification envelope', async () => {
  const { parseMatchFoundNotification } = await modulePromise;
  const payload = {
    ID: 'session-1',
    CreatedAt: '2026-07-14T08:34:39Z',
    MatchPool: 'chess-quickmatch',
    Teams: [{ UserIDs: ['user-a', 'user-b'] }],
    Tickets: [{ TicketID: 'ticket-a' }, { TicketID: 'ticket-b' }],
  };
  const notification = parseMatchFoundNotification({
    type: 'messageNotif',
    topic: 'OnMatchFound',
    payload: Buffer.from(JSON.stringify(payload)).toString('base64'),
  });

  assert.deepEqual(notification, {
    sessionId: 'session-1',
    matchPool: 'chess-quickmatch',
    createdAt: '2026-07-14T08:34:39Z',
    memberUserIds: ['user-a', 'user-b'],
    ticketIds: ['ticket-a', 'ticket-b'],
  });
});

test('matches notifications to their pool and ticket', async () => {
  const { isNotificationForTicket } = await modulePromise;
  const notification = {
    sessionId: 'session-1',
    matchPool: 'chess-quickmatch',
    ticketIds: ['ticket-a', 'ticket-b'],
  };
  assert.equal(isNotificationForTicket(notification, 'ticket-b', 'chess-quickmatch'), true);
  assert.equal(isNotificationForTicket(notification, 'ticket-c', 'chess-quickmatch'), false);
  assert.equal(isNotificationForTicket(notification, 'ticket-b', 'other-pool'), false);
  assert.equal(isNotificationForTicket({
    sessionId: 'session-2',
    matchPool: 'chess-quickmatch',
    ticketIds: [],
    createdAt: '2026-07-14T08:34:39Z',
  }, 'ticket-c', 'chess-quickmatch', Date.parse('2026-07-14T08:34:30Z')), true);
  assert.equal(isNotificationForTicket({
    sessionId: 'stale-session',
    matchPool: 'chess-quickmatch',
    ticketIds: [],
    createdAt: '2026-07-14T08:30:00Z',
  }, 'ticket-c', 'chess-quickmatch', Date.parse('2026-07-14T08:34:30Z')), false);
});

test('selects the newest current-pool session and ignores stale or incomplete sessions', async () => {
  const { selectRecentMatchSession } = await modulePromise;
  const startedAt = Date.parse('2026-07-14T08:34:20Z');
  const memberPair = [{ id: 'user-a' }, { id: 'user-b' }];
  const selected = selectRecentMatchSession([
    { id: 'stale', matchPool: 'chess-quickmatch', isActive: true, createdAt: '2026-07-14T08:30:00Z', members: memberPair },
    { id: 'wrong-pool', matchPool: 'other', isActive: true, createdAt: '2026-07-14T08:34:45Z', members: memberPair },
    { id: 'incomplete', matchPool: 'chess-quickmatch', isActive: true, createdAt: '2026-07-14T08:34:46Z', members: [{ id: 'user-a' }] },
    { id: 'current', matchPool: 'chess-quickmatch', isActive: true, createdAt: '2026-07-14T08:34:39Z', members: memberPair },
  ], { matchPool: 'chess-quickmatch', startedAt });

  assert.equal(selected?.id, 'current');
});
