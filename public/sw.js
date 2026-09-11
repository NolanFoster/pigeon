/* global PigeonCrypto, PigeonKeystore */
importScripts('/keystore.js', '/crypto.js');

const CACHE_NAME = 'pigeon-v8';
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

async function buildNotification(data) {
  // If the server flagged this as encrypted with a ciphertext envelope, try to
  // decrypt with the stored topic key. On any failure, fall back to a generic
  // notification so the user still gets a heads-up.
  if (data && data.encrypted && typeof data.ct === 'string' && data.topic) {
    const envelope = PigeonCrypto.parseEnvelope(data.ct);
    const rec = await PigeonKeystore.getTopicKey(data.topic).catch(() => null);
    if (envelope && rec && rec.passphrase) {
      try {
        // Derive from the envelope's own kdf so a manual resubscribe (which
        // mints a fresh local salt) still decrypts pushes encrypted earlier.
        const key = await PigeonCrypto.deriveKey(rec.passphrase, envelope.kdf.salt, envelope.kdf.iter);
        const fields = await PigeonCrypto.decryptEnvelope(key, envelope);
        return buildPlaintext({
          title: fields.title,
          message: fields.message,
          markdown: fields.markdown,
          image: fields.image,
          click: fields.click,
          topic: data.topic,
          id: data.id,
        });
      } catch (err) {
        console.warn('SW decrypt failed:', err);
      }
    }
    return genericEncrypted(data);
  }

  return buildPlaintext(data);
}

// Split a string into grapheme clusters (falls back to code points). Lock
// Screen truncation must never split an emoji sequence mid-cluster.
function graphemeSegments(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(seg.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

function truncateChars(text, max) {
  if (!text) return '';
  const segs = graphemeSegments(text);
  if (segs.length <= max) return text;
  return segs.slice(0, max).join('');
}

// First-line copy (delivery budget §5). The Lock Screen may rewrite the
// notification, so the fact must be in the first line. Never fall back to the
// topic name or "Pigeon" as a title (#23, #44).
function buildPlaintext(data) {
  const message = data.markdown ? stripMarkdown(data.message || '') : (data.message || '');

  if (data.title) {
    return {
      title: truncateChars(data.title, 50),
      body: truncateChars(message, 120),
      image: data.image || undefined,
      click: data.click || undefined,
      topic: data.topic,
      id: data.id,
    };
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return {
      title: 'New message',
      body: data.topic || '',
      topic: data.topic,
      id: data.id,
    };
  }

  const nl = trimmed.search(/\r?\n/);
  const first = nl === -1 ? trimmed : trimmed.slice(0, nl);
  const rest = nl === -1 ? '' : trimmed.slice(nl).replace(/^\r?\n/, '').trimStart();

  return {
    title: truncateChars(first, 50),
    body: truncateChars(rest, 120),
    image: data.image || undefined,
    click: data.click || undefined,
    topic: data.topic,
    id: data.id,
  };
}

function genericEncrypted(data) {
  return {
    title: data.topic ? `🔒 ${data.topic}` : 'New encrypted message',
    body: 'New encrypted message',
    topic: data.topic,
    id: data.id,
  };
}

// A thin E2EE push omitted `ct` to stay inside the push-service size budget.
// The closed PWA can't decrypt from the push alone, so fetch the full envelope
// and replace the generic toast with the real copy. On any failure keep the
// generic toast — userVisibleOnly is satisfied either way.
async function tryFetchAndDecrypt(data) {
  if (!data || !data.topic || !data.id) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(
      `/${encodeURIComponent(data.topic)}/messages/${encodeURIComponent(data.id)}`,
      { credentials: 'omit', signal: controller.signal },
    );
    if (!res.ok) return null;
    const full = await res.json();
    const envelope = PigeonCrypto.parseEnvelope(full.message);
    if (!envelope) return null;
    const rec = await PigeonKeystore.getTopicKey(data.topic).catch(() => null);
    if (!rec || !rec.passphrase) return null;
    const key = await PigeonCrypto.deriveKey(rec.passphrase, envelope.kdf.salt, envelope.kdf.iter);
    const fields = await PigeonCrypto.decryptEnvelope(key, envelope);
    return buildPlaintext({
      title: fields.title,
      message: fields.message,
      markdown: fields.markdown,
      image: fields.image,
      click: fields.click,
      topic: data.topic,
      id: data.id,
    });
  } catch (err) {
    console.warn('SW thin-push upgrade failed:', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function showNotificationFor(n) {
  const options = {
    body: n.body,
    tag: n.id || undefined,
    icon: '/icon-192.png',
    badge: '/badge.png',
    image: n.image,
    data: { click: n.click, topic: n.topic },
  };
  await self.registration.showNotification(n.title, options);
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { message: event.data ? event.data.text() : 'New notification' };
  }

  event.waitUntil((async () => {
    // Thin E2EE push (encrypted but no ct): show the generic toast immediately,
    // then try to fetch + decrypt the full envelope and replace it.
    if (data && data.encrypted && typeof data.ct !== 'string' && data.topic && data.id) {
      await showNotificationFor(genericEncrypted(data));
      const real = await tryFetchAndDecrypt(data);
      if (real) await showNotificationFor(real);
      return;
    }
    await showNotificationFor(await buildNotification(data));
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // X-Click is publisher-controlled. Some browsers historically allowed
  // non-http(s) schemes through clients.openWindow; gate it here defensively.
  const click = event.notification.data && event.notification.data.click;
  let url = '/';
  if (click) {
    try {
      const parsed = new URL(click, self.location.origin);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        url = parsed.href;
      }
    } catch {
      // Fall back to root.
    }
  } else if (event.notification.data && event.notification.data.topic) {
    // No X-Click: body-tap opens the topic (deep link), not the bare shell.
    url = `/?topic=${encodeURIComponent(event.notification.data.topic)}`;
  }
  event.waitUntil(clients.openWindow(url));
});
