import { test, expect } from '@playwright/test';

// Delivery-budget contract (#47): publish field caps, poll replay bounds, and
// the single-message fetch. The web-push payload truncation itself can't be
// observed from headless Chromium (no push service hands out an endpoint), so
// those parts live in the Rust unit tests; the HTTP-visible behaviour is here.

async function publishMany(request, baseURL, topic, n, concurrency = 25) {
  for (let i = 0; i < n; i += concurrency) {
    const batch = [];
    for (let j = i; j < Math.min(i + concurrency, n); j += 1) {
      batch.push(request.post(`${baseURL}/${topic}`, { data: `msg ${j}` }));
    }
    await Promise.all(batch);
  }
}

test('title over 1024 bytes is rejected with 400 and no row is stored', async ({ request, baseURL }) => {
  const topic = `db-title-${Date.now()}`;

  const tooLong = await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Title': 'a'.repeat(1025) },
    data: 'hello',
  });
  expect(tooLong.status()).toBe(400);
  expect(await tooLong.text()).toBe('title too long');

  // Nothing was inserted.
  const poll = await request.get(`${baseURL}/${topic}/json?since=all`);
  expect(await poll.json()).toEqual([]);

  // Exactly 1024 bytes succeeds.
  const ok = await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Title': 'a'.repeat(1024) },
    data: 'hello',
  });
  expect(ok.status()).toBe(200);
});

test('tags over 512 bytes are rejected with 400', async ({ request, baseURL }) => {
  const topic = `db-tags-${Date.now()}`;

  const tooLong = await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Tags': 'a'.repeat(513) },
    data: 'hello',
  });
  expect(tooLong.status()).toBe(400);
  expect(await tooLong.text()).toBe('tags too long');

  const ok = await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Tags': 'a'.repeat(512) },
    data: 'hello',
  });
  expect(ok.status()).toBe(200);
});

test('an 8000-byte body publishes and round-trips in full via the poll', async ({ request, baseURL }) => {
  const topic = `db-body-${Date.now()}`;
  const big = 'x'.repeat(8000);

  const res = await request.post(`${baseURL}/${topic}`, { data: big });
  expect(res.status()).toBe(200);

  const poll = await request.get(`${baseURL}/${topic}/json?since=all`);
  const body = await poll.text();
  expect(body).toContain(big);
});

test('poll replay is capped at the newest 500 with X-Messages-Truncated', async ({ request, baseURL }) => {
  const topic = `db-replay-${Date.now()}`;

  await publishMany(request, baseURL, topic, 600);

  const res = await request.get(`${baseURL}/${topic}/json?since=all`);
  expect(res.status()).toBe(200);
  expect(res.headers()['x-messages-truncated']).toBe('1');

  const messages = await res.json();
  expect(messages).toHaveLength(500);

  const bodies = messages.map((m) => m.message);
  // Newest 500 kept: the last message is present, the very first is dropped.
  expect(bodies).toContain('msg 599');
  expect(bodies).not.toContain('msg 0');
});

test('single-message fetch returns the row and 404s on unknown id', async ({ request, baseURL }) => {
  const topic = `db-getone-${Date.now()}`;

  const res = await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Title': 'Fetch me' },
    data: 'hello world',
  });
  expect(res.status()).toBe(200);
  const published = await res.json();

  const fetched = await request.get(`${baseURL}/${topic}/messages/${published.id}`);
  expect(fetched.status()).toBe(200);
  const row = await fetched.json();
  expect(row.id).toBe(published.id);
  expect(row.message).toBe('hello world');
  expect(row.title).toBe('Fetch me');

  const missing = await request.get(`${baseURL}/${topic}/messages/does-not-exist`);
  expect(missing.status()).toBe(404);
});
