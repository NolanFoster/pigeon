import { test, expect } from '@playwright/test';

// XSS regression suite. Each test publishes an attacker-shaped payload that
// would have executed before the security review and asserts the browser does
// not run it (no global flag is set, no alert dialog fires).

async function withAlertSpy(page) {
  await page.addInitScript(() => {
    window.__alerts = [];
    const origAlert = window.alert;
    window.alert = (msg) => { window.__alerts.push(msg); return origAlert ? undefined : undefined; };
  });
}

async function readPwn(page) {
  return await page.evaluate(() => ({
    pwn: window.__pwn,
    alerts: window.__alerts || [],
  }));
}

test('markdown script tag is sanitized (C1)', async ({ page, request, baseURL }) => {
  const topic = `xss-markdown-${Date.now()}`;
  await withAlertSpy(page);
  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(topic);

  await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Markdown': '1', 'X-Title': 'mdxss' },
    data: '<script>window.__pwn = "md"</script><img src=x onerror="window.__pwn=\'img\'">payload',
  });

  await expect(page.locator('.message-card').first()).toBeVisible();
  // Give the browser a beat in case the injected script were going to fire.
  await page.waitForTimeout(200);

  const { pwn, alerts } = await readPwn(page);
  expect(pwn).toBeUndefined();
  expect(alerts).toHaveLength(0);
});

test('javascript: link in markdown is blocked (C2)', async ({ page, request, baseURL }) => {
  const topic = `xss-jslink-${Date.now()}`;
  await withAlertSpy(page);
  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(topic);

  await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Markdown': '1', 'X-Title': 'jslink' },
    data: '[click me](javascript:window.__pwn=\'js\')',
  });

  await expect(page.locator('.message-card').first()).toBeVisible();
  const link = page.locator('.message-card .msg-body a').first();
  // DOMPurify drops the javascript: href entirely. The anchor either has no
  // href or a sanitized one — clicking it must not execute JS.
  const href = await link.getAttribute('href').catch(() => null);
  expect(href === null || !/^javascript:/i.test(href)).toBeTruthy();

  if (href) {
    const urlBefore = page.url();
    await link.click();
    await page.waitForTimeout(200);
    expect(page.url()).toBe(urlBefore);
  }

  const { pwn, alerts } = await readPwn(page);
  expect(pwn).toBeUndefined();
  expect(alerts).toHaveLength(0);
});

test('tag-value breakout is escaped (C3)', async ({ page, request, baseURL }) => {
  const topic = `xss-tag-${Date.now()}`;
  await withAlertSpy(page);
  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(topic);

  // A tag value that would have broken out of the old single-quoted
  // onclick="setFilterTag('…')" attribute and executed JS in origin.
  const evilTag = "');window.__pwn='tag';//";
  await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Tags': evilTag, 'X-Title': 'tagxss' },
    data: 'hi',
  });

  const chip = page.locator('.message-card .msg-tags .tag-chip').first();
  await expect(chip).toBeVisible();
  // Clicking the chip must not execute the injected JS.
  await chip.click();
  await page.waitForTimeout(200);

  const { pwn, alerts } = await readPwn(page);
  expect(pwn).toBeUndefined();
  expect(alerts).toHaveLength(0);
});

test('X-Image attribute injection is escaped (C4)', async ({ page, request, baseURL }) => {
  const topic = `xss-image-${Date.now()}`;
  await withAlertSpy(page);
  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(topic);

  await request.post(`${baseURL}/${topic}`, {
    headers: {
      'X-Title': 'imgxss',
      'X-Image': '" onerror="window.__pwn=\'imgattr\'" x="',
    },
    data: 'body',
  });

  await expect(page.locator('.message-card').first()).toBeVisible();
  await page.waitForTimeout(300);

  const { pwn, alerts } = await readPwn(page);
  expect(pwn).toBeUndefined();
  expect(alerts).toHaveLength(0);
});

test('push subscribe rejects non-allowlisted endpoint (C5)', async ({ request, baseURL }) => {
  const topic = `xss-ssrf-${Date.now()}`;
  const res = await request.post(`${baseURL}/${topic}/push/subscribe`, {
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({
      endpoint: 'https://attacker.example.com/collect',
      keys: { p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U', auth: 'tBHItJI5svbpez7KI4CCXg' },
    }),
  });
  expect(res.status()).toBe(400);
});

test('security headers are present on the HTML shell', async ({ request, baseURL }) => {
  const res = await request.get(`${baseURL}/`);
  const headers = res.headers();
  expect(headers['content-security-policy']).toBeTruthy();
  expect(headers['content-security-policy']).toContain("default-src 'self'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['permissions-policy']).toBeTruthy();
  expect(headers['strict-transport-security']).toContain('max-age=');
  expect(headers['cache-control']).toContain('no-cache');
});
