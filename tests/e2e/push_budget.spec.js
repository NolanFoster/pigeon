import { test, expect } from '@playwright/test';

// Origin budget (#61): the HTTP-visible surface. Chrome scores the origin
// once a day, so the day counter is shared by every topic; tests therefore
// read the starting value and assert the delta, never an absolute count. The
// fan-out 429-stop and the 60-second pause are not observable from headless
// Chromium (no push service hands out a real endpoint that returns 429), so
// that logic lives in the worker and its Rust unit tests.

test('GET /push/budget returns a counter, not a log', async ({ request, baseURL }) => {
  const res = await request.get(`${baseURL}/push/budget`);
  expect(res.status()).toBe(200);
  const text = await res.text();
  const body = JSON.parse(text);

  expect(body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  for (const k of ['attempted', 'skipped', 'throttled']) {
    expect(typeof body[k]).toBe('number');
  }
  expect(Object.prototype.hasOwnProperty.call(body, 'paused_until')).toBe(true);
  expect(Object.prototype.hasOwnProperty.call(body, 'warn')).toBe(true);

  // A counter, not a log: no topic, endpoint, key, hash, or message body.
  for (const leak of ['topic', 'endpoint', 'p256dh', 'auth', 'hash', 'message']) {
    expect(Object.keys(body)).not.toContain(leak);
  }
  expect(text).not.toContain('fcm.googleapis.com');
  expect(text).not.toContain('push.apple.com');
});

test('publish without subscribers still names the day count', async ({ request, baseURL }) => {
  const before = JSON.parse(await (await request.get(`${baseURL}/push/budget`)).text());
  const topic = `budget-nosub-${Date.now()}`;

  const res = await request.post(`${baseURL}/${topic}`, { data: 'hello' });
  expect(res.status()).toBe(200);
  expect(res.headers()['x-push-budget-day']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(res.headers()['x-push-attempted-today']).toBe(String(before.attempted));
  expect(res.headers()['x-push-attempted']).toBe('0');
  expect(res.headers()['x-push-receipts']).toBeUndefined();
});

test('X-Push: 0 stores and broadcasts but does not fan out', async ({ request, baseURL }) => {
  const topic = `budget-off-${Date.now()}`;

  const res = await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Push': '0' },
    data: 'stored but not pushed',
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['x-push-attempted']).toBe('0');
  expect(res.headers()['x-push-receipts']).toBeUndefined();
  expect(res.headers()['x-push-budget-day']).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // The message is still stored for watchers.
  const poll = await request.get(`${baseURL}/${topic}/json?since=all`);
  const messages = await poll.json();
  expect(messages.map((m) => m.message)).toContain('stored but not pushed');
});

test('X-Push: maybe is 400 push invalid; X-Push: on is a no-op', async ({ request, baseURL }) => {
  const topic = `budget-invalid-${Date.now()}`;

  const bad = await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Push': 'maybe' },
    data: 'x',
  });
  expect(bad.status()).toBe(400);
  expect(await bad.text()).toBe('push invalid');

  const ok = await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Push': 'on' },
    data: 'y',
  });
  expect(ok.status()).toBe(200);
});

test('priority 5 does not override X-Push: 0', async ({ request, baseURL }) => {
  const topic = `budget-p5off-${Date.now()}`;

  const res = await request.post(`${baseURL}/${topic}`, {
    headers: { 'X-Push': '0', 'X-Priority': '5' },
    data: 'fire alert that still only stores',
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['x-push-attempted']).toBe('0');
  expect(res.headers()['x-push-receipts']).toBeUndefined();
});

test('a subscribed publish increments the day count optimistically', async ({ request, baseURL }) => {
  const before = JSON.parse(await (await request.get(`${baseURL}/push/budget`)).text());
  const topic = `budget-count-${Date.now()}`;

  // Subscribe an endpoint directly (a valid push-service host) — the browser
  // side is irrelevant here; the worker's fan-out only needs a stored row.
  const endpoint = `https://fcm.googleapis.com/fcm/send/test-${Date.now()}`;
  const sub = await request.post(`${baseURL}/${topic}/push/subscribe`, {
    data: { endpoint, keys: { p256dh: 'AAAA', auth: 'BBBB' } },
  });
  expect(sub.status()).toBe(200);

  const first = await request.post(`${baseURL}/${topic}`, { data: 'one' });
  expect(first.status()).toBe(200);
  expect(first.headers()['x-push-attempted']).toBe('1');
  expect(first.headers()['x-push-attempted-today']).toBe(String(before.attempted + 1));

  const second = await request.post(`${baseURL}/${topic}`, { data: 'two' });
  expect(second.status()).toBe(200);
  expect(second.headers()['x-push-attempted']).toBe('1');
  expect(second.headers()['x-push-attempted-today']).toBe(String(before.attempted + 2));
});
