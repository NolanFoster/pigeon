'use strict';

// Unit tests for the service-worker notification logic in public/sw.js.
//
// sw.js is a classic worker script (importScripts + `self`), so it can't be
// `require`d. We load it into a fresh vm context with stubbed worker globals and
// exercise the pure helpers (normalizePriority, tagFor, buildCopyAction,
// audibleDecision) and showNotificationFor/copyShadeBody through a captured
// registration.showNotification.
//
// Objects returned by the vm realm have a different Object.prototype, so we
// assert on primitive fields rather than deep-equal whole objects.
//
// Run with: node --test tests/sw_notification.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');

function loadSW(overrides = {}) {
  const calls = { shown: [], openWindows: [], setAudible: [] };

  const sandbox = {
    importScripts: () => {},
    console: { warn() {}, log() {}, error() {} },
    TextEncoder,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    Intl,
    Date: { now: () => overrides.now ?? 1_000_000_000 },
    addEventListener: () => {},
    skipWaiting: () => {},
    registration: {
      showNotification: async (title, options) => {
        calls.shown.push({ title, options });
      },
    },
    clients: {
      openWindow: async (url) => {
        calls.openWindows.push(url);
      },
      claim: async () => {},
    },
    location: { origin: 'https://pigeon.test' },
    caches: {
      open: async () => ({ addAll: async () => {}, put: async () => {} }),
      keys: async () => [],
      delete: async () => {},
      match: async () => null,
    },
    fetch: async () => { throw new Error('fetch not stubbed'); },
    Notification: { maxActions: 2 },
    navigator: {},
    PigeonCrypto: {},
    PigeonKeystore: {
      getLastAudibleAt: async () => null,
      setLastAudibleAt: async (ms) => { calls.setAudible.push(ms); },
      ...(overrides.keystore || {}),
    },
    ...(overrides.globals || {}),
  };
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox, { filename: 'sw.js' });

  return { sandbox, calls };
}

function message(overrides = {}) {
  return {
    title: 'Backup failed',
    body: 'disk2 needs attention',
    topic: 'alerts',
    id: 'msg-1',
    click: undefined,
    image: undefined,
    priority: 3,
    ...overrides,
  };
}

test('normalizePriority maps missing/unparseable to 3 and clamps to 1–5', () => {
  const { sandbox } = loadSW();
  assert.equal(sandbox.normalizePriority(1), 1);
  assert.equal(sandbox.normalizePriority(5), 5);
  assert.equal(sandbox.normalizePriority('4'), 4);
  assert.equal(sandbox.normalizePriority(undefined), 3);
  assert.equal(sandbox.normalizePriority('garbage'), 3);
  assert.equal(sandbox.normalizePriority(9), 3);
  assert.equal(sandbox.normalizePriority(0), 3);
});

test('tagFor collapses priorities 1–4 per topic and keeps 5 unique', () => {
  const { sandbox } = loadSW();
  assert.equal(sandbox.tagFor(message({ priority: 1 }), 1), 'pigeon:alerts');
  assert.equal(sandbox.tagFor(message({ priority: 4 }), 4), 'pigeon:alerts');
  assert.equal(sandbox.tagFor(message({ priority: 5 }), 5), 'pigeon:alerts:msg-1');
  // Priority 5 without an id falls back to no tag (unique by default).
  assert.equal(sandbox.tagFor(message({ id: undefined, priority: 5 }), 5), undefined);
  // No topic falls back to the id rather than "pigeon:undefined".
  assert.equal(sandbox.tagFor(message({ topic: undefined }), 3), 'msg-1');
});

test('audibleDecision: priorities 1–3 are always silent and never update the clock', async () => {
  const { sandbox } = loadSW();
  for (const p of [1, 2, 3]) {
    const r = await sandbox.audibleDecision(p);
    assert.equal(r.silent, true);
    assert.equal(r.update, false);
  }
});

test('audibleDecision: priority 5 always tries and updates the clock', async () => {
  const { sandbox } = loadSW();
  const r = await sandbox.audibleDecision(5);
  assert.equal(r.silent, false);
  assert.equal(r.update, true);
});

test('audibleDecision: priority 4 is audible when no audible recorded yet', async () => {
  const { sandbox } = loadSW({ keystore: { getLastAudibleAt: async () => null } });
  const r = await sandbox.audibleDecision(4);
  assert.equal(r.silent, false);
  assert.equal(r.update, true);
});

test('audibleDecision: priority 4 is silent within the 60s window', async () => {
  const now = 1_000_000_000;
  const { sandbox } = loadSW({
    now,
    keystore: { getLastAudibleAt: async () => now - 20_000 },
  });
  const r = await sandbox.audibleDecision(4);
  assert.equal(r.silent, true);
  assert.equal(r.update, false);
});

test('audibleDecision: priority 4 is audible once the window has passed', async () => {
  const now = 1_000_000_000;
  const { sandbox } = loadSW({
    now,
    keystore: { getLastAudibleAt: async () => now - 60_000 },
  });
  const r = await sandbox.audibleDecision(4);
  assert.equal(r.silent, false);
  assert.equal(r.update, true);
});

test('audibleDecision: IDB unavailable fails closed (priority 4 silent, 5 audible)', async () => {
  const boom = async () => { throw new Error('IDB blocked'); };
  const { sandbox } = loadSW({ keystore: { getLastAudibleAt: boom } });
  assert.equal((await sandbox.audibleDecision(4)).silent, true);
  assert.equal((await sandbox.audibleDecision(5)).silent, false);
});

test('showNotificationFor: p3 is silent, collapsed tag, Copy action, no clock write', async () => {
  const { sandbox, calls } = loadSW();
  await sandbox.showNotificationFor(message({ priority: 3 }));
  assert.equal(calls.shown.length, 1);
  const { options } = calls.shown[0];
  assert.equal(options.silent, true);
  assert.equal(options.tag, 'pigeon:alerts');
  assert.equal(options.actions.length, 1);
  assert.equal(options.actions[0].action, 'pigeon-copy');
  assert.equal(options.actions[0].title, 'Copy');
  assert.equal(calls.setAudible.length, 0);
});

test('showNotificationFor: p5 is audible, unique tag, Copy action, writes the clock', async () => {
  const now = 1_000_000_000;
  const { sandbox, calls } = loadSW({ now });
  await sandbox.showNotificationFor(message({ priority: 5 }));
  assert.equal(calls.shown.length, 1);
  const { options } = calls.shown[0];
  assert.equal(options.silent, false);
  assert.equal(options.tag, 'pigeon:alerts:msg-1');
  assert.equal(options.actions.length, 1);
  assert.equal(options.actions[0].action, 'pigeon-copy');
  assert.deepEqual(calls.setAudible, [now]);
});

test('showNotificationFor: generic encrypted placeholder omits the Copy action', async () => {
  const { sandbox, calls } = loadSW();
  await sandbox.showNotificationFor({
    title: '🔒 alerts',
    body: 'New encrypted message',
    topic: 'alerts',
    id: 'msg-1',
    priority: 5,
    placeholder: true,
  });
  assert.equal(calls.shown[0].options.actions, undefined);
});

test('showNotificationFor: empty body omits the Copy action', async () => {
  const { sandbox, calls } = loadSW();
  await sandbox.showNotificationFor(message({ body: '' }));
  assert.equal(calls.shown[0].options.actions, undefined);
});

test('showNotificationFor: Notification.maxActions === 0 omits the Copy action', async () => {
  const { sandbox, calls } = loadSW({ globals: { Notification: { maxActions: 0 } } });
  await sandbox.showNotificationFor(message());
  assert.equal(calls.shown[0].options.actions, undefined);
});

test('showNotificationFor: notification.data carries the body for copyShadeBody', async () => {
  const { sandbox, calls } = loadSW();
  await sandbox.showNotificationFor(message());
  const data = calls.shown[0].options.data;
  assert.equal(data.body, 'disk2 needs attention');
  assert.equal(data.title, 'Backup failed');
  assert.equal(data.topic, 'alerts');
  assert.equal(data.id, 'msg-1');
});

test('copyShadeBody: prefers navigator.clipboard when the SW has it', async () => {
  const written = [];
  const { sandbox, calls } = loadSW({
    globals: {
      navigator: { clipboard: { writeText: async (t) => { written.push(t); } } },
    },
  });
  await sandbox.copyShadeBody({ body: 'OTP 123456', topic: 'alerts' });
  assert.deepEqual(written, ['OTP 123456']);
  assert.deepEqual(calls.openWindows, []);
});

test('copyShadeBody: falls back to a fragment consume URL and never opens for empty body', async () => {
  const { sandbox, calls } = loadSW();
  await sandbox.copyShadeBody({ body: 'OTP 123456', topic: 'my alerts' });
  assert.deepEqual(calls.openWindows, ['/?topic=my%20alerts&copy=1#c=OTP%20123456']);

  calls.openWindows.length = 0;
  await sandbox.copyShadeBody({ body: '', topic: 'alerts' });
  assert.deepEqual(calls.openWindows, []);
});

test('copyShadeBody: caps the #c= fragment at 512 UTF-8 bytes', async () => {
  const { sandbox, calls } = loadSW();
  const long = 'x'.repeat(600);
  await sandbox.copyShadeBody({ body: long, topic: 'alerts' });
  const url = calls.openWindows[0];
  const fragment = decodeURIComponent(url.split('#c=')[1]);
  assert.equal(new TextEncoder().encode(fragment).length, 512);
});

test('truncateUtf8Bytes never splits a code point', () => {
  const { sandbox } = loadSW();
  // 'é' is two bytes in UTF-8. A cut that would split it steps back.
  assert.equal(sandbox.truncateUtf8Bytes('aéé', 3), 'aé');
  assert.equal(sandbox.truncateUtf8Bytes('abc', 3), 'abc');
  assert.equal(sandbox.truncateUtf8Bytes('abc', 2), 'ab');
  assert.equal(new TextEncoder().encode(sandbox.truncateUtf8Bytes('a'.repeat(1000), 512)).length, 512);
});
