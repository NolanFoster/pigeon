const CACHE_NAME = 'pigeon-v2';
const STATIC_ASSETS = ['/', '/style.css', '/app.js', '/manifest.json', '/badge.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
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

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { message: event.data ? event.data.text() : 'New notification' };
  }

  const title = data.title || data.topic || 'Pigeon';
  let bodyText = data.message || '';
  if (data.markdown) {
    bodyText = stripMarkdown(bodyText);
  }

  const options = {
    body: bodyText,
    tag: data.id || undefined,
    icon: '/icon-192.png',
    badge: '/badge.png',
    image: data.image || undefined,
    data: { click: data.click, topic: data.topic },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.click || '/';
  event.waitUntil(clients.openWindow(url));
});
