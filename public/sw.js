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

// Android 16/17 Notification Cooldown: one full-volume heads-up per origin per
// ~60 seconds (priority 5 is exempt). Web Push on Chrome Android shares the
// same attention budget as FCM, and the same rule is correct on desktop.
const AUDIBLE_WINDOW_MS = 60_000;
// Cap for the #c= copy fragment: the shade body is already short (≤120
// graphemes), but cap the bytes so a pathological body cannot bloat the URL.
const COPY_FRAGMENT_MAX_BYTES = 512;
const GENERIC_ENCRYPTED_BODY = 'New encrypted message';

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

// X-Priority is 1–5. Missing or unparseable priorities are treated as the
// default 3 so a malformed push can never accidentally earn "always audible".
function normalizePriority(p) {
  const n = typeof p === 'number' ? p : Number.parseInt(p, 10);
  return (Number.isFinite(n) && n >= 1 && n <= 5) ? n : 3;
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
          priority: data.priority,
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

// Truncate a string to at most `max` UTF-8 bytes without splitting a code
// point. Used to cap the #c= copy fragment.
function truncateUtf8Bytes(text, max) {
  if (!text) return '';
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= max) return text;
  let out = '';
  for (const ch of Array.from(text)) {
    const candidate = out + ch;
    if (encoder.encode(candidate).length > max) break;
    out = candidate;
  }
  return out;
}

// First-line copy (delivery budget §5). The Lock Screen may rewrite the
// notification, so the fact must be in the first line. Never fall back to the
// topic name or "Pigeon" as a title (#23, #44).
function buildPlaintext(data) {
  const message = data.markdown ? stripMarkdown(data.message || '') : (data.message || '');
  const priority = normalizePriority(data.priority);

  if (data.title) {
    return {
      title: truncateChars(data.title, 50),
      body: truncateChars(message, 120),
      image: data.image || undefined,
      click: data.click || undefined,
      topic: data.topic,
      id: data.id,
      priority,
    };
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return {
      title: 'New message',
      body: data.topic || '',
      topic: data.topic,
      id: data.id,
      priority,
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
    priority,
  };
}

function genericEncrypted(data) {
  return {
    title: data.topic ? `🔒 ${data.topic}` : 'New encrypted message',
    body: GENERIC_ENCRYPTED_BODY,
    topic: data.topic,
    id: data.id,
    priority: normalizePriority(data.priority),
    placeholder: true,
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
      priority: data.priority,
    });
  } catch (err) {
    console.warn('SW thin-push upgrade failed:', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Sentinels for the audible-budget read. `null` means "no audible yet recorded"
// (a first priority-4 may chime); the sentinel means "IDB unavailable" (fail
// closed on volume for everything below priority 5).
const IDB_UNAVAILABLE = Symbol('idb-unavailable');

async function getLastAudibleAt() {
  try {
    return await PigeonKeystore.getLastAudibleAt();
  } catch (err) {
    return IDB_UNAVAILABLE;
  }
}

async function setLastAudibleAt(ms) {
  try {
    await PigeonKeystore.setLastAudibleAt(ms);
  } catch (err) {
    console.warn('Could not persist last-audible timestamp:', err);
  }
}

// Android 16/17 cooldown budget. Returns whether this toast may make sound and
// whether it should (re)start the 60s window. Priority 5 always tries to be
// audible; priorities 1–3 are tray-only; priority 4 is audible only when
// nothing audible happened in the last minute.
async function audibleDecision(priority) {
  if (priority === 5) return { silent: false, update: true };
  if (priority <= 3) return { silent: true, update: false };

  // Priority 4.
  const last = await getLastAudibleAt();
  if (last === IDB_UNAVAILABLE) return { silent: true, update: false };
  const now = Date.now();
  if (last === null || now - last >= AUDIBLE_WINDOW_MS) {
    return { silent: false, update: true };
  }
  return { silent: true, update: false };
}

// Collapse chatter so Notification Organizer / cooldown grouping see one row
// per topic instead of N snowflake heads-ups. Priority 5 keeps a unique tag so a
// fire-alert is never overwritten by — and never overwrites — routine chatter.
// (When #36's RFC 8030 `Topic` header lands on the server it still owns the
// push-service-side collapse; this is the toast-level tag.)
function tagFor(n, priority) {
  if (priority === 5) {
    return (n.id && n.topic) ? `pigeon:${n.topic}:${n.id}` : (n.id || undefined);
  }
  return n.topic ? `pigeon:${n.topic}` : (n.id || undefined);
}

// A Copy action that writes the shade body to the clipboard without opening the
// PWA (ntfy iOS 1.7 made tap-to-copy the default; on a PWA, body-tap still opens
// the topic — Copy is the button). Feature-detect Notification.maxActions so
// Safari iOS (0 actions) gets no button and no throw. Never offer Copy for the
// generic encrypted placeholder or an empty body.
function buildCopyAction(n) {
  if (n.placeholder || !n.body) return null;
  if (typeof Notification === 'undefined' || typeof Notification.maxActions !== 'number') return null;
  if (Notification.maxActions < 1) return null;
  return { action: 'pigeon-copy', title: 'Copy' };
}

async function showNotificationFor(n) {
  const priority = normalizePriority(n.priority);
  const decision = await audibleDecision(priority);

  const options = {
    body: n.body,
    tag: tagFor(n, priority),
    icon: '/icon-192.png',
    badge: '/badge.png',
    image: n.image,
    silent: decision.silent,
    // notificationclick cannot read the body back from the Notifications API,
    // so carry the shade copy on the data object for the Copy action.
    data: { click: n.click, topic: n.topic, body: n.body, title: n.title, id: n.id },
  };

  const copyAction = buildCopyAction(n);
  if (copyAction) options.actions = [copyAction];

  await self.registration.showNotification(n.title, options);

  if (decision.update) {
    await setLastAudibleAt(Date.now());
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

// Copy-without-open consume path (#50). The service worker has no clipboard, so
// the Copy shade action opens a same-origin URL whose fragment carries the body;
// app.js copies it on load. The body travels in the fragment — never the query —
// so it never hits access logs or Referer.
async function copyShadeBody(data) {
  const body = data && data.body;
  if (!body) return;

  // The service worker usually has no clipboard; if it does, use it directly.
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(body);
      return;
    }
  } catch (err) {
    console.warn('SW clipboard copy failed; opening consume URL:', err);
  }

  const capped = truncateUtf8Bytes(body, COPY_FRAGMENT_MAX_BYTES);
  const topic = data.topic ? encodeURIComponent(data.topic) : '';
  const url = `/?topic=${topic}&copy=1#c=${encodeURIComponent(capped)}`;
  await clients.openWindow(url);
}

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};

  // The Copy button writes the body to the clipboard and does not open a
  // window — the whole point is to avoid a second interruption inside the
  // Android cooldown window.
  if (event.action === 'pigeon-copy') {
    event.notification.close();
    event.waitUntil(copyShadeBody(data));
    return;
  }

  event.notification.close();
  // X-Click is publisher-controlled. Some browsers historically allowed
  // non-http(s) schemes through clients.openWindow; gate it here defensively.
  const click = data.click;
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
  } else if (data.topic) {
    // No X-Click: body-tap opens the topic (deep link), not the bare shell.
    url = `/?topic=${encodeURIComponent(data.topic)}`;
  }
  event.waitUntil(clients.openWindow(url));
});
