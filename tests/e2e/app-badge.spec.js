import { test, expect } from '@playwright/test';

// The Badging API has no push-service dependency, so the page half of #37
// (installed-app badge + the service-worker message handlers) is testable in
// headless Chromium. The service-worker half (suppress-when-focused, click
// focus-vs-openWindow) needs a real push service and is covered by the worker
// code review + lint instead.

test('installed-app badge tracks unread across topics and clears on read', async ({ page, request, baseURL }) => {
  const a = `badge-a-${Date.now()}`;
  const b = `badge-b-${Date.now()}`;

  await page.addInitScript(() => {
    window.__badgeCalls = [];
    navigator.setAppBadge = async (n) => { window.__badgeCalls.push(['set', n]); };
    navigator.clearAppBadge = async () => { window.__badgeCalls.push(['clear']); };
  });

  await page.goto('/');

  await page.locator('#topic-input').fill(a);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(a);

  await page.locator('#topic-input').fill(b);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(b);

  // A is now a background topic; a message to it becomes unread and badges the icon.
  const res = await request.post(`${baseURL}/${a}`, { data: 'hello from A' });
  expect(res.ok()).toBeTruthy();
  await expect.poll(() => page.evaluate(() => window.__badgeCalls), { timeout: 15000 })
    .toContainEqual(['set', 1]);

  // Reading A clears the badge back to nothing.
  await page.locator(`.topic-tab[data-topic="${a}"] .topic-tab-select`).click();
  await expect.poll(() => page.evaluate(() => window.__badgeCalls.slice(-1)), { timeout: 15000 })
    .toEqual([['clear']]);
});

test('service-worker open-topic message selects the topic without a reload', async ({ page }) => {
  const a = `swmsg-a-${Date.now()}`;
  const b = `swmsg-b-${Date.now()}`;

  await page.goto('/');

  await page.locator('#topic-input').fill(a);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(a);

  await page.locator('#topic-input').fill(b);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(b);

  // Simulate the service worker posting open-topic after a notification click.
  await page.evaluate((topic) => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-topic', topic, id: null } })
    );
  }, a);

  await expect(page.locator('.topic-tab.active')).toContainText(a);
});

test('service-worker push-forward merges a suppressed toast into the stream', async ({ page }) => {
  const a = `swmsg-fwd-a-${Date.now()}`;
  const b = `swmsg-fwd-b-${Date.now()}`;

  await page.goto('/');

  await page.locator('#topic-input').fill(a);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(a);

  await page.locator('#topic-input').fill(b);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(b);

  // Back on A; a push for B is suppressed and forwarded instead of toasted.
  await page.locator(`.topic-tab[data-topic="${a}"] .topic-tab-select`).click();
  await expect(page.locator('.topic-tab.active')).toContainText(a);

  await page.evaluate((topic) => {
    const payload = {
      id: `fwd-${Date.now()}`,
      topic,
      title: 'Forwarded',
      message: 'forwarded message',
      priority: 3,
      markdown: false,
      created_at: Math.floor(Date.now() / 1000),
    };
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'push-forward', payload } })
    );
  }, b);

  // The forwarded message must land in B's stream and count as unread until read.
  await expect(page.locator(`.topic-tab[data-topic="${b}"] .unread-badge`)).toHaveText('1', { timeout: 15000 });
  await page.locator(`.topic-tab[data-topic="${b}"] .topic-tab-select`).click();
  await expect(page.locator('.message-card').first()).toContainText('forwarded message');
});
