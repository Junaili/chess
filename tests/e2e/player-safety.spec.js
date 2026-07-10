const { test, expect } = require('@playwright/test')
const { gotoApp } = require('./helpers.cjs')

async function prepareOnlineSafety(page) {
  await gotoApp(page)
  await page.evaluate(() => {
    window.agsCurrentUserId = 'self-player'
    window.agsStartMatchmaking = () => {}
    window.agsCancelMatchmaking = () => {}
    window.startRandomMatchmaking()
    window.setCurrentOpponent('Opponent One', 'opponent-1')
    window.showScreen('game')
    document.getElementById('online-chat').style.display = 'flex'
    window.agsGetSafetyReasons = async () => ({
      ok: true,
      reasons: [
        { title: 'Harassment', description: 'Abusive or threatening behavior' },
        { title: 'Spam', description: 'Repeated unwanted messages' },
      ],
    })
  })
}

test.describe('player safety', () => {
  test('reports an opponent with a configured AGS reason', async ({ page }) => {
    await prepareOnlineSafety(page)
    await page.evaluate(() => {
      window.__reportedPlayer = null
      window.agsReportPlayer = async payload => {
        window.__reportedPlayer = payload
        return { ok: true, ticketId: 'ags-ticket-123' }
      }
      window.openMatchSafety()
    })

    await expect(page.locator('#match-safety-modal')).toBeVisible()
    await expect(page.locator('#match-safety-opponent')).toContainText('Opponent One')
    await page.getByRole('button', { name: 'Report Player' }).click()
    await expect(page.locator('#report-player-modal')).toBeVisible()
    await expect(page.locator('#report-player-reason')).toBeEnabled()
    await page.locator('#report-player-reason').selectOption('Harassment')
    await page.locator('#report-player-comment').fill('Repeated insults')
    await page.locator('#btn-submit-player-report').click()

    await expect(page.locator('#report-player-message')).toContainText('Report submitted')
    await expect(page.locator('#report-player-message')).toContainText('within 24 hours')
    await expect(page.locator('#report-player-message')).toContainText('AGS report reference: ags-ticket-123')
    await expect.poll(() => page.evaluate(() => window.__reportedPlayer)).toEqual({
      userId: 'opponent-1',
      reason: 'Harassment',
      comment: 'Repeated insults',
    })
  })

  test('reports a chat message with its AGS evidence metadata', async ({ page }) => {
    await prepareOnlineSafety(page)
    await page.evaluate(() => {
      window.__reportedChat = null
      window.agsReportChatMessage = async payload => {
        window.__reportedChat = payload
        return { ok: true }
      }
      window.handleAGSChatMessage({
        chatId: 'chat-123',
        topicId: 's.session-456',
        createdAt: 1782995400000,
        from: 'opponent-1',
        message: 'This is reportable',
      })
    })

    await page.getByRole('tab', { name: 'Chat' }).click()
    await page.locator('.chat-message.opponent .chat-report-button').click()
    await expect(page.locator('#report-player-title')).toHaveText('Report Message')
    await page.locator('#report-player-reason').selectOption('Spam')
    await page.locator('#btn-submit-player-report').click()

    const report = await page.evaluate(() => window.__reportedChat)
    expect(report.userId).toBe('opponent-1')
    expect(report.reason).toBe('Spam')
    expect(report.message).toMatchObject({
      chatId: 'chat-123',
      topicId: 's.session-456',
      createdAt: 1782995400000,
      from: 'opponent-1',
    })
  })

  test('blocking keeps the match running and suppresses chat and social actions', async ({ page }) => {
    await prepareOnlineSafety(page)
    await page.evaluate(() => {
      window.agsBlockPlayer = async userId => {
        window.handleAGSPlayerBlocked(userId)
        return { ok: true }
      }
      window.openMatchSafety()
    })

    await page.locator('#btn-block-current-opponent').click()
    await expect(page.locator('#match-safety-message')).toContainText('current game will continue')
    await expect(page.locator('#online-chat-status')).toHaveText('Blocked')
    await expect(page.locator('#online-chat-messages')).toContainText('Chat is hidden')
    await expect(page.locator('#online-chat .online-chat-compose')).toBeHidden()
    await expect(page.locator('#btn-rematch')).toBeHidden()
    await expect(page.locator('#btn-add-match-friend')).toBeHidden()
  })
})
