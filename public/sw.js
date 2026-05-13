/* global PigeonCrypto, PigeonKeystore */
importScripts('/keystore.js', '/crypto.js');

const CACHE_NAME = 'pigeon-v4';
const STATIC_ASSETS = ['/', '/style.css', '/app.js', '/crypto.js', '/keystore.js', '/manifest.json', '/badge.png'];

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
  // If the server flagged this as encrypted, try to decrypt with the stored
  // topic key. On any failure, fall back to a generic notification so the
  // user still gets a heads-up.
  if (data && data.encrypted && typeof data.ct === 'string' && data.topic) {
    const envelope = PigeonCrypto.parseEnvelope(data.ct);
    const rec = await PigeonKeystore.getTopicKey(data.topic).catch(() => null);
    if (envelope && rec && rec.passphrase) {
      try {
        const key = await PigeonCrypto.deriveKey(rec.passphrase, rec.salt, rec.iter);
        const fields = await PigeonCrypto.decryptEnvelope(key, envelope);
        return {
          title: fields.title || data.topic || 'Pigeon',
          body: fields.markdown ? stripMarkdown(fields.message || '') : (fields.message || ''),
          image: fields.image || undefined,
          click: fields.click || undefined,
          topic: data.topic,
          id: data.id,
        };
      } catch (err) {
        console.warn('SW decrypt failed:', err);
      }
    }
    return {
      title: data.topic ? `🔒 ${data.topic}` : 'Pigeon',
      body: 'New encrypted message',
      topic: data.topic,
      id: data.id,
    };
  }

  return {
    title: data.title || data.topic || 'Pigeon',
    body: data.markdown ? stripMarkdown(data.message || '') : (data.message || ''),
    image: data.image || undefined,
    click: data.click || undefined,
    topic: data.topic,
    id: data.id,
  };
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
    const options = {
      body: n.body,
      tag: n.id || undefined,
      icon: '/icon-192.png',
      badge: '/badge.png',
      image: n.image,
      data: { click: n.click, topic: n.topic },
    };
    await self.registration.showNotification(n.title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.click || '/';
  event.waitUntil(clients.openWindow(url));
});
