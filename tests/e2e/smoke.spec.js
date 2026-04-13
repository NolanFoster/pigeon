import { test, expect } from '@playwright/test';

test('subscribe, receive a message, and copy it', async ({ page, request, baseURL }) => {
  const topic = `smoke-${Date.now()}`;

  await page.goto('/');
  await expect(page.locator('h1')).toContainText('Pigeon');

  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();

  const activeTab = page.locator('.topic-tab.active');
  await expect(activeTab).toContainText(topic);

  const res = await request.post(`${baseURL}/${topic}`, {
    headers: {
      'X-Title': 'Smoke title',
      'X-Priority': '5',
      'X-Tags': 'smoke,e2e',
    },
    data: 'Hello from the smoke test',
  });
  expect(res.ok()).toBeTruthy();

  const card = page.locator('.message-card').first();
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/priority-5/);
  await expect(card.locator('.msg-title')).toContainText('Smoke title');
  await expect(card.locator('.msg-body')).toContainText('Hello from the smoke test');
  await expect(card.locator('.msg-priority-badge')).toContainText('P5');
  await expect(card.locator('.msg-tags .tag-chip').first()).toContainText('smoke');

  // Accent bar is a ::before pseudo-element — verify the priority variable resolved to the P5 color
  const accent = await card.evaluate((el) => getComputedStyle(el).getPropertyValue('--accent').trim());
  expect(accent).not.toBe('');

  // Copy button: grant clipboard, click, assert the pulse class lands
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await card.locator('.copy-btn').click();
  await expect(card.locator('.copy-btn')).toHaveClass(/copied/);

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe('Hello from the smoke test');
});

test('clicking a link in a message does not navigate the app away', async ({ page, request, baseURL }) => {
  const topic = `smoke-link-${Date.now()}`;

  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(topic);

  await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Title': 'Link test', 'X-Markdown': '1' },
    data: 'See [example](https://example.com) for details',
  });

  const link = page.locator('.message-card .msg-body a').first();
  await expect(link).toHaveAttribute('href', 'https://example.com');

  // Spy on window.open BEFORE clicking, then verify the click was intercepted
  // (window.open called) AND the current page did not navigate.
  await page.evaluate(() => {
    window.__openCalls = [];
    window.open = (url, target, features) => {
      window.__openCalls.push({ url, target, features });
      return null;
    };
  });

  const urlBefore = page.url();
  await link.click();
  const urlAfter = page.url();
  expect(urlAfter).toBe(urlBefore);

  const calls = await page.evaluate(() => window.__openCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://example.com');
  expect(calls[0].target).toBe('_blank');
  expect(calls[0].features).toContain('noopener');
});

test('tag filter hides non-matching messages', async ({ page, request, baseURL }) => {
  const topic = `smoke-filter-${Date.now()}`;

  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(topic);

  await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Title': 'Alpha', 'X-Tags': 'alpha' },
    data: 'first',
  });
  await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Title': 'Beta', 'X-Tags': 'beta' },
    data: 'second',
  });

  await expect(page.locator('.message-card')).toHaveCount(2);

  await page.locator('.tags-row .tag-chip', { hasText: 'alpha' }).click();
  await expect(page.locator('.filter-banner')).toBeVisible();
  await expect(page.locator('.message-card')).toHaveCount(1);
  await expect(page.locator('.message-card .msg-title')).toContainText('Alpha');

  await page.locator('.clear-filter-btn').click();
  await expect(page.locator('.message-card')).toHaveCount(2);
});
