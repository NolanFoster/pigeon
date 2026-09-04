/* global PigeonCrypto, PigeonKeystore */
importScripts('/keystore.js', '/crypto.js');

const CACHE_NAME = 'pigeon-v7';
// The editor bundle, its stylesheets and the icons were previously missing, so
// an offline launch rendered without a compose box.
const STATIC_ASSETS = [
  '/', '/index.html', '/style.css', '/app.js', '/crypto.js', '/keystore.js', '/manifest.json',
  '/badge.png', '/favicon.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png',
  '/icon-maskable-192.png', '/icon-maskable-512.png', '/logo.png',
  '/vendor/marked.min.js', '/vendor/purify.min.js', '/vendor/Sortable.min.js',
  '/vendor/toastui-editor-all.min.js',
  '/vendor/toastui-editor.min.css', '/vendor/toastui-editor-dark.min.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  // Only cache GET requests for static assets
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Navigations fall back to the cached shell when the network is unavailable,
  // so a cold offline launch shows the app instead of the browser's error page.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/'))
    );
    return;
  }

  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        // Return cached version, but update in background
        const fetchPromise = fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => cached);

        return cached || fetchPromise;
      })
    );
  }
});

function stripMarkdown(text) {
  if (!text) return '';
  return text
    // Remove Images
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
    // Remove Links [text](url)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove Headers
    .replace(/^#{1,6}\s+(.*)/gm, '$1')
    // Remove Bold/Italic
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    // Remove Strikethrough
    .replace(/~~(.*?)~~/g, '$1')
    // Replace Code Blocks with [Code]
    .replace(/```[\s\S]*?```/g, '[Code Block]')
    // Remove Inline Code
    .replace(/`([^`]+)`/g, '$1')
    // Remove Blockquotes
    .replace(/^\s*>\s+/gm, '')
    // Remove Lists
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Honest-copy guards (#44). Chrome on Android runs an on-device model over
// notification titles, bodies, and action labels. Publisher action labels that
// read like permission prompts ("Allow", "Verify", "Click here", …) are dropped
// so a spammy topic can't get the whole origin flagged. The server rejects the
// same labels at parse time; this is the decrypt-side guard for E2EE topics.
// ---------------------------------------------------------------------------
const BANNED_ACTION_LABELS = /^(allow|verify|confirm|unsubscribe|click here|ok|continue|claim)$/i;

function normalizeActionLabel(label) {
  return String(label || '').trim().replace(/\s+/g, ' ');
}

function isBannedActionLabel(label) {
  return BANNED_ACTION_LABELS.test(normalizeActionLabel(label));
}

function filterBannedActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions.filter(a => a && !isBannedActionLabel(a.title || a.label));
}

// A content notification is anything the publisher meant the user to see.
// Control-plane closes (#43) are `message_clear` / `message_delete` and must
// not grow a "Mute topic" button.
function isContentNotification(data) {
  return !data || (data.event !== 'message_clear' && data.event !== 'message_delete');
}

async function buildNotification(data) {
  // If the server flagged this as encrypted, try to decrypt with the stored
  // topic key. On any failure, fall back to a generic notification so the
  // user still gets a heads-up.
  if (data && data.encrypted && typeof data.ct === 'string' && data.topic) {
    const envelope = PigeonCrypto.parseEnvelope(data.ct);
    const rec = await PigeonKeystore.getTopicKey(data.topic).catch(() => null);
    if (envelope && rec && rec.passphrase) {
      try {
        // Derive from the envelope's own kdf so a manual resubscribe (which
        // mints a fresh local salt) still decrypts pushes encrypted earlier.
        const key = await PigeonCrypto.deriveKey(rec.passphrase, envelope.kdf.salt, envelope.kdf.iter);
        const fields = await PigeonCrypto.decryptEnvelope(key, envelope);
        return {
          title: fields.title || data.topic || '',
          body: fields.markdown ? stripMarkdown(fields.message || '') : (fields.message || ''),
          image: fields.image || undefined,
          click: fields.click || undefined,
          topic: data.topic,
          id: data.id,
          actions: filterBannedActions(fields.actions),
        };
      } catch (err) {
        console.warn('SW decrypt failed:', err);
      }
    }
    return {
      title: `🔒 ${data.topic}`,
      body: 'New encrypted message',
      topic: data.topic,
      id: data.id,
      actions: [],
    };
  }

  // Default title is the topic name (or the publisher's X-Title), never a
  // generic "Pigeon". Default body is the message text.
  return {
    title: data.title || data.topic || '',
    body: data.markdown ? stripMarkdown(data.message || '') : (data.message || ''),
    image: data.image || undefined,
    click: data.click || undefined,
    topic: data.topic,
    id: data.id,
    actions: filterBannedActions(data.actions),
  };
}

// --- Installed-app hygiene (epic #34, child #37) --------------------------
// The page tells the service worker which topic a window is currently viewing,
// so a push for that topic can be folded into the already-visible stream
// instead of being duplicated as an OS toast. The URL query string is the
// fallback between navigation and the next postMessage.

const activeTopicByClient = new Map(); // client id -> topic name

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'active-topic' || !event.source || !event.source.id) return;
  if (data.topic) activeTopicByClient.set(event.source.id, data.topic);
  else activeTopicByClient.delete(event.source.id);
});

function activeTopicFor(client) {
  if (client.id && activeTopicByClient.has(client.id)) return activeTopicByClient.get(client.id);
  try {
    return new URL(client.url).searchParams.get('topic');
  } catch {
    return null;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function arrayBufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Increments the home-screen badge when a push becomes an OS notification
// while the page isn't running. The page owns the running copy of the sum and
// persists it to IDB (unread_sum); the SW read-modify-writes it so the two
// never blindly race each other.
async function bumpUnreadBadge() {
  if (!('setAppBadge' in self.navigator)) return;
  try {
    const prev = (await PigeonKeystore.getMeta('unread_sum')) || 0;
    const next = prev + 1;
    await PigeonKeystore.setMeta('unread_sum', next);
    await self.navigator.setAppBadge(next);
  } catch (err) {
    console.warn('setAppBadge failed:', err);
  }
}

// Unregister one topic's push row from the shade. This is NOT Chrome's
// origin-wide Unsubscribe: it does not revoke the PushSubscription, and other
// topics keep their rows. It never focuses the PWA — the whole point is to
// make a noisy topic quieter without leaving the drawer.
async function muteTopicFromNotification(notification) {
  const topic = notification.data && notification.data.topic;
  if (!topic) return;
  try {
    await PigeonKeystore.setTopicMuted(topic);

    const sub = await self.registration.pushManager.getSubscription();
    const endpoint = sub && sub.endpoint;
    if (endpoint) {
      try {
        await fetch(`/${topic}/push/subscribe`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint }),
        });
      } catch (err) {
        // Offline: hand the delete to the page's durable retry queue.
        await PigeonKeystore.addPendingUnsub({ topic, endpoint }).catch(() => {});
      }
    }

    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(c => c.postMessage({ type: 'pigeon-topic-muted', topic }));
  } catch (err) {
    console.warn('Mute topic failed:', err);
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { message: event.data ? event.data.text() : 'New notification' };
  }

  event.waitUntil((async () => {
    const n = await buildNotification(data);
    const topic = n.topic || data.topic;

    // A notification has to be useful and time-sensitive. If a focused window
    // is already showing this topic, the message is on screen — don't also
    // shout at the OS. Forward the payload so a lagging WebSocket can catch up.
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const viewing = clientsList.some((c) => c.focused && topic && activeTopicFor(c) === topic);
    if (viewing) {
      for (const c of clientsList) {
        c.postMessage({ type: 'push-forward', payload: data });
      }
      return;
    }

    // #44: never leave a blank toast for the on-device model to flag, and
    // never fall back to a title that is only "Pigeon".
    const title = n.title || n.topic || 'Message';
    const body = n.body || n.topic || 'Message';

    const options = {
      body,
      tag: n.id || undefined,
      icon: '/icon-192.png',
      badge: '/badge.png',
      image: n.image,
      data: { click: n.click, topic: n.topic, id: n.id },
    };

    // Mute-this-topic is the reserved first action on every content
    // notification. Feature-detect maxActions rather than UA-sniffing: Safari
    // on iOS reports 0, where we just skip the button and keep the body tap.
    if (isContentNotification(data) && typeof Notification !== 'undefined' && Notification.maxActions > 0) {
      const actions = [{ action: 'pigeon-mute', title: 'Mute topic' }];
      for (const a of n.actions) {
        if (actions.length < Notification.maxActions) actions.push(a);
        else break;
      }
      options.actions = actions;
    }

    await self.registration.showNotification(title, options);
    await bumpUnreadBadge();
  })());
});

self.addEventListener('notificationclick', (event) => {
  if (event.action === 'pigeon-mute') {
    event.notification.close();
    event.waitUntil(muteTopicFromNotification(event.notification));
    return;
  }

  event.notification.close();
  const data = event.notification.data || {};
  const click = data.click;
  const topic = data.topic;
  const id = data.id;

  event.waitUntil((async () => {
    // X-Click is publisher-controlled. Some browsers historically allowed
    // non-http(s) schemes through clients.openWindow; gate it here defensively.
    if (click) {
      try {
        const parsed = new URL(click, self.location.origin);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          // Publisher intent wins for cross-origin clicks.
          if (parsed.origin !== self.location.origin) {
            return self.clients.openWindow(parsed.href);
          }
        }
      } catch {
        // Fall through to focusing the app.
      }
    }

    // Otherwise focus an existing window and navigate it to the topic, instead
    // of spawning a second window for every alert.
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clientsList.length > 0) {
      const target = clientsList[0];
      await target.focus();
      target.postMessage({ type: 'open-topic', topic, id });
      return;
    }
    return self.clients.openWindow(topic ? `/?topic=${encodeURIComponent(topic)}` : '/');
  })());
});

// Endpoint rotation must not silently disable push. Resubscribe with the
// cached VAPID key and re-register the new endpoint against every topic the
// server still has a row for.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const vapidKey = await PigeonKeystore.getMeta('vapid_key');
      const registrations = (await PigeonKeystore.getMeta('push_registrations')) || [];
      if (!vapidKey) {
        console.warn('pushsubscriptionchange: no VAPID key cached; re-registration happens on next page load');
        return;
      }
      const newSub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
      for (const reg of registrations) {
        if (!reg || !reg.topic) continue;
        try {
          await fetch(`/${encodeURIComponent(reg.topic)}/push/subscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              endpoint: newSub.endpoint,
              keys: {
                p256dh: arrayBufferToBase64Url(newSub.getKey('p256dh')),
                auth: arrayBufferToBase64Url(newSub.getKey('auth')),
              },
            }),
          });
        } catch (err) {
          console.warn('Re-register push for topic failed:', reg.topic, err);
        }
      }
    } catch (err) {
      console.warn('pushsubscriptionchange handling failed:', err);
    }
  })());
});
