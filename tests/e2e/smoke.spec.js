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

test('message images reserve layout space and use their title as alt text', async ({ page, request, baseURL }) => {
  const topic = `smoke-image-${Date.now()}`;
  const title = 'A field of wildflowers';

  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(topic);

  const res = await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Title': title, 'X-Image': 'https://example.com/wildflowers.jpg' },
    data: 'Image message',
  });
  expect(res.ok()).toBeTruthy();

  // Realtime delivery (WS upgrade + history fetch + bounded retry) can take a
  // few seconds; wait for the message to land before asserting its image.
  await expect(page.locator('.message-card')).toHaveCount(1, { timeout: 15_000 });
  const image = page.locator('.message-card .msg-image img');
  await expect(image).toHaveAttribute('alt', title);
  await expect(image).toHaveCSS('aspect-ratio', '16 / 9');

  const tagsInput = page.locator('#compose-tags');
  await expect(tagsInput).toHaveCSS('padding-left', '28px');
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

  // Filter chips toggle a selected state and all chips stay visible while
  // filtering (no banner replaces the row).
  const alphaChip = page.locator('.tags-row .tag-chip', { hasText: 'alpha' });
  await alphaChip.click();
  await expect(alphaChip).toHaveClass(/is-active/);
  await expect(alphaChip).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.message-card')).toHaveCount(1);
  await expect(page.locator('.message-card .msg-title')).toContainText('Alpha');
  await expect(page.locator('.tags-row .tag-chip', { hasText: 'beta' })).toBeVisible();

  await page.locator('.clear-filter-btn').click();
  await expect(page.locator('.message-card')).toHaveCount(2);
});

test('tag shortcodes decorate the label instead of replacing it', async ({ page, request, baseURL }) => {
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
  // The real tag name is always present; the emoji is decorative and additive.
  await expect(chips.nth(0)).toContainText('tada');
  await expect(chips.nth(1)).toContainText('eyes');
  await expect(chips.nth(2)).toContainText('white_check_mark');
  await expect(chips.nth(3)).toHaveText('notashortcode');
  await expect(chips.nth(0).locator('.tag-chip-emoji')).toHaveText('🎉');

  // Filtering still keys off the raw shortcode — click the tada chip and the
  // filter row shows it selected.
  await chips.nth(0).click();
  await expect(page.locator('.tags-row .tag-chip', { hasText: 'tada' })).toHaveClass(/is-active/);
  await expect(page.locator('.message-card')).toHaveCount(1);
});

test('multi-tag filtering is AND-ed, per-topic, and reflected in the URL', async ({ page, request, baseURL }) => {
  const topic = `smoke-multi-${Date.now()}`;

  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(topic);

  await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Title': 'Both', 'X-Tags': 'alpha,beta' },
    data: 'both',
  });
  await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Title': 'Alpha only', 'X-Tags': 'alpha' },
    data: 'alpha',
  });
  await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Title': 'Beta only', 'X-Tags': 'beta' },
    data: 'beta',
  });
  await expect(page.locator('.message-card')).toHaveCount(3);

  // Two active chips narrow the list with AND semantics.
  await page.locator('.tags-row .tag-chip', { hasText: 'alpha' }).click();
  await expect(page.locator('.message-card')).toHaveCount(2);
  await page.locator('.tags-row .tag-chip', { hasText: 'beta' }).click();
  await expect(page.locator('.message-card')).toHaveCount(1);
  await expect(page.locator('.message-card .msg-title')).toContainText('Both');

  // The filter is mirrored in the URL query string.
  await expect.poll(() => new URL(page.url()).searchParams.get('tags')).toBe('alpha,beta');

  // Reload restores the same filtered view.
  await page.reload();
  await expect(page.locator('.topic-tab.active')).toContainText(topic);
  await expect(page.locator('.message-card')).toHaveCount(1);
  await expect(page.locator('.tags-row .tag-chip', { hasText: 'alpha' })).toHaveClass(/is-active/);
  await expect(page.locator('.tags-row .tag-chip', { hasText: 'beta' })).toHaveClass(/is-active/);

  // Toggling one chip off leaves only the other filter applied.
  await page.locator('.tags-row .tag-chip', { hasText: 'beta' }).click();
  await expect(page.locator('.message-card')).toHaveCount(2);
  await expect.poll(() => page.url()).toContain('tags=alpha');
  await expect.poll(() => page.url()).not.toContain('beta');
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
  const src = await tabs.nth(0).locator('.topic-tab-select').boundingBox();
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
  await realClick(page.locator('.topic-tab', { hasText: 'click-a' }).locator('.topic-tab-select'), 6, 2);
  await expect(page.locator('.topic-tab.active')).toContainText('click-a');

  // Remove via the × — a small target, so keep the jitter tiny enough to stay
  // on it (a larger move would retarget the click to the parent button).
  await realClick(page.locator('.topic-tab', { hasText: 'click-b' }).locator('.remove'), 2, 1);
  await expect(page.locator('.topic-tab')).toHaveCount(2);
  await expect(page.locator('.topic-tab.active')).toContainText('click-a');

  await realClick(page.locator('.topic-tab.active').locator('.remove'), 2, 1);
  await expect(page.locator('.topic-tab')).toHaveCount(1);
});

test('Clear requires confirmation and can be cancelled', async ({ page, request, baseURL }) => {
  const topic = `smoke-clear-${Date.now()}`;

  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(topic);

  await request.post(`${baseURL}/${topic}`, { data: 'keep me' });
  await expect(page.locator('.message-card')).toHaveCount(1);

  // Cancelling the dialog must leave the messages alone.
  await page.locator('#clear-messages-btn').click();
  const dialog = page.locator('#app-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('permanently deletes');
  await page.locator('#app-dialog-cancel').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.message-card')).toHaveCount(1);

  // Confirming deletes and reports what happened.
  await page.locator('#clear-messages-btn').click();
  await page.locator('#app-dialog-confirm').click();
  await expect(page.locator('.message-card')).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('Deleted 1 message');
});

test('unsubscribing a plain topic offers an undo', async ({ page }) => {
  await page.goto('/');
  const topic = `smoke-undo-${Date.now()}`;
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab')).toHaveCount(1);

  await page.locator('.topic-tab .remove').click();
  await expect(page.locator('.topic-tab')).toHaveCount(0);

  await page.locator('.toast-action', { hasText: 'Undo' }).click();
  await expect(page.locator('.topic-tab')).toHaveCount(1);
  await expect(page.locator('.topic-tab')).toContainText(topic);
});

test('an arriving message does not steal keyboard focus', async ({ page, request, baseURL }) => {
  const topic = `smoke-focus-${Date.now()}`;

  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(topic);

  await request.post(`${baseURL}/${topic}`, { headers: { 'X-Title': 'First' }, data: 'one' });
  await expect(page.locator('.message-card')).toHaveCount(1);

  // Park focus on the first card's copy button, then publish a second message.
  await page.locator('.message-card .copy-btn').first().focus();
  const before = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  expect(before).toContain('First');

  await request.post(`${baseURL}/${topic}`, { headers: { 'X-Title': 'Second' }, data: 'two' });
  await expect(page.locator('.message-card')).toHaveCount(2);

  // The list used to be rebuilt via innerHTML on every arrival, which dropped
  // focus to <body>.
  const after = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  expect(after).toBe(before);
});

test('tag chips are reachable and operable by keyboard', async ({ page, request, baseURL }) => {
  const topic = `smoke-kbd-${Date.now()}`;

  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(topic);

  await request.post(`${baseURL}/${topic}`, { headers: { 'X-Title': 'A', 'X-Tags': 'alpha' }, data: 'first' });
  await request.post(`${baseURL}/${topic}`, { headers: { 'X-Title': 'B', 'X-Tags': 'beta' }, data: 'second' });
  await expect(page.locator('.message-card')).toHaveCount(2);

  const chip = page.locator('.tags-row .tag-chip', { hasText: 'alpha' });
  await expect(chip).toHaveJSProperty('tagName', 'BUTTON');
  await chip.focus();
  await page.keyboard.press('Enter');

  await expect(chip).toHaveClass(/is-active/);
  await expect(page.locator('.message-card')).toHaveCount(1);
});

test('topic tabs implement the ARIA tabs pattern with arrow-key navigation', async ({ page }) => {
  await page.goto('/');
  for (const t of ['kb-a', 'kb-b']) {
    await page.locator('#topic-input').fill(t);
    await page.locator('#subscribe-btn').click();
    await expect(page.locator('.topic-tab.active')).toContainText(t);
  }

  const tabs = page.locator('.topic-tab-select');
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('#topic-tabs')).toHaveAttribute('role', 'tablist');

  // Roving tabindex: only the selected tab is in the tab order.
  await expect(tabs.nth(1)).toHaveJSProperty('tabIndex', 0);
  await expect(tabs.nth(0)).toHaveJSProperty('tabIndex', -1);

  await tabs.nth(1).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.topic-tab.active')).toContainText('kb-a');
});

test('a failed publish reports the error and keeps the composed text', async ({ page }) => {
  const topic = `smoke-fail-${Date.now()}`;

  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(topic);

  // Fail only the publish POST, leaving the WebSocket and history intact.
  await page.route(`**/${topic}`, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 500, body: 'nope' })
      : route.continue());

  await page.evaluate(() => editor.setMarkdown('this should survive'));
  await page.locator('#send-btn').click();

  await expect(page.locator('.toast-error')).toContainText("Couldn't send your message");
  // The draft used to be discarded even when the publish failed.
  await expect.poll(() => page.evaluate(() => editor.getMarkdown()))
    .toBe('this should survive');
});

test('ticking a todo below the top of the list keeps its place and keeps focus', async ({ page, request, baseURL }) => {
  const topic = `smoke-todo-${Date.now()}`;

  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(topic);

  // Oldest first, so "Older task" ends up at the bottom of the newest-first list.
  for (const title of ['Older task', 'Middle task', 'Newest task']) {
    const res = await request.post(`${baseURL}/${topic}`, {
      headers: { 'X-Title': title, 'X-Tags': 'todo' },
      data: `body of ${title}`,
    });
    expect(res.ok()).toBeTruthy();
  }
  await expect(page.locator('.message-card')).toHaveCount(3);

  // The title element also carries a priority badge, so read just its text node.
  const titles = () => page.locator('.message-card .msg-title')
    .evaluateAll(els => els.map(el => el.firstChild.textContent.trim()));
  expect(await titles()).toEqual(['Newest task', 'Middle task', 'Older task']);

  const middleBox = page.locator('.message-card', { hasText: 'Middle task' }).locator('.todo-checkbox');
  await middleBox.click();

  // Completed, still second in the list — ticking must not reorder anything.
  await expect(page.locator('.message-card', { hasText: 'Middle task' })).toHaveClass(/is-done/);
  expect(await titles()).toEqual(['Newest task', 'Middle task', 'Older task']);

  // The card is rebuilt around the new state; focus has to survive that.
  await expect.poll(() => page.evaluate(() => {
    const el = document.activeElement;
    if (!el || !el.classList.contains('todo-checkbox')) return el ? el.tagName : 'none';
    return el.closest('.message-card').querySelector('.msg-title').firstChild.textContent.trim();
  })).toBe('Middle task');

  // A completed todo stays tickable: unticking is the undo for a mis-click.
  const doneBox = page.locator('.message-card', { hasText: 'Middle task' }).locator('.todo-checkbox');
  await expect(doneBox).toBeEnabled();
  await doneBox.click();
  await expect(page.locator('.message-card', { hasText: 'Middle task' })).not.toHaveClass(/is-done/);
  expect(await titles()).toEqual(['Newest task', 'Middle task', 'Older task']);
});

test('ticking a markdown task keeps its message in place and keeps focus', async ({ page, request, baseURL }) => {
  const topic = `smoke-mdtask-${Date.now()}`;

  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(topic);

  await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Title': 'Checklist', 'X-Markdown': '1' },
    data: '- [ ] first thing\n- [ ] second thing',
  });
  await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Title': 'Later note' },
    data: 'arrived after the checklist',
  });

  await expect(page.locator('.message-card')).toHaveCount(2);
  const titles = () => page.locator('.message-card .msg-title')
    .evaluateAll(els => els.map(el => el.firstChild.textContent.trim()));
  expect(await titles()).toEqual(['Later note', 'Checklist']);

  // Ticking republishes the message under a new id; it used to reappear at the
  // top of the list with focus dropped to <body>.
  await page.locator('.md-task-checkbox').first().click();

  await expect.poll(titles).toEqual(['Later note', 'Checklist']);
  const checklistCard = page.locator('.message-card:has(.md-task-checkbox)');
  await expect(checklistCard.locator('.md-task-checkbox').first()).toBeChecked();
  await expect(page.locator('.message-card')).toHaveCount(2);

  await expect.poll(() => page.evaluate(() => {
    const el = document.activeElement;
    return el && el.dataset ? `${el.className}:${el.dataset.taskIndex}` : 'none';
  })).toBe('md-task-checkbox:0');

  // And the republished card must not replay the entrance animation.
  await expect(checklistCard).not.toHaveClass(/is-new/);
});

test('todo cards avoid duplicate title and body content', async ({ page, request, baseURL }) => {
  const topic = `smoke-card-${Date.now()}`;
  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();

  const res = await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Title': 'Buy milk', 'X-Tags': 'todo' },
    data: 'Buy milk',
  });
  expect(res.ok()).toBeTruthy();
  const card = page.locator('.message-card');
  await expect(card.locator('.msg-title')).toHaveText(/Buy milk/);
  await expect(card.locator('.msg-body')).toHaveCount(0);
  await expect(card.locator('.delete-btn')).toHaveAttribute('aria-label', 'Delete message: Buy milk');
});

test('deleting a message requires confirmation', async ({ page, request, baseURL }) => {
  const topic = `smoke-delete-${Date.now()}`;
  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  const res = await request.post(`${baseURL}/${topic}`, { headers: { 'X-Title': 'Disposable' }, data: 'remove me' });
  expect(res.ok()).toBeTruthy();

  await page.locator('.message-card .delete-btn').click();
  await expect(page.locator('#app-dialog')).toContainText('Delete message?');
  await page.locator('#app-dialog-cancel').click();
  await expect(page.locator('.message-card')).toHaveCount(1);

  await page.locator('.message-card .delete-btn').click();
  await page.locator('#app-dialog-confirm').click();
  await expect(page.locator('.message-card')).toHaveCount(0);
});

test('untitled messages lead with their body instead of the topic name', async ({ page, request, baseURL }) => {
  const topic = `smoke-untitled-${Date.now()}`;
  await page.goto('/');
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  const res = await request.post(`${baseURL}/${topic}`, { data: 'Body with no title' });
  expect(res.ok()).toBeTruthy();

  const card = page.locator('.message-card');
  await expect(card.locator('.msg-title')).toHaveCount(0);
  await expect(card.locator('.msg-body')).toHaveText('Body with no title');
});

test('the composer is pinned to the bottom and the docs panel is collapsible', async ({ page }) => {
  await page.goto('/');

  // Subscribe so the messages section (and the composer inside it) is shown.
  const topic = `smoke-compose-${Date.now()}`;
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(topic);
  await expect(page.locator('.compose')).toBeVisible();

  // The compose box is the primary action — it must stay anchored so a long
  // message list can't bury it (issue: "compose box is buried below an
  // unbounded message list").
  await expect(page.locator('.compose')).toHaveCSS('position', 'sticky');
  await expect(page.locator('.compose')).toHaveCSS('bottom', '0px');

  // The curl examples are out of the main scroll flow: collapsed by default,
  // expandable on demand.
  const usage = page.locator('details.usage');
  await expect(usage).toHaveCount(1);
  await expect(usage).not.toHaveAttribute('open', '');
  await usage.locator('summary.usage-summary').click();
  await expect(usage).toHaveAttribute('open', '');
});
