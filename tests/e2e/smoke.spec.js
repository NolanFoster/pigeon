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

test('tag shortcodes render as emoji', async ({ page, request, baseURL }) => {
  const topic = `smoke-emoji-${Date.now()}`;

  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(topic);

  await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Title': 'Emoji', 'X-Tags': 'tada,eyes,white_check_mark,notashortcode' },
    data: 'hi',
  });

  const chips = page.locator('.message-card .msg-tags .tag-chip');
  await expect(chips).toHaveCount(4);
  await expect(chips.nth(0)).toHaveText('🎉');
  await expect(chips.nth(1)).toHaveText('👀');
  await expect(chips.nth(2)).toHaveText('✅');
  await expect(chips.nth(3)).toHaveText('notashortcode');

  // Filtering still keys off the raw shortcode — click the 🎉 chip, expect it to stick.
  await chips.nth(0).click();
  await expect(page.locator('.filter-banner strong')).toHaveText('🎉');
  await expect(page.locator('.message-card')).toHaveCount(1);
});

test('end-to-end encrypted topic: only subscribers with passphrase can read', async ({ page, request, baseURL }) => {
  const topic = `smoke-e2ee-${Date.now()}`;
  const passphrase = 'correct horse battery staple';
  const plaintext = 'top secret payload';
  const titleText = 'Secret';

  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#e2ee-checkbox').check();
  await page.locator('#e2ee-passphrase').fill(passphrase);
  await page.locator('#subscribe-btn').click();

  // Lock icon appears on the active topic tab once e2ee is configured.
  await expect(page.locator('.topic-tab.active .topic-lock')).toBeVisible();

  // Drive the encrypt+publish flow through the page's own JS — this avoids the
  // Toast UI editor's contenteditable quirks and exercises the same code path
  // the compose box uses.
  await page.evaluate(async ({ topic, title, message }) => {
    // eslint-disable-next-line no-undef
    const meta = JSON.parse(localStorage.getItem('pigeon_topic_meta') || '{}')[topic];
    // eslint-disable-next-line no-undef
    const rec = await PigeonKeystore.getTopicKey(topic);
    // eslint-disable-next-line no-undef
    const key = await PigeonCrypto.deriveKey(rec.passphrase, meta.salt, meta.iter);
    // eslint-disable-next-line no-undef
    const envelope = await PigeonCrypto.encryptFields(key, {
      title, message, tags: '', markdown: false,
    }, meta.salt, meta.iter);
    await fetch(`/${topic}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.pigeon.e2ee+json', 'X-Encrypted': '1' },
      body: envelope,
    });
  }, { topic, title: titleText, message: plaintext });

  const card = page.locator('.message-card').first();
  await expect(card).toBeVisible();
  await expect(card.locator('.msg-title')).toContainText(titleText);
  await expect(card.locator('.msg-body')).toContainText(plaintext);

  // Server-side view must contain ciphertext only.
  const raw = await request.get(`${baseURL}/${topic}/json?since=all`);
  const body = await raw.text();
  expect(body).not.toContain(plaintext);
  expect(body).not.toContain(`"${titleText}"`);
  expect(body).toContain('[encrypted]');
  expect(body).toContain('A256GCM-PBKDF2');
});

test('topics can be reordered via drag and drop', async ({ page }) => {
  await page.goto('/');

  // Add three topics
  const topics = ['topic-a', 'topic-b', 'topic-c'];
  for (const topic of topics) {
    await page.locator('#topic-input').fill(topic);
    await page.locator('#subscribe-btn').click();
    await expect(page.locator('.topic-tab.active')).toContainText(topic);
  }

  const tabs = page.locator('.topic-tab');
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(0)).toContainText('topic-a');
  await expect(tabs.nth(1)).toContainText('topic-b');
  await expect(tabs.nth(2)).toContainText('topic-c');

  // Drag 'topic-a' (index 0) onto 'topic-c' (index 2). SortableJS runs in
  // forceFallback mode, which tracks the drag through incremental mousemove
  // events — a single jump (Playwright's dragTo) never repositions the clone,
  // so we move in steps the way a real pointer drag does.
  const src = await tabs.nth(0).boundingBox();
  const dst = await tabs.nth(2).boundingBox();
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + src.width / 2 + 10, src.y + src.height / 2, { steps: 5 });
  await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 2, { steps: 10 });
  await page.mouse.move(dst.x + dst.width - 2, dst.y + dst.height / 2, { steps: 5 });
  await page.mouse.up();

  // The order should now be topic-b, topic-c, topic-a
  await expect(tabs.nth(0)).toContainText('topic-b');
  await expect(tabs.nth(1)).toContainText('topic-c');
  await expect(tabs.nth(2)).toContainText('topic-a');

  // Reload page to ensure order was saved to localStorage
  await page.reload();

  const reloadedTabs = page.locator('.topic-tab');
  await expect(reloadedTabs).toHaveCount(3);
  await expect(reloadedTabs.nth(0)).toContainText('topic-b');
  await expect(reloadedTabs.nth(1)).toContainText('topic-c');
  await expect(reloadedTabs.nth(2)).toContainText('topic-a');
});

test('topic tabs support click-to-switch and click-to-close with multiple topics', async ({ page }) => {
  await page.goto('/');

  // Emulate a real human click: press, jitter a few pixels, release. A plain
  // Playwright .click() is a synthetic zero-movement event that bypasses
  // SortableJS entirely — only a gesture with movement exposes the native-drag
  // bug where the browser eats the `click` and the tab never toggles/closes.
  async function realClick(locator, dx, dy) {
    const box = await locator.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy);
    await page.mouse.up();
  }

  for (const t of ['click-a', 'click-b', 'click-c']) {
    await page.locator('#topic-input').fill(t);
    await page.locator('#subscribe-btn').click();
    await expect(page.locator('.topic-tab.active')).toContainText(t);
  }

  // Switch tabs with ~6px of jitter on the (large) tab body. That movement is
  // within normal click jitter but is enough that Sortable's default native
  // HTML5 drag starts a drag and swallows the click — so this step fails before
  // the forceFallback fix and passes after it.
  await realClick(page.locator('.topic-tab', { hasText: 'click-a' }), 6, 2);
  await expect(page.locator('.topic-tab.active')).toContainText('click-a');

  // Remove via the × — a small target, so keep the jitter tiny enough to stay
  // on it (a larger move would retarget the click to the parent button).
  await realClick(page.locator('.topic-tab', { hasText: 'click-b' }).locator('.remove'), 2, 1);
  await expect(page.locator('.topic-tab')).toHaveCount(2);
  await expect(page.locator('.topic-tab.active')).toContainText('click-a');

  await realClick(page.locator('.topic-tab.active').locator('.remove'), 2, 1);
  await expect(page.locator('.topic-tab')).toHaveCount(1);
});
