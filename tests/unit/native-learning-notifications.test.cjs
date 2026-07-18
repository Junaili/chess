const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const modulePromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'native-learning-notifications.mjs')
))

function fakePlugin(overrides = {}) {
  const calls = { cancel: [], schedule: [], checkPermissions: 0, requestPermissions: 0, addListener: [] }
  return {
    calls,
    checkPermissions: async () => { calls.checkPermissions++; return overrides.checkPermissions?.() ?? { display: 'granted' } },
    requestPermissions: async () => { calls.requestPermissions++; return overrides.requestPermissions?.() ?? { display: 'granted' } },
    cancel: async (args) => { calls.cancel.push(args); return overrides.cancel?.(args) },
    schedule: async (args) => { calls.schedule.push(args); return overrides.schedule?.(args) },
    getPending: async () => overrides.getPending?.() ?? { notifications: [] },
    addListener: async (event, handler) => {
      calls.addListener.push({ event, handler })
      return overrides.listenerHandle || { remove: async () => {} }
    },
  }
}

test('checkLearningReminderPermission: returns the plugin\'s display value', async () => {
  const { checkLearningReminderPermission } = await modulePromise
  const plugin = fakePlugin({ checkPermissions: () => ({ display: 'prompt' }) })
  assert.equal(await checkLearningReminderPermission(plugin), 'prompt')
})

test('checkLearningReminderPermission: a throwing plugin fails closed to "denied"', async () => {
  const { checkLearningReminderPermission } = await modulePromise
  const plugin = { checkPermissions: async () => { throw new Error('unavailable') } }
  assert.equal(await checkLearningReminderPermission(plugin), 'denied')
})

test('requestLearningReminderPermission: returns the plugin\'s display value, fails closed on error', async () => {
  const { requestLearningReminderPermission } = await modulePromise
  assert.equal(await requestLearningReminderPermission(fakePlugin({ requestPermissions: () => ({ display: 'denied' }) })), 'denied')
  const throwing = { requestPermissions: async () => { throw new Error('nope') } }
  assert.equal(await requestLearningReminderPermission(throwing), 'denied')
})

test('scheduleLearningReminder: unknown kind never calls the plugin', async () => {
  const { scheduleLearningReminder } = await modulePromise
  const plugin = fakePlugin()
  const ok = await scheduleLearningReminder({ kind: 'goal_focus', title: 't', body: 'b', at: new Date().toISOString(), intent: 'goal' }, plugin)
  assert.equal(ok, false)
  assert.equal(plugin.calls.schedule.length, 0)
})

test('scheduleLearningReminder: cancels any existing reminder for the kind, then schedules one with only the generic intent', async () => {
  const { scheduleLearningReminder, NATIVE_ID_FOR_KIND } = await modulePromise
  const plugin = fakePlugin()
  const at = new Date('2026-07-18T19:00:00.000Z').toISOString()
  const ok = await scheduleLearningReminder({ kind: 'practice_due', title: 'A position is ready', body: 'Replay a moment.', at, intent: 'practice' }, plugin)
  assert.equal(ok, true)
  assert.equal(plugin.calls.cancel.length, 1)
  assert.deepEqual(plugin.calls.cancel[0], { notifications: [{ id: NATIVE_ID_FOR_KIND.practice_due }] })
  assert.equal(plugin.calls.schedule.length, 1)
  const scheduled = plugin.calls.schedule[0].notifications[0]
  assert.equal(scheduled.id, NATIVE_ID_FOR_KIND.practice_due)
  assert.deepEqual(scheduled.extra, { intent: 'practice' })
  assert.equal(scheduled.schedule.allowWhileIdle, true)
  // No opponent name, match id, or any field beyond title/body/schedule/extra.intent.
  assert.deepEqual(Object.keys(scheduled).sort(), ['body', 'extra', 'id', 'schedule', 'title'])
})

test('scheduleLearningReminder: a plugin failure returns false instead of throwing', async () => {
  const { scheduleLearningReminder } = await modulePromise
  const plugin = fakePlugin({ schedule: async () => { throw new Error('boom') } })
  const ok = await scheduleLearningReminder({ kind: 'practice_due', title: 't', body: 'b', at: new Date().toISOString(), intent: 'practice' }, plugin)
  assert.equal(ok, false)
})

test('cancelLearningReminder: cancels only that kind\'s reserved ID; unknown kind is a no-op', async () => {
  const { cancelLearningReminder, NATIVE_ID_FOR_KIND } = await modulePromise
  const plugin = fakePlugin()
  await cancelLearningReminder('review_unfinished', plugin)
  assert.deepEqual(plugin.calls.cancel[0], { notifications: [{ id: NATIVE_ID_FOR_KIND.review_unfinished }] })
  const plugin2 = fakePlugin()
  await cancelLearningReminder('not_a_real_kind', plugin2)
  assert.equal(plugin2.calls.cancel.length, 0)
})

test('cancelAllLearningReminders: cancels every reserved ID in one call', async () => {
  const { cancelAllLearningReminders, NATIVE_ID_FOR_KIND } = await modulePromise
  const plugin = fakePlugin()
  await cancelAllLearningReminders(plugin)
  assert.deepEqual(
    plugin.calls.cancel[0].notifications.map(n => n.id).sort(),
    Object.values(NATIVE_ID_FOR_KIND).sort(),
  )
})

test('getPendingLearningReminders: filters out any notification not owned by this feature', async () => {
  const { getPendingLearningReminders, NATIVE_ID_FOR_KIND } = await modulePromise
  const plugin = fakePlugin({
    getPending: () => ({ notifications: [{ id: NATIVE_ID_FOR_KIND.practice_due }, { id: 99999 }] }),
  })
  const pending = await getPendingLearningReminders(plugin)
  assert.deepEqual(pending, [{ id: NATIVE_ID_FOR_KIND.practice_due }])
})

test('getPendingLearningReminders: a plugin failure returns an empty list, never throws', async () => {
  const { getPendingLearningReminders } = await modulePromise
  const plugin = { getPending: async () => { throw new Error('boom') } }
  assert.deepEqual(await getPendingLearningReminders(plugin), [])
})

test('subscribeLearningReminderAction: routes a tap on a reserved ID to the handler with kind + intent', async () => {
  const { subscribeLearningReminderAction, NATIVE_ID_FOR_KIND } = await modulePromise
  const plugin = fakePlugin()
  const received = []
  await subscribeLearningReminderAction(payload => received.push(payload), plugin)
  const [{ handler }] = plugin.calls.addListener
  handler({ notification: { id: NATIVE_ID_FOR_KIND.review_unfinished, extra: { intent: 'review' } } })
  assert.deepEqual(received, [{ kind: 'review_unfinished', intent: 'review' }])
})

test('subscribeLearningReminderAction: ignores a tap on a notification ID this feature does not own', async () => {
  const { subscribeLearningReminderAction } = await modulePromise
  const plugin = fakePlugin()
  const received = []
  await subscribeLearningReminderAction(payload => received.push(payload), plugin)
  const [{ handler }] = plugin.calls.addListener
  handler({ notification: { id: 12345, extra: {} } })
  assert.deepEqual(received, [])
})

test('subscribeLearningReminderAction: resubscribing removes the previous listener handle', async () => {
  const { subscribeLearningReminderAction } = await modulePromise
  let removed = false
  const firstHandle = { remove: async () => { removed = true } }
  const plugin1 = fakePlugin({ listenerHandle: firstHandle })
  await subscribeLearningReminderAction(() => {}, plugin1)
  const plugin2 = fakePlugin()
  await subscribeLearningReminderAction(() => {}, plugin2)
  assert.equal(removed, true)
})
