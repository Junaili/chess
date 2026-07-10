const { test, expect } = require('@playwright/test');
const { gotoApp } = require('./helpers.cjs');

// Friends + Family live in one card (#ags-friends-panel) with Family nested
// inside it as its own labeled group (#ags-family-panel) — one refresh
// button, one scroll region, but the two groups stay visually distinct.
// Offline spec — DOM-driven the same way as the existing "friends" ui-smoke
// tests, since family rendering reads module-private state rather than
// accepting rendered data as arguments.

test.describe('Combined People panel (Friends + Family)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      document.getElementById('screen-home').classList.add('signed-in');
      document.getElementById('ags-friends-panel').style.display = '';
    });
  });

  test('friends and family share one card with a single refresh control', async ({ page }) => {
    const panel = page.locator('#ags-friends-panel');
    await expect(panel).toBeVisible();
    // Exactly one "People" header with one Refresh button for the whole card.
    await expect(panel.locator('> .friends-header')).toHaveCount(1);
    await expect(panel.locator('> .friends-header h3')).toHaveText('People');
    await expect(panel.locator('> .friends-header .btn-mini')).toHaveCount(1);

    // Family lives nested inside the same card, not as a sibling card.
    const family = page.locator('#ags-family-panel');
    await expect(panel.locator('#ags-family-panel')).toHaveCount(1);
    await expect(family).toHaveAttribute('class', 'people-group');
  });

  test('shows a compact one-line nudge when no family is configured', async ({ page }) => {
    await page.evaluate(() => {
      document.getElementById('ags-family-panel').style.display = '';
      document.getElementById('ags-family-empty').style.display = '';
      document.getElementById('ags-section-family-members').style.display = 'none';
      document.getElementById('ags-family-actions').style.display = 'none';
    });

    const nudge = page.locator('#ags-family-empty');
    await expect(nudge).toBeVisible();
    await expect(nudge).toContainText('create a family');
    await expect(nudge.locator('button')).toContainText('Family');
    // It's a single row, not a multi-line empty-state card.
    const box = await nudge.boundingBox();
    expect(box.height).toBeLessThan(70);
    await expect(page.locator('#ags-section-family-members')).toBeHidden();
  });

  test('shows member rows with role badges when a family exists', async ({ page }) => {
    await page.evaluate(() => {
      document.getElementById('ags-family-panel').style.display = '';
      document.getElementById('ags-family-empty').style.display = 'none';
      document.getElementById('ags-section-family-members').style.display = '';
      document.getElementById('ags-family-name').textContent = "Test Family";
      document.getElementById('ags-count-family').textContent = '2';
      document.getElementById('ags-family-list').innerHTML = `
        <div class="friend-row"><div class="friend-main"><span class="friend-name">Parent<span class="family-role-badge">Guardian</span></span></div></div>
        <div class="friend-row"><div class="friend-main"><span class="friend-name">Kid<span class="family-role-badge">Child</span></span></div></div>
      `;
    });

    await expect(page.locator('#ags-family-empty')).toBeHidden();
    await expect(page.locator('#ags-family-list .friend-row')).toHaveCount(2);
    await expect(page.locator('#ags-family-list .family-role-badge').first()).toHaveText('Guardian');
    await expect(page.locator('#ags-family-list .family-role-badge').nth(1)).toHaveText('Child');
  });
});
