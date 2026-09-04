import { test, expect } from '@playwright/test';

// Web Push can't be exercised for real in headless Chromium — there's no push
// service to hand out an endpoint. Everything under test here is the app's own
// bookkeeping (server registrations, stored intent, the retry queue), so the
// browser side is stubbed with a PushManager whose subscription survives a
// reload the way a real one does.
const ENDPOINT_KEY = '__pigeon_test_push_endpoint';

function installPushStub() {
  const KEY = '__pigeon_test_push_endpoint';
  window.__pushOps = [];

  const makeSubscription = (endpoint) => ({
    endpoint,
    getKey: () => new Uint8Array([1, 2, 3, 4]).buffer,
    unsubscribe: async () => {
      window.__pushOps.push('unsubscribe');
      localStorage.removeItem(KEY);
      return true;
    },
  });

  const registration = {
    scope: '/',
    pushManager: {
      getSubscription: async () => {
        const endpoint = localStorage.getItem(KEY);
        return endpoint ? makeSubscription(endpoint) : null;
      },
      subscribe: async () => {
        const endpoint = `https://fcm.googleapis.com/fcm/send/test-${Math.random().toString(36).slice(2)}`;
        localStorage.setItem(KEY, endpoint);
        window.__pushOps.push('subscribe');
        return makeSubscription(endpoint);
      },
    },
  };

  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: async () => registration,
      ready: Promise.resolve(registration),
      addEventListener() {},
      controller: null,
    },
  });

  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: { permission: 'granted', requestPermission: async () => 'granted' },
  });
}

// Records every push subscribe/unsubscribe call the page makes to the worker.
function trackPushRequests(page) {
  const calls = [];
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    if (path.endsWith('/push/subscribe')) calls.push(`${req.method()} ${path}`);
  });
  return calls;
}

// /vapid-key reads a secret that local dev and CI don't have. The stubbed
// PushManager never looks at the key, it just has to parse as base64url.
async function stubVapidKey(page) {
  await page.route('**/vapid-key', (route) => route.fulfill({
    status: 200,
    body: 'BIXUiAX4PJNjwJMTrFBN_HunYTLdTW514wbHUct-tTwHFvs1ljKb7kVPbIdNanJUL4SsIUe9z_H4MSkSJkKgD0I',
  }));
}

async function subscribeTopic(page, topic) {
  await page.locator('#topic-input').fill(topic);
  await page.locator('#subscribe-btn').click();
  await expect(page.locator('.topic-tab.active')).toContainText(topic);
}

test('push can be turned back off, and stays off across reloads', async ({ page }) => {
  const topic = `push-off-${Date.now()}`;
  await page.addInitScript(installPushStub);
  await stubVapidKey(page);
  const calls = trackPushRequests(page);

  await page.goto('/');
  await subscribeTopic(page, topic);

  const btn = page.locator('#enable-push-btn');
  await btn.click();
  await expect(btn).toHaveText('Disable Push Notifications');
  await expect.poll(() => calls).toContain(`POST /${topic}/push/subscribe`);

  // Intent survives a reload in both directions — on…
  await page.reload();
  await expect(btn).toHaveText('Disable Push Notifications');

  // The button used to become a disabled "Push Enabled" chip with no way back.
  await btn.click();
  await expect(btn).toHaveText('Enable Push Notifications');
  await expect(page.locator('.toast')).toContainText('Push notifications disabled');

  // Both halves of the teardown ran: server rows cleared for every topic, and
  // the browser endpoint revoked so nothing can be delivered to it.
  expect(calls).toContain('DELETE /push/subscribe');
  expect(await page.evaluate(() => window.__pushOps)).toContain('unsubscribe');

  // …and off.
  await page.reload();
  await expect(btn).toHaveText('Enable Push Notifications');
  expect(await page.evaluate(() => localStorage.getItem('pigeon_push_enabled'))).toBe('0');
});

test('a leftover subscription does not silently re-enable push on load', async ({ page }) => {
  const topic = `push-stale-${Date.now()}`;
  await page.addInitScript(installPushStub);
  await stubVapidKey(page);

  await page.goto('/');
  await subscribeTopic(page, topic);

  // Push is off, but the browser still holds a subscription — a teardown that
  // was interrupted. Every reload used to re-register it for every topic. The
  // leftover endpoint is still on the server's books (registrations remain), so
  // the next load finishes tearing it down.
  await page.evaluate(([key, endpoint]) => {
    localStorage.setItem('pigeon_push_enabled', '0');
    localStorage.setItem(key, endpoint);
    localStorage.setItem('pigeon_push_registrations', JSON.stringify([
      { topic: 'leftover-topic', endpoint },
    ]));
  }, [ENDPOINT_KEY, 'https://fcm.googleapis.com/fcm/send/leftover']);

  const calls = trackPushRequests(page);
  await page.reload();

  const btn = page.locator('#enable-push-btn');
  await expect(btn).toHaveText('Enable Push Notifications');
  await expect.poll(() => calls).toContain('DELETE /push/subscribe');
  expect(calls.filter(c => c.startsWith('POST'))).toHaveLength(0);
  await expect.poll(() => page.evaluate(() => window.__pushOps)).toContain('unsubscribe');
});

test('a Chrome Undo of a shade unsubscribe does not silently re-subscribe', async ({ page }) => {
  await page.addInitScript(installPushStub);
  await stubVapidKey(page);

  await page.goto('/');

  // Permission is granted and a subscription exists, but the durable off switch
  // is set — the signature of Chrome's Undo after a shade unsubscribe. Nothing
  // is owed to the server, so this must not tear down or re-register: stay off
  // and offer Enable Push.
  await page.evaluate(([key, endpoint]) => {
    localStorage.setItem('pigeon_push_enabled', '0');
    localStorage.setItem(key, endpoint);
    localStorage.removeItem('pigeon_push_registrations');
    localStorage.removeItem('pigeon_push_pending_unsub');
  }, [ENDPOINT_KEY, 'https://fcm.googleapis.com/fcm/send/undo']);

  const calls = trackPushRequests(page);
  await page.reload();

  await expect(page.locator('#enable-push-btn')).toHaveText('Enable Push Notifications');
  await expect(page.locator('.toast')).toContainText('Chrome still allows notifications');

  // No teardown, no re-registration, no unsubscribe of the restored subscription.
  expect(calls.filter(c => c.startsWith('POST'))).toHaveLength(0);
  expect(calls.filter(c => c.startsWith('DELETE'))).toHaveLength(0);
  expect(await page.evaluate(() => window.__pushOps)).not.toContain('unsubscribe');
});

test('unsubscribing a topic clears its push registration on the server', async ({ page }) => {
  const topic = `push-topic-${Date.now()}`;
  await page.addInitScript(installPushStub);
  await stubVapidKey(page);
  const calls = trackPushRequests(page);

  await page.goto('/');
  await subscribeTopic(page, topic);
  await page.locator('#enable-push-btn').click();
  await expect(page.locator('#enable-push-btn')).toHaveText('Disable Push Notifications');

  await page.locator('.topic-tab .remove').click();
  await expect(page.locator('.topic-tab')).toHaveCount(0);

  // Closing the tab used to leave the row in place, so the topic kept pushing.
  await expect.poll(() => calls).toContain(`DELETE /${topic}/push/subscribe`);
});

test('a disable the server never acknowledged is retried on the next load', async ({ page }) => {
  const topic = `push-retry-${Date.now()}`;
  await page.addInitScript(installPushStub);
  await stubVapidKey(page);

  await page.goto('/');
  await subscribeTopic(page, topic);
  const btn = page.locator('#enable-push-btn');
  await btn.click();
  await expect(btn).toHaveText('Disable Push Notifications');

  // Disable while the network is down for the unsubscribe call.
  await page.route('**/push/subscribe', (route) =>
    route.request().method() === 'DELETE' ? route.abort() : route.continue());
  await btn.click();

  // Locally push is off regardless — the endpoint is revoked, so nothing can be
  // delivered — and the unacknowledged delete becomes a durable to-do.
  await expect(btn).toHaveText('Enable Push Notifications');
  await expect(page.locator('#push-hint')).toContainText('Still clearing it on the server');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pigeon_push_pending_unsub') || '[]')))
    .toHaveLength(1);

  await page.unroute('**/push/subscribe');
  const calls = trackPushRequests(page);
  await page.reload();

  await expect.poll(() => calls).toContain('DELETE /push/subscribe');
  await expect.poll(() =>
    page.evaluate(() => JSON.parse(localStorage.getItem('pigeon_push_pending_unsub') || '[]').length))
    .toBe(0);
  await expect(page.locator('#push-hint')).not.toContainText('Still clearing it on the server');
});
