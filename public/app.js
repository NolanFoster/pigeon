/* global Sortable, PigeonCrypto, PigeonKeystore */
const state = {
  topics: JSON.parse(localStorage.getItem('pigeon_topics') || '[]'),
  // topicMeta[name] = { e2ee, salt, iter } — encryption config persisted alongside topics
  topicMeta: JSON.parse(localStorage.getItem('pigeon_topic_meta') || '{}'),
  // topicKeys[name] = CryptoKey for encrypting outgoing messages with meta.salt/iter
  topicKeys: {},
  // passphrases[name] = string — cached so decryption can re-derive per envelope
  passphrases: {},
  // decryptKeyCache["topic|salt|iter"] = CryptoKey, keyed by the envelope's kdf params
  decryptKeyCache: {},
  activeTopic: null,
  messages: {},       // topic -> Message[]
  // topic -> offline-history notice text
  offlineHistory: new Map(),
  connectingTopics: new Set(),
  eventSources: {},   // topic -> { ws, heartbeatId }
  unreadCounts: {},
  pushEnabled: false,
  pushSubscription: null,
  // True while an enable/disable is in flight, so the button can't be
  // double-fired into an inconsistent state.
  pushBusy: false,
  // topic -> Set of active filter tags (AND semantics). Per-topic so a
  // filter never leaks across topic switches; the URL mirrors it so a
  // filtered view can be shared and restored after reload.
  filterTags: new Map(),
};

// fetch() resolves for 4xx/5xx, so a bare `await fetch(...)` inside a try block
// silently treats a server error as success. Every mutating call goes through
// this instead, so the callers' catch blocks actually run.
async function apiFetch(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    throw new Error(`${(opts && opts.method) || 'GET'} ${url} failed with HTTP ${res.status}`);
  }
  return res;
}

function saveTopicMeta() {
  localStorage.setItem('pigeon_topic_meta', JSON.stringify(state.topicMeta));
}

function isE2eeTopic(topic) {
  return !!(state.topicMeta[topic] && state.topicMeta[topic].e2ee);
}

// Loads stored passphrase from IDB, caches it for per-envelope decryption,
// and derives an encryption key for the topic's local meta.salt/iter.
// Returns true on success.
async function loadTopicKey(topic) {
  const meta = state.topicMeta[topic];
  if (!meta || !meta.e2ee) return false;
  try {
    const rec = await PigeonKeystore.getTopicKey(topic);
    if (!rec || !rec.passphrase) return false;
    state.passphrases[topic] = rec.passphrase;
    const key = await PigeonCrypto.deriveKey(rec.passphrase, meta.salt, meta.iter);
    state.topicKeys[topic] = key;
    return true;
  } catch (err) {
    console.error('Failed to load topic key:', err);
    return false;
  }
}

// Looks up the cached passphrase, falling back to IDB. Returns null if unknown.
async function getTopicPassphrase(topic) {
  if (state.passphrases[topic]) return state.passphrases[topic];
  try {
    const rec = await PigeonKeystore.getTopicKey(topic);
    if (rec && rec.passphrase) {
      state.passphrases[topic] = rec.passphrase;
      return rec.passphrase;
    }
  } catch (err) {
    console.warn('passphrase lookup failed:', err);
  }
  return null;
}

// Derives (and caches) an AES-GCM key from the envelope's own salt/iter.
async function getDecryptKey(topic, passphrase, salt, iter) {
  const cacheKey = `${topic}|${salt}|${iter}`;
  const cached = state.decryptKeyCache[cacheKey];
  if (cached) return cached;
  const key = await PigeonCrypto.deriveKey(passphrase, salt, iter);
  state.decryptKeyCache[cacheKey] = key;
  return key;
}

function clearTopicCryptoState(topic) {
  delete state.topicKeys[topic];
  delete state.passphrases[topic];
  const prefix = `${topic}|`;
  for (const k of Object.keys(state.decryptKeyCache)) {
    if (k.startsWith(prefix)) delete state.decryptKeyCache[k];
  }
}

// Attempts to decrypt a message in-place. The key is re-derived from the
// envelope's own kdf.salt/iter so old messages still decrypt after a manual
// resubscribe (which mints a fresh local salt). When the message is
// ciphertext but we have no passphrase, or the envelope is malformed, sets
// `msg._locked = true` so the UI shows a clean placeholder instead of
// leaking raw envelope JSON.
async function tryDecryptMessage(topic, msg) {
  if (!msg._encryptedMessage) msg._encryptedMessage = msg.message;
  const env = PigeonCrypto.parseEnvelope(msg._encryptedMessage);
  const looksEncrypted = !!msg.encrypted || !!env;
  if (!looksEncrypted) return msg;
  if (!env) {
    msg._locked = true;
    return msg;
  }
  const passphrase = await getTopicPassphrase(topic);
  if (!passphrase) {
    msg._locked = true;
    return msg;
  }
  try {
    const key = await getDecryptKey(topic, passphrase, env.kdf.salt, env.kdf.iter);
    const fields = await PigeonCrypto.decryptEnvelope(key, env);
    if (typeof fields.message === 'string') msg.message = fields.message;
    if (typeof fields.title === 'string') msg.title = fields.title;
    if (typeof fields.tags === 'string') msg.tags = fields.tags;
    if (typeof fields.click === 'string') msg.click = fields.click;
    if (typeof fields.image === 'string') msg.image = fields.image;
    if (typeof fields.markdown === 'boolean') msg.markdown = fields.markdown;
    msg._decrypted = true;
    delete msg._locked;
  } catch (err) {
    console.warn('Decrypt failed for message', msg.id, err);
    msg._locked = true;
  }
  return msg;
}

// DOM elements
const topicInput = document.getElementById('topic-input');
const topicInputError = document.getElementById('topic-input-error');
const subscribeBtn = document.getElementById('subscribe-btn');
const e2eeCheckbox = document.getElementById('e2ee-checkbox');
const e2eePassphrase = document.getElementById('e2ee-passphrase');
const topicsSection = document.getElementById('topics-section');
const topicTabs = document.getElementById('topic-tabs');
const messagesSection = document.getElementById('messages-section');
const messagesList = document.getElementById('messages-list');
const enablePushBtn = document.getElementById('enable-push-btn');
const pushHint = document.getElementById('push-hint');
const offlineHistoryNotice = document.getElementById('offline-history-notice');
const clearMessagesBtn = document.getElementById('clear-messages-btn');
const clearCompletedBtn = document.getElementById('clear-completed-btn');
const liveRegion = document.getElementById('live-region');
const toastRegion = document.getElementById('toast-region');
const appDialog = document.getElementById('app-dialog');
const connectionStatusEl = document.getElementById('connection-status');
const unlockDialog = document.getElementById('unlock-dialog');
const unlockForm = document.getElementById('unlock-form');
const unlockPassphrase = document.getElementById('unlock-passphrase');

// Keep a bounded local copy of server history so subscribed topics remain
// useful when the PWA starts without a network connection. Encrypted messages
// are written as their original ciphertext, never their decrypted fields.
const OFFLINE_MESSAGE_LIMIT = 200;

function messageForCache(msg) {
  const cached = { ...msg, message: msg._encryptedMessage || msg.message };
  delete cached._encryptedMessage;
  delete cached._decrypted;
  delete cached._locked;
  return cached;
}

function cacheTopicMessages(topic) {
  const messages = (state.messages[topic] || [])
    .slice(0, OFFLINE_MESSAGE_LIMIT)
    .map(messageForCache);
  return PigeonKeystore.putTopicMessages(topic, messages)
    .catch(err => console.warn(`Couldn't cache messages for ${topic}:`, err));
}

async function getCachedMessages(topic) {
  try {
    const cached = await PigeonKeystore.getTopicMessages(topic);
    if (!Array.isArray(cached) || cached.length === 0) return [];
    await Promise.all(cached.map(msg => tryDecryptMessage(topic, msg)));
    return cached;
  } catch (err) {
    console.warn(`Couldn't restore cached messages for ${topic}:`, err);
    return [];
  }
}

function setOfflineHistoryNotice(topic, message = '') {
  if (message) state.offlineHistory.set(topic, message);
  else state.offlineHistory.delete(topic);
  if (offlineHistoryNotice) {
    const text = state.offlineHistory.get(state.activeTopic) || '';
    offlineHistoryNotice.textContent = text;
    offlineHistoryNotice.hidden = !text;
  }
}

// ---------------------------------------------------------------------------
// Feedback primitives
//
// Every async path in this app used to end at console.error, so a failed
// publish or a dropped socket was indistinguishable from "nothing happened".
// announce() drives an aria-live region for screen readers; showToast() is the
// visible counterpart; confirmDialog() replaces window.confirm.
// ---------------------------------------------------------------------------

// Appending a fresh node (rather than rewriting textContent) makes assistive
// tech re-read the announcement even when the text repeats.
function announce(text) {
  if (!liveRegion || !text) return;
  const line = document.createElement('p');
  line.textContent = text;
  liveRegion.appendChild(line);
  setTimeout(() => line.remove(), 5000);
}

// Snackbar. Errors take role="alert" so they interrupt; everything else is a
// polite status. Returns a dismiss function so callers can retract a toast
// early (e.g. an undo window that closed).
function showToast(message, opts = {}) {
  if (!toastRegion) return () => {};
  const {
    tone = 'info',
    actionLabel,
    onAction,
    duration = tone === 'error' ? 8000 : 5000,
  } = opts;

  const toast = document.createElement('div');
  toast.className = `toast toast-${tone}`;
  toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');

  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  toast.appendChild(text);

  let timer = null;
  const dismiss = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    toast.remove();
  };

  if (actionLabel && typeof onAction === 'function') {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast-action';
    action.textContent = actionLabel;
    action.addEventListener('click', () => { dismiss(); onAction(); });
    toast.appendChild(action);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.textContent = '×';
  close.addEventListener('click', dismiss);
  toast.appendChild(close);

  toastRegion.appendChild(toast);
  if (duration > 0) timer = setTimeout(dismiss, duration);
  return dismiss;
}

function toastError(message, opts = {}) {
  return showToast(message, { ...opts, tone: 'error' });
}

// Modal confirmation. The native <dialog> gives focus trapping, Esc-to-close
// and top-layer rendering for free; we only add focus restoration.
function confirmDialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', destructive = false }) {
  if (!appDialog || typeof appDialog.showModal !== 'function') {
    return Promise.resolve(window.confirm(body ? `${title}\n\n${body}` : title));
  }

  const titleEl = document.getElementById('app-dialog-title');
  const bodyEl = document.getElementById('app-dialog-body');
  const confirmBtn = document.getElementById('app-dialog-confirm');
  const cancelBtn = document.getElementById('app-dialog-cancel');

  titleEl.textContent = title;
  bodyEl.textContent = body || '';
  bodyEl.hidden = !body;
  confirmBtn.textContent = confirmLabel;
  cancelBtn.textContent = cancelLabel;
  confirmBtn.classList.toggle('btn-danger', destructive);
  confirmBtn.classList.toggle('btn-primary', !destructive);

  const opener = document.activeElement;

  return new Promise((resolve) => {
    const finish = (result) => {
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      appDialog.removeEventListener('close', onClose);
      if (appDialog.open) appDialog.close();
      if (opener && typeof opener.focus === 'function') opener.focus();
      resolve(result);
    };
    const onConfirm = () => finish(true);
    const onCancel = () => finish(false);
    const onClose = () => finish(false);

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    appDialog.addEventListener('close', onClose);
    appDialog.showModal();
    // Focus the safe choice, not the destructive one.
    cancelBtn.focus();
  });
}

// Inline validation for the subscribe field, per HIG: report the error next to
// the control that caused it rather than in a modal.
function setTopicError(message) {
  if (!topicInputError || !topicInput) return;
  topicInputError.textContent = message || '';
  topicInputError.hidden = !message;
  topicInput.setAttribute('aria-invalid', message ? 'true' : 'false');
  // Point the field at the error as well as the hint, so the message is read
  // out when focus lands back on the input.
  topicInput.setAttribute('aria-describedby',
    message ? 'topic-input-error topic-input-hint' : 'topic-input-hint');
}

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

function connectionSummary() {
  if (state.topics.length === 0) return null;
  if (typeof navigator.onLine === 'boolean' && !navigator.onLine) {
    return { state: 'offline', text: 'Offline' };
  }
  const open = state.topics.filter(t => {
    const conn = state.eventSources[t];
    return conn && conn.ws.readyState === WebSocket.OPEN;
  }).length;
  if (open === state.topics.length) return { state: 'live', text: 'Live' };
  if (open === 0) return { state: 'reconnecting', text: 'Reconnecting…' };
  return { state: 'partial', text: `Reconnecting ${state.topics.length - open} of ${state.topics.length}` };
}

let lastConnectionState = null;
function renderConnectionStatus() {
  if (!connectionStatusEl) return;
  const summary = connectionSummary();
  if (!summary) {
    connectionStatusEl.hidden = true;
    lastConnectionState = null;
    return;
  }
  connectionStatusEl.hidden = false;
  connectionStatusEl.textContent = summary.text;
  connectionStatusEl.dataset.state = summary.state;
  if (summary.state !== lastConnectionState) {
    if (lastConnectionState !== null) announce(`Connection status: ${summary.text}`);
    lastConnectionState = summary.state;
  }
}

window.addEventListener('online', renderConnectionStatus);
window.addEventListener('offline', renderConnectionStatus);

// Keep the service worker's suppress-when-focused view of the active topic
// fresh as windows gain/lose focus and the page becomes visible again.
window.addEventListener('focus', () => {
  if (state.activeTopic) notifyServiceWorkerActiveTopic(state.activeTopic);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.activeTopic) {
    notifyServiceWorkerActiveTopic(state.activeTopic);
  }
});

// Delegated click handler for any [data-action] element. Replaces the inline
// `onclick="..."` attributes the rendered HTML used to carry — those were a
// JS-injection surface (user-controlled fields templated into a JS string
// literal inside an HTML attribute) and are incompatible with a strict CSP.
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.getAttribute('data-action');
  switch (action) {
    case 'select-topic': {
      const topic = target.getAttribute('data-topic');
      if (topic) selectTopic(topic);
      break;
    }
    case 'remove-topic': {
      e.stopPropagation();
      const topic = target.getAttribute('data-topic');
      if (topic) requestRemoveTopic(topic);
      break;
    }
    case 'filter-tag': {
      const tag = target.getAttribute('data-tag');
      if (tag) setFilterTag(tag);
      break;
    }
    case 'clear-filter':
      clearFilterTag();
      break;
    case 'toggle-todo': {
      const id = target.getAttribute('data-msg-id');
      const topic = target.getAttribute('data-topic');
      const done = target.getAttribute('data-done') === '1';
      if (id && topic) toggleTodo(id, topic, done);
      break;
    }
    case 'toggle-md-task': {
      const id = target.getAttribute('data-msg-id');
      const idx = parseInt(target.getAttribute('data-task-index'), 10);
      if (id && Number.isInteger(idx)) toggleMarkdownTask(id, idx);
      break;
    }
    case 'edit-msg': {
      const id = target.getAttribute('data-msg-id');
      if (id) editMessage(id);
      break;
    }
    case 'delete-msg': {
      const id = target.getAttribute('data-msg-id');
      if (id) requestDeleteMessage(id);
      break;
    }
    case 'unlock-topic': {
      const topic = target.getAttribute('data-topic');
      if (topic) requestTopicUnlock(topic);
      break;
    }
    case 'copy-msg': {
      const id = target.getAttribute('data-msg-id');
      if (id) copyMessage(id, target);
      break;
    }
    case 'copy-code':
      copyCode(target);
      break;
    case 'cancel-edit':
      cancelEdit();
      break;
    case 'share-topic':
      shareActiveTopic();
      break;
    default:
      break;
  }
});

// Open rendered-message links in a new tab so clicking them doesn't tear down
// the SPA (WebSockets, in-memory state) and force a full reload on back-nav.
// Also blocks non-http(s)/mailto schemes (javascript:, data:, blob:, …) as
// defence in depth alongside DOMPurify's URI filter.
messagesList.addEventListener('click', (e) => {
  const link = e.target.closest('a[href]');
  if (!link || !messagesList.contains(link)) return;
  const href = link.getAttribute('href');
  if (/^https?:\/\//i.test(href)) {
    e.preventDefault();
    window.open(href, '_blank', 'noopener,noreferrer');
    return;
  }
  if (/^mailto:/i.test(href)) return;
  e.preventDefault();
});

// SortableJS holds element references and a click-suppression flag internally,
// both of which go stale when renderTopicTabs() rewrites topicTabs.innerHTML —
// the stale state silently swallows clicks on tabs and on the × close button.
// We destroy and re-create the instance on every render to keep them in sync.
let topicSortable = null;

function initTopicSortable() {
  if (typeof Sortable === 'undefined') return;
  if (topicSortable) {
    topicSortable.destroy();
    topicSortable = null;
  }
  topicSortable = new Sortable(topicTabs, {
    animation: 150,
    ghostClass: 'topic-tab-ghost',
    filter: '.remove',
    preventOnFilter: false,
    // Sortable's native HTML5 drag (the default) puts draggable="true" on each
    // tab, and the browser then swallows the `click` after any pointer gesture
    // with the slightest movement — so tab-switch and × removal silently fail.
    // forceFallback uses Sortable's own mouse/touch impl, and fallbackTolerance
    // keeps sub-threshold presses as ordinary clicks; a real drag past ~10px
    // still reorders. delay/delayOnTouchOnly only gate touch, so a quick tap
    // toggles/removes on mobile while a brief hold starts a drag.
    forceFallback: true,
    fallbackTolerance: 10,
    delayOnTouchOnly: true,
    delay: 120,
    touchStartThreshold: 10,
    onEnd: function (evt) {
      if (evt.oldIndex === evt.newIndex) return;

      const itemEl = state.topics.splice(evt.oldIndex, 1)[0];
      state.topics.splice(evt.newIndex, 0, itemEl);

      localStorage.setItem('pigeon_topics', JSON.stringify(state.topics));
      renderTopicTabs();
    },
  });
}

// Initialize
async function init() {
  // Handle launch actions before asynchronous PWA setup. This makes a
  // subscribe shortcut immediately ready for input even while the service
  // worker is being installed or updated.
  const launchAction = new URLSearchParams(location.search).get('action');
  if (launchAction === 'subscribe') topicInput.focus();

  // Push cleanup that shouldn't hold up the rest of startup, but has to run in
  // order: a resumed teardown may queue work that the retry pass then picks up.
  let pushStartup = Promise.resolve();

  if ('serviceWorker' in navigator) {
    await navigator.serviceWorker.register('/sw.js');
    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    migratePushPref(!!existing);

    if (existing && pushPrefEnabled()) {
      state.pushEnabled = true;
      state.pushSubscription = existing;
      // Cache the VAPID key in IDB so the service worker can resubscribe on
      // endpoint rotation (pushsubscriptionchange) without a page load.
      PigeonKeystore.getMeta('vapid_key').then(async (cached) => {
        if (cached) return;
        try {
          const resp = await apiFetch('/vapid-key');
          await PigeonKeystore.setMeta('vapid_key', await resp.text());
        } catch (err) {
          console.warn('Failed to cache VAPID key:', err);
        }
      });
      // Re-register push for all topics (idempotent via INSERT OR REPLACE on server)
      Promise.all(
        state.topics.map(topic => registerPushForTopic(topic, existing))
      ).catch(err => console.error('Push re-registration failed:', err));
    } else if (existing) {
      // Push is off but a live subscription is still out there — a teardown
      // that was interrupted, or one the browser undid. Every reload used to
      // re-register it, which is what made disabling feel impossible. Finish
      // the job instead.
      pushStartup = teardownPush(existing)
        .catch(err => console.error('Resuming push teardown failed:', err));
    }
  }

  // Anything the server never acknowledged gets another try on every load.
  pushStartup
    .then(flushPendingUnsubs)
    .catch(err => console.error('Unsubscribe retry failed:', err))
    .finally(renderPushState);

  renderPushState();

  // Derive encryption keys for any e2ee topics whose passphrase is in IDB
  await Promise.all(state.topics.filter(isE2eeTopic).map(loadTopicKey));

  state.topics.forEach(topic => connectTopic(topic));
  renderTopicTabs();

  if (state.topics.length > 0) {
    const restored = restoreFromUrl();
    if (!restored) selectTopic(state.topics[0]);
  }

  if (launchAction === 'compose' && state.activeTopic) {
    document.getElementById('compose-title').focus();
  }

  // If the URL fragment carries a share link (#topic=...&k=...&s=...&i=...),
  // prompt the user to join. Fragments are never sent to the server.
  await maybeJoinFromFragment();
}

async function maybeJoinFromFragment() {
  if (!location.hash) return;
  const params = new URLSearchParams(location.hash.slice(1));
  const topic = params.get('topic');
  const k = params.get('k');
  const s = params.get('s');
  const i = parseInt(params.get('i') || '', 10);
  if (!topic || !k || !s || !Number.isFinite(i)) return;
  // Clear fragment so reloads don't re-prompt
  history.replaceState(null, '', location.pathname + location.search);
  if (state.topics.includes(topic) && isE2eeTopic(topic)) return;
  const ok = await confirmDialog({
    title: `Join “${topic}”?`,
    body: 'This link carries the topic\'s shared passphrase. Anyone who has it can read and publish to this topic.',
    confirmLabel: 'Join topic',
  });
  if (!ok) return;
  await subscribeToTopic(topic, { e2ee: true, passphrase: k, salt: s, iter: i });
}

// Subscribe to a topic (UI handler)
subscribeBtn.addEventListener('click', async () => {
  const raw = topicInput.value.trim();
  const topic = raw.replace(/[^a-zA-Z0-9_-]/g, '');

  // The input used to be silently rewritten — typing "my topic!" subscribed you
  // to "mytopic" with no indication. Report it instead (HIG: inline validation).
  if (!raw) {
    setTopicError('Enter a topic name.');
    topicInput.focus();
    return;
  }
  if (!topic) {
    setTopicError('Topic names use letters, numbers, hyphens and underscores.');
    topicInput.focus();
    return;
  }
  if (topic !== raw) {
    setTopicError(`Topic names can't contain those characters. Try “${topic}”.`);
    topicInput.value = topic;
    topicInput.focus();
    return;
  }
  if (state.topics.includes(topic)) {
    setTopicError(`You're already subscribed to “${topic}”.`);
    selectTopic(topic);
    return;
  }
  setTopicError('');

  const wantE2ee = !!(e2eeCheckbox && e2eeCheckbox.checked);
  if (wantE2ee) {
    const passphrase = (e2eePassphrase && e2eePassphrase.value) || '';
    if (!passphrase) {
      setTopicError('Enter a passphrase to enable end-to-end encryption.');
      if (e2eePassphrase) e2eePassphrase.focus();
      return;
    }
    await subscribeToTopic(topic, {
      e2ee: true,
      passphrase,
      salt: PigeonCrypto.newSalt(),
      iter: PigeonCrypto.PBKDF2_ITERATIONS,
    });
  } else {
    await subscribeToTopic(topic, { e2ee: false });
  }

  topicInput.value = '';
  if (e2eePassphrase) e2eePassphrase.value = '';
  if (e2eeCheckbox) {
    e2eeCheckbox.checked = false;
    e2eeCheckbox.dispatchEvent(new Event('change'));
  }
});

async function subscribeToTopic(topic, opts) {
  if (state.topics.includes(topic)) return;
  state.topics.push(topic);
  state.messages[topic] = [];
  localStorage.setItem('pigeon_topics', JSON.stringify(state.topics));

  try {
    if (opts && opts.e2ee) {
      state.topicMeta[topic] = { e2ee: true, salt: opts.salt, iter: opts.iter };
      saveTopicMeta();
      await PigeonKeystore.putTopicKey(topic, {
        passphrase: opts.passphrase,
        salt: opts.salt,
        iter: opts.iter,
        e2ee: true,
      });
      await loadTopicKey(topic);
    }

    connectTopic(topic);
    if (state.pushEnabled && state.pushSubscription) {
      registerPushForTopic(topic, state.pushSubscription);
    }
    selectTopic(topic);
    renderTopicTabs();
  } catch (err) {
    state.topics = state.topics.filter(t => t !== topic);
    delete state.messages[topic];
    delete state.topicMeta[topic];
    clearTopicCryptoState(topic);
    localStorage.setItem('pigeon_topics', JSON.stringify(state.topics));
    saveTopicMeta();
    PigeonKeystore.deleteTopicKey(topic).catch(() => {});
    console.error('subscribeToTopic failed:', err);
    toastError(`Couldn't subscribe to ${topic}: ${err && err.message ? err.message : err}`);
    throw err;
  }
  announce(`Subscribed to ${topic}`);
}

topicInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') subscribeBtn.click();
});

if (e2eeCheckbox) {
  const updateE2eeUi = () => {
    if (!e2eePassphrase) return;
    e2eePassphrase.hidden = !e2eeCheckbox.checked;
    if (e2eeCheckbox.checked) e2eePassphrase.focus();
  };
  e2eeCheckbox.addEventListener('change', updateE2eeUi);
  updateE2eeUi();
}

async function shareActiveTopic() {
  const topic = state.activeTopic;
  if (!topic || !isE2eeTopic(topic)) return;
  const meta = state.topicMeta[topic];
  const rec = await PigeonKeystore.getTopicKey(topic);
  if (!rec || !rec.passphrase) {
    toastError('No passphrase stored for this topic, so there is nothing to share.');
    return;
  }

  // Warn *before* the link exists anywhere, not after it's on the clipboard.
  const ok = await confirmDialog({
    title: `Share “${topic}”?`,
    body: 'The link contains this topic\'s passphrase. Anyone who opens it can read and publish every message in the topic — send it only over a channel you trust.',
    confirmLabel: 'Create share link',
  });
  if (!ok) return;

  const k = encodeURIComponent(rec.passphrase);
  const s = encodeURIComponent(meta.salt);
  const i = meta.iter;
  const url = `${location.origin}/#topic=${encodeURIComponent(topic)}&k=${k}&s=${s}&i=${i}`;

  // Prefer the platform share sheet on touch devices (HIG: Share sheets).
  if (navigator.share) {
    try {
      await navigator.share({ title: `Pigeon topic: ${topic}`, url });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      // Any other failure falls through to the clipboard path.
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    showToast('Share link copied to clipboard.', { tone: 'success' });
  } catch (err) {
    console.error('Clipboard write failed:', err);
    toastError('Couldn\'t copy the link. Check clipboard permissions and try again.');
  }
}

// Connect WebSocket for a topic
async function connectTopic(topic) {
  if (state.eventSources[topic] || state.connectingTopics.has(topic)) return;
  state.connectingTopics.add(topic);
  state.messages[topic] = state.messages[topic] || [];
  // Do not await IndexedDB before opening the live connection: publishing
  // immediately after subscribing must not race a delayed cache read.
  const cachedMessages = getCachedMessages(topic);

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  try {
    ws = new WebSocket(`${proto}//${location.host}/${topic}/sse?since=all`);
  } catch (err) {
    state.connectingTopics.delete(topic);
    setOfflineHistoryNotice(topic, (state.messages[topic] || []).length
      ? 'Offline — showing cached messages.'
      : 'Offline — no cached messages are available yet.');
    if (state.activeTopic === topic) renderMessages();
    console.error(`Opening live connection for ${topic} failed:`, err);
    return;
  }

  // Buffer messages arriving before history is loaded
  const earlyMessages = [];
  let historyLoaded = false;

  ws.onopen = async () => {
    renderConnectionStatus();
    try {
      const res = await fetch(`/${topic}/json?since=all`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const msgs = await res.json();
      const reversed = msgs.reverse();
      await Promise.all(reversed.map(m => tryDecryptMessage(topic, m)));
      state.messages[topic] = reversed;
      await cacheTopicMessages(topic);
      setOfflineHistoryNotice(topic);
      // History isn't "new" — don't animate it in.
      markMessagesSeen(topic);
      // Merge any messages that arrived via WS while fetching history
      let newEarly = 0;
      for (const msg of earlyMessages) {
        if (msg && msg.deleted && msg.id) {
          state.messages[topic] = state.messages[topic].filter(m => m.id !== msg.id);
          continue;
        }
        if (!state.messages[topic].some(m => m.id === msg.id)) {
          state.messages[topic].unshift(msg);
          newEarly++;
        }
      }
      await cacheTopicMessages(topic);
      historyLoaded = true;
      if (state.activeTopic === topic) {
        renderMessages();
      } else if (newEarly > 0) {
        state.unreadCounts[topic] = (state.unreadCounts[topic] || 0) + newEarly;
        renderTopicTabs();
        updateAppBadge();
      }

      // A publisher can POST immediately after the subscribe UI becomes,
      // before its socket upgrade or the first D1 read has completed. Retry an
      // empty initial read for a short, bounded period and merge results so a
      // delayed read can never overwrite a message received live.
      if (state.messages[topic].length === 0 && earlyMessages.length === 0) {
        const recoverMissedInitialHistory = async (attempt = 0) => {
          if (!state.topics.includes(topic) || state.messages[topic].length !== 0) return;
          try {
            const retry = await fetch(`/${topic}/json?since=all`);
            if (!retry.ok) return;
            const missed = await retry.json();
            await Promise.all(missed.map(m => tryDecryptMessage(topic, m)));
            let recovered = 0;
            for (const msg of missed.reverse()) {
              if (!state.messages[topic].some(m => m.id === msg.id)) {
                insertMessage(topic, msg);
                recovered++;
              }
            }
            if (recovered > 0) {
              await cacheTopicMessages(topic);
              if (state.activeTopic === topic) renderMessages();
              else {
                state.unreadCounts[topic] = (state.unreadCounts[topic] || 0) + recovered;
                renderTopicTabs();
                updateAppBadge();
              }
            } else if (attempt < 4 && state.messages[topic].length === 0) {
              // D1 visibility and the WebSocket upgrade can each trail the
              // publish response. Back off, but stop after about four seconds.
              setTimeout(() => recoverMissedInitialHistory(attempt + 1), 250 * (2 ** attempt));
            }
          } catch (retryErr) {
            console.warn(`Retrying initial history for ${topic} failed:`, retryErr);
          }
        };
        setTimeout(recoverMissedInitialHistory, 250);
      }
    } catch (err) {
      // Only use the cache when server history is unavailable. A late IndexedDB
      // read must never replace newer messages received from the server.
      const cached = await cachedMessages;
      if (state.topics.includes(topic) && cached.length > 0) {
        state.messages[topic] = cached;
        markMessagesSeen(topic);
      }
      historyLoaded = true;
      setOfflineHistoryNotice(topic, (state.messages[topic] || []).length
        ? 'Offline — showing cached messages.'
        : 'Offline — no cached messages are available yet.');
      if (state.activeTopic === topic) renderMessages();
      console.error(`Loading history for ${topic} failed:`, err);
      toastError(`Couldn't load messages for ${topic}.`, {
        actionLabel: 'Retry',
        onAction: () => {
          disconnectTopic(topic);
          connectTopic(topic);
        },
      });
    }
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg && msg.deleted && msg.id) {
        if (!historyLoaded) {
          earlyMessages.push(msg);
          return;
        }
        const before = state.messages[topic].length;
        state.messages[topic] = state.messages[topic].filter(m => m.id !== msg.id);
        forgetMessageOrder(msg.id);
        cacheTopicMessages(topic);
        // If the deleted message is currently being edited (locally or by
        // another client), bail out of edit mode so the inline compose form
        // doesn't get orphaned inside a slot that's about to disappear.
        if (state.editing && state.editing.id === msg.id) {
          cancelEdit();
        } else if (state.messages[topic].length !== before && state.activeTopic === topic) {
          renderMessages();
        }
        return;
      }
      await tryDecryptMessage(topic, msg);
      if (!historyLoaded) {
        earlyMessages.push(msg);
        return;
      }
      if (state.messages[topic].some(m => m.id === msg.id)) return;
      // Before anything renders: an edit echoing back takes the position (and
      // the focus identity) of the message it replaces instead of the top slot.
      insertMessage(topic, msg, matchRepublish(topic, msg));
      cacheTopicMessages(topic);
      // Bookkeeping messages aren't news: the echo of an edit this client just
      // made, and the marker message that records a todo as complete (whose
      // body is the id of the todo it completes), are both silent. Announcing
      // them read a raw uuid out to screen readers.
      if (!isRepublish(msg.id) && !isTodoMarker(msg)) {
        announceIncoming(topic, msg);
      }
      if (state.activeTopic === topic) {
        renderMessages();
      } else if (!isTodoMarker(msg)) {
        state.unreadCounts[topic] = (state.unreadCounts[topic] || 0) + 1;
        renderTopicTabs();
        updateAppBadge();
      }
    } catch (err) {
      console.warn('Dropping malformed message:', err);
    }
  };

  const reconnect = () => {
    clearInterval(heartbeatId);
    delete state.eventSources[topic];
    renderConnectionStatus();
    setTimeout(() => {
      if (state.topics.includes(topic)) connectTopic(topic);
    }, 3000);
  };

  ws.onclose = reconnect;

  ws.onerror = () => {
    ws.close();
  };

  // Heartbeat: check connection every 30s
  const heartbeatId = setInterval(() => {
    if (!state.eventSources[topic]) {
      clearInterval(heartbeatId);
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      reconnect();
    }
  }, 30000);

  state.eventSources[topic] = { ws, heartbeatId };
  state.connectingTopics.delete(topic);
  renderConnectionStatus();
}

// The whole point of the app is that a message arrived. Say so out loud —
// previously a screen reader was told nothing at all (WCAG 4.1.3).
function announceIncoming(topic, msg) {
  if (msg._locked) {
    announce(`New encrypted message in ${topic}`);
    return;
  }
  const title = msg.title || '';
  const body = typeof msg.message === 'string' ? msg.message.slice(0, 120) : '';
  const priority = msg.priority >= 4 ? `${PRIORITY_NAMES[msg.priority]} priority. ` : '';
  announce(`${priority}New message in ${topic}. ${title ? title + '. ' : ''}${body}`);
}

function disconnectTopic(topic) {
  if (state.eventSources[topic]) {
    clearInterval(state.eventSources[topic].heartbeatId);
    state.eventSources[topic].ws.close();
    delete state.eventSources[topic];
  }
  delete state.messages[topic];
}

function selectTopic(topic) {
  // Cancel in-progress edit when switching topics so the inline compose form
  // doesn't get stranded in a topic the user no longer has open.
  if (state.editing && state.editing.topic !== topic) {
    cancelEdit();
  }
  const changed = state.activeTopic !== topic;
  state.activeTopic = topic;
  state.unreadCounts[topic] = 0;
  topicsSection.hidden = false;
  messagesSection.hidden = false;
  const shareBtn = document.getElementById('share-topic-btn');
  if (shareBtn) shareBtn.hidden = !isE2eeTopic(topic);
  // Switching topics shouldn't replay the entrance animation for the whole
  // incoming list — only messages that arrive afterwards are "new".
  if (changed) {
    messageEls.clear();
    markMessagesSeen(topic);
  }
  // Point the tabpanel at the tab that controls it.
  messagesList.setAttribute('aria-labelledby', topicDomId(topic));
  setOfflineHistoryNotice(topic, state.offlineHistory.get(topic));
  renderTopicTabs();
  renderMessages();
  syncUrl();
  notifyServiceWorkerActiveTopic(topic);
  updateAppBadge();
}

// Unsubscribing from an encrypted topic destroys the only copy of its
// passphrase, permanently orphaning every message in it — that warrants a
// confirmation. A plain topic can be re-added by typing its name, so it gets an
// optimistic removal with an undo snackbar instead (Material 3 snackbar
// pattern; HIG "confirm destructive actions" applies only to the first case).
async function requestRemoveTopic(topic) {
  if (isE2eeTopic(topic)) {
    const ok = await confirmDialog({
      title: `Unsubscribe from “${topic}”?`,
      body: 'This deletes the passphrase stored in this browser. Every encrypted message in this topic becomes permanently unreadable here, and there is no way to recover it.',
      confirmLabel: 'Unsubscribe and delete key',
      destructive: true,
    });
    if (!ok) return;
    removeTopic(topic);
    showToast(`Unsubscribed from ${topic}.`);
    return;
  }

  const meta = state.topicMeta[topic];
  const index = state.topics.indexOf(topic);
  removeTopic(topic);
  showToast(`Unsubscribed from ${topic}.`, {
    actionLabel: 'Undo',
    onAction: () => {
      if (state.topics.includes(topic)) return;
      state.topics.splice(index < 0 ? state.topics.length : index, 0, topic);
      if (meta) {
        state.topicMeta[topic] = meta;
        saveTopicMeta();
      }
      localStorage.setItem('pigeon_topics', JSON.stringify(state.topics));
      connectTopic(topic);
      // Re-register only once the removal's DELETE has landed, or the two
      // requests race and the topic comes back without notifications.
      (pushCleanupInFlight.get(topic) || Promise.resolve()).then(() => {
        if (state.pushEnabled && state.pushSubscription) {
          registerPushForTopic(topic, state.pushSubscription);
        }
      });
      selectTopic(topic);
      renderTopicTabs();
    },
  });
}

function removeTopic(topic) {
  state.connectingTopics.delete(topic);
  const wasActive = state.activeTopic === topic;
  disconnectTopic(topic);
  state.topics = state.topics.filter(t => t !== topic);
  localStorage.setItem('pigeon_topics', JSON.stringify(state.topics));

  // Closing the tab used to leave the server's push row in place, so
  // notifications kept arriving for a topic no longer in the list.
  cleanUpPushForTopic(topic);

  if (state.topicMeta[topic]) {
    delete state.topicMeta[topic];
    saveTopicMeta();
  }
  clearTopicCryptoState(topic);
  PigeonKeystore.deleteTopicKey(topic).catch(err => console.error('keystore delete:', err));
  PigeonKeystore.deleteTopicMessages(topic).catch(err => console.error('message cache delete:', err));
  setOfflineHistoryNotice(topic);

  if (wasActive) {
    if (state.topics.length > 0) {
      selectTopic(state.topics[0]);
    } else {
      state.activeTopic = null;
      topicsSection.hidden = true;
      messagesSection.hidden = true;
      renderTopicTabs();
      renderMessages();
      syncUrl();
    }
  } else {
    renderTopicTabs();
    renderMessages();
  }
}

// Stable, CSS/HTML-id-safe handle for a topic name. Topic names arriving via a
// share fragment aren't guaranteed to match the subscribe box's charset.
function topicDomId(topic) {
  return 'topic-tab-' + String(topic).replace(/[^a-zA-Z0-9_-]/g, c => '_' + c.charCodeAt(0).toString(16));
}

// A tab is a wrapper holding two sibling buttons. The remove control used to
// live *inside* the tab button — interactive content nested in a button, which
// is invalid, keyboard-unreachable, and had no accessible name.
function buildTopicTab(topic) {
  const active = topic === state.activeTopic;
  const encrypted = isE2eeTopic(topic);
  const unread = (state.unreadCounts && state.unreadCounts[topic]) || 0;

  const wrap = document.createElement('div');
  wrap.className = `topic-tab${active ? ' active' : ''}`;
  wrap.dataset.topic = topic;

  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'topic-tab-select';
  select.id = topicDomId(topic);
  select.setAttribute('role', 'tab');
  select.setAttribute('aria-selected', active ? 'true' : 'false');
  select.setAttribute('aria-controls', 'messages-list');
  // Roving tabindex: only the selected tab is in the tab order; arrow keys
  // move between tabs (ARIA Authoring Practices, Tabs pattern).
  select.tabIndex = active ? 0 : -1;
  select.dataset.action = 'select-topic';
  select.dataset.topic = topic;
  select.setAttribute('aria-label',
    `${topic}${encrypted ? ', end-to-end encrypted' : ''}${unread ? `, ${unread} unread` : ''}`);

  if (encrypted) {
    const lock = document.createElement('span');
    lock.className = 'topic-lock';
    lock.setAttribute('aria-hidden', 'true');
    lock.textContent = '🔒';
    select.appendChild(lock);
  }

  const label = document.createElement('span');
  label.className = 'topic-tab-label';
  label.textContent = topic;
  select.appendChild(label);

  if (unread) {
    const badge = document.createElement('span');
    badge.className = 'unread-badge';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = String(unread);
    select.appendChild(badge);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.dataset.action = 'remove-topic';
  remove.dataset.topic = topic;
  remove.setAttribute('aria-label', `Unsubscribe from ${topic}`);
  remove.textContent = '×';

  wrap.append(select, remove);
  return wrap;
}

function renderTopicTabs() {
  if (state.topics.length === 0) {
    topicsSection.hidden = true;
    topicTabs.replaceChildren();
    if (topicSortable) {
      topicSortable.destroy();
      topicSortable = null;
    }
    renderConnectionStatus();
    return;
  }
  topicsSection.hidden = false;

  const frag = document.createDocumentFragment();
  for (const t of state.topics) frag.appendChild(buildTopicTab(t));
  topicTabs.replaceChildren(frag);

  initTopicSortable();
  renderConnectionStatus();
}

// Keyboard support for the tablist: arrows move focus, Alt+arrows reorder
// (the keyboard alternative to the SortableJS drag, per WCAG 2.2 SC 2.5.7),
// Delete unsubscribes.
topicTabs.addEventListener('keydown', (e) => {
  const tabs = Array.from(topicTabs.querySelectorAll('.topic-tab-select'));
  const idx = tabs.indexOf(document.activeElement);
  if (idx === -1) return;

  if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    e.preventDefault();
    const to = idx + (e.key === 'ArrowRight' ? 1 : -1);
    if (to < 0 || to >= state.topics.length) return;
    const [moved] = state.topics.splice(idx, 1);
    state.topics.splice(to, 0, moved);
    localStorage.setItem('pigeon_topics', JSON.stringify(state.topics));
    renderTopicTabs();
    const target = topicTabs.querySelectorAll('.topic-tab-select')[to];
    if (target) target.focus();
    announce(`${moved} moved to position ${to + 1} of ${state.topics.length}`);
    return;
  }

  let next = null;
  if (e.key === 'ArrowRight') next = tabs[(idx + 1) % tabs.length];
  else if (e.key === 'ArrowLeft') next = tabs[(idx - 1 + tabs.length) % tabs.length];
  else if (e.key === 'Home') next = tabs[0];
  else if (e.key === 'End') next = tabs[tabs.length - 1];
  else if (e.key === 'Delete') {
    e.preventDefault();
    removeTopic(tabs[idx].dataset.topic);
    return;
  }

  if (next) {
    e.preventDefault();
    next.focus();
    selectTopic(next.dataset.topic);
    // selectTopic re-renders, so re-acquire the focused element.
    const refocus = document.getElementById(next.id);
    if (refocus) refocus.focus();
  }
});

function msgTags(msg) {
  return msg.tags ? msg.tags.split(',').map(t => t.trim()) : [];
}

// Todo convention: a message with tags `todo,done` whose body is an existing
// message id marks that message as complete. doneIds is the set of completed
// todo ids; markerIds is the set of marker-message ids (so we can clean them
// up alongside their originals when clearing completed); markersFor maps a
// completed todo to the markers claiming it, which is how un-ticking works —
// deleting the markers restores the todo to open.
function getDoneTodoIds(allMsgs) {
  const doneIds = new Set();
  const markerIds = new Set();
  const markersFor = new Map();
  for (const m of allMsgs) {
    if (!isTodoMarker(m)) continue;
    const ref = (m.message || '').trim();
    if (!ref) continue;
    doneIds.add(ref);
    markerIds.add(m.id);
    const existing = markersFor.get(ref);
    if (existing) existing.push(m.id);
    else markersFor.set(ref, [m.id]);
  }
  return { doneIds, markerIds, markersFor };
}

function isTodoMarker(msg) {
  const tags = msgTags(msg);
  return tags.includes('todo') && tags.includes('done');
}

// --- Static, developer-authored icon markup -------------------------------
const PRIORITY_ICONS = {
  5: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
  4: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
  3: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
};
const PRIORITY_NAMES = { 5: 'critical', 4: 'high', 3: 'normal', 2: 'low', 1: 'info' };
const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const EDIT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>';
const DELETE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14H6L5 6m3 0V4h8v2m-6 5v6m4-6v6"></path></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

// ---------------------------------------------------------------------------
// Incremental rendering
//
// renderMessages() used to rebuild messagesList.innerHTML on every call — which
// happens on every arriving WebSocket message, every filter toggle and every
// todo tick. That destroyed keyboard focus, reset the screen reader's reading
// position, and re-ran the entrance animation on every card in the list.
//
// Cards are now cached by message id and reused whenever the fields that affect
// their rendering are unchanged, so an arriving message touches only the DOM it
// actually adds.
// ---------------------------------------------------------------------------

const messageEls = new Map();    // message id -> card element
const composeSlots = new Map();  // message id -> inline edit slot element
// Ids already rendered at least once; used so only genuinely new messages get
// the slide-in animation.
const animatedIds = new Set();
let filterRowEl = null;
let filterRowSig = null;
let emptyStateEl = null;
let emptyStateSig = null;

// Marks every message currently known for a topic as already-seen, so loading
// history or switching topics doesn't animate the whole list.
function markMessagesSeen(topic) {
  for (const m of state.messages[topic] || []) animatedIds.add(m.id);
}

// ---------------------------------------------------------------------------
// Stable list order across an edit
//
// Editing a message — a full save, or ticking one `- [ ]` box in its body — is
// implemented as publish-new + delete-old, so the message comes back from the
// server with a fresh id and a fresh created_at. In a newest-first list that
// sent the row straight to the top: tick a task halfway down and it vanished
// from under the pointer, taking keyboard focus with it. An edit is not a new
// arrival, so a republished message inherits the sort position of the message
// it replaces and stays exactly where the user left it.
// ---------------------------------------------------------------------------

const messageOrder = new Map();     // message id -> inherited sort key
const republishedFrom = new Map();  // replaced id -> replacement id
// Aliases outlive the message they point away from (focus has to follow an id
// across the delete that retires it), so they're bounded rather than cleaned up
// on delete. Only the most recent edits can still be holding focus.
const MAX_ALIASES = 50;

function orderKey(msg) {
  const inherited = messageOrder.get(msg.id);
  return inherited === undefined ? msg.created_at : inherited;
}

// The sort key a message currently occupies. Read *before* republishing, since
// the original is deleted as part of the round trip.
function orderKeyForId(topic, id) {
  const inherited = messageOrder.get(id);
  if (inherited !== undefined) return inherited;
  const msg = (state.messages[topic] || []).find(m => m.id === id);
  return msg ? msg.created_at : null;
}

// Hands `newId` the list position (and the identity, for focus purposes) of the
// message it replaces.
function inheritPosition(oldId, newId, key) {
  if (!newId) return;
  if (key != null) messageOrder.set(newId, key);
  if (oldId) {
    republishedFrom.set(oldId, newId);
    while (republishedFrom.size > MAX_ALIASES) {
      republishedFrom.delete(republishedFrom.keys().next().value);
    }
  }
  // A republish is not an arrival: no entrance animation, no announcement.
  animatedIds.add(newId);
}

// The server broadcasts a published message over the WebSocket before it
// answers the POST, so the replacement is usually already on screen by the time
// the publish call resolves — too late to place it. Instead we describe what we
// are about to publish and recognise the echo by its content when it arrives.
const pendingRepublish = new Map();  // content signature -> { oldId, key }
const REPUBLISH_TTL = 60000;

function republishSignature(topic, fields) {
  return JSON.stringify([
    topic,
    fields.title || '',
    fields.tags || '',
    fields.message == null ? '' : String(fields.message),
  ]);
}

// Returns a cancel function for the caller to run if the publish never happens.
function expectRepublish(topic, oldId, key, fields) {
  if (key == null) return () => {};
  const sig = republishSignature(topic, fields);
  const entry = { oldId, key };
  pendingRepublish.set(sig, entry);
  const drop = () => {
    if (pendingRepublish.get(sig) === entry) pendingRepublish.delete(sig);
  };
  // A publish whose echo never arrives (socket dropped mid-flight) must not
  // leave an entry behind that later mistakes an unrelated message for an edit.
  setTimeout(drop, REPUBLISH_TTL);
  return drop;
}

// Recognises an incoming message as the echo of an edit this client made and
// gives it the replaced message's slot. Returns the match, or null.
function matchRepublish(topic, msg) {
  const sig = republishSignature(topic, msg);
  const pending = pendingRepublish.get(sig);
  if (!pending) return null;
  pendingRepublish.delete(sig);
  inheritPosition(pending.oldId, msg.id, pending.key);
  return pending;
}

// New messages go to the head of the newest-first list; a republished one goes
// exactly where its predecessor sits. Sort keys are whole seconds, so several
// messages routinely tie — array position, which the stable sort in
// renderMessages preserves, is what actually pins an edit in place.
function insertMessage(topic, msg, replaced) {
  const list = state.messages[topic];
  const anchor = replaced ? list.findIndex(m => m.id === replaced.oldId) : -1;
  if (anchor >= 0) list.splice(anchor, 0, msg);
  else list.unshift(msg);
}

// Follows an id forward through however many republishes have retired it, so a
// control can be found again after several rapid edits.
function currentIdFor(id) {
  let cur = id;
  for (let hops = 0; hops < MAX_ALIASES && republishedFrom.has(cur); hops++) {
    cur = republishedFrom.get(cur);
  }
  return cur;
}

// True for a message the client itself just republished, so the WS echo of it
// isn't announced to screen readers as a new incoming message.
function isRepublish(id) {
  return messageOrder.has(id);
}

function forgetMessageOrder(id) {
  messageOrder.delete(id);
}

// ---------------------------------------------------------------------------
// Focus preservation across a re-render
//
// A card is rebuilt whenever its content changes, and a republish changes its
// message id as well — so the control the user is operating gets removed
// mid-render and focus silently drops to <body>. That restarts keyboard and
// screen-reader navigation from the top of the document. We describe the
// focused control before the reconcile and re-acquire the equivalent control
// afterwards (WCAG 2.4.3 focus order / 3.2.2 on input).
// ---------------------------------------------------------------------------

function cssValue(str) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(str) : str;
}

function captureFocus() {
  const el = document.activeElement;
  if (!el || el === document.body || !messagesList.contains(el)) return null;
  // Only [data-action] controls are re-creatable from a description; anything
  // else in the list (the transplanted compose editor) is moved, not rebuilt.
  const action = el.dataset && el.dataset.action;
  if (!action) return null;
  return {
    el,
    action,
    msgId: el.dataset.msgId || '',
    taskIndex: el.dataset.taskIndex || '',
  };
}

function restoreFocus(saved) {
  if (!saved || saved.el.isConnected) return;
  // Only step in for focus this render dropped — never steal it from wherever
  // it legitimately moved to.
  const active = document.activeElement;
  if (active && active !== document.body) return;

  const msgId = currentIdFor(saved.msgId);
  let selector = `[data-action="${cssValue(saved.action)}"]`;
  if (msgId) selector += `[data-msg-id="${cssValue(msgId)}"]`;
  if (saved.taskIndex) selector += `[data-task-index="${cssValue(saved.taskIndex)}"]`;

  const next = messagesList.querySelector(selector);
  // preventScroll: the control is back in the same place, so the browser's
  // scroll-into-view would only ever jolt the list.
  if (next) {
    next.focus({ preventScroll: true });
    return;
  }
  // The control is genuinely gone (its message was deleted). Land focus on the
  // card it belonged to so the user keeps their place in the list.
  const card = msgId && messagesList.querySelector(`.message-card[data-msg-id="${cssValue(msgId)}"]`);
  if (card) {
    card.tabIndex = -1;
    card.focus({ preventScroll: true });
  }
}

// Places `desired` as the exact child list of `parent`, moving existing nodes
// rather than recreating them.
function reconcileChildren(parent, desired) {
  const keep = new Set(desired);
  for (const child of Array.from(parent.childNodes)) {
    if (!keep.has(child)) parent.removeChild(child);
  }
  let ref = parent.firstChild;
  for (const node of desired) {
    if (node === ref) {
      ref = ref.nextSibling;
      continue;
    }
    parent.insertBefore(node, ref);
  }
}

function iconButton(className, iconMarkup, label, action, msgId) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.dataset.action = action;
  btn.dataset.msgId = msgId;
  btn.setAttribute('aria-label', label);
  const icon = document.createElement('span');
  icon.className = 'btn-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = iconMarkup;
  btn.appendChild(icon);
  return btn;
}

function buildPriorityBadge(priority) {
  const badge = document.createElement('span');
  badge.className = 'msg-priority-badge';
  if (PRIORITY_ICONS[priority]) {
    const icon = document.createElement('span');
    icon.className = 'msg-priority-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = PRIORITY_ICONS[priority];
    badge.appendChild(icon);
  }
  badge.appendChild(document.createTextNode(`P${priority}`));
  // Colour and a glyph alone can't carry priority (WCAG 1.4.1) — spell it out
  // for assistive tech.
  const sr = document.createElement('span');
  sr.className = 'visually-hidden';
  sr.textContent = ` ${PRIORITY_NAMES[priority] || ''} priority`;
  badge.appendChild(sr);
  return badge;
}

function buildTagChip(raw, active = false) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'tag-chip';
  chip.dataset.action = 'filter-tag';
  chip.dataset.tag = raw;
  if (active) chip.classList.add('is-active');
  chip.setAttribute('aria-pressed', active ? 'true' : 'false');

  // Emoji is additive and decorative — the real tag name is always shown so a
  // tag is never replaced by a bare glyph (WCAG 1.1.1 / 1.4.1).
  const { emoji, label } = emojifyTag(raw);
  if (emoji) {
    const icon = document.createElement('span');
    icon.className = 'tag-chip-emoji';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = emoji;
    chip.appendChild(icon);
  }
  const text = document.createElement('span');
  text.className = 'tag-chip-label';
  text.textContent = label;
  chip.appendChild(text);

  chip.setAttribute('aria-label', `Filter by tag: ${raw}`);
  return chip;
}

function buildTimeEl(msg) {
  const date = new Date(msg.created_at * 1000);
  const time = document.createElement('time');
  time.className = 'msg-time';
  time.dateTime = date.toISOString();
  time.title = date.toLocaleString();
  time.setAttribute('data-time', String(msg.created_at));
  time.textContent = timeAgo(date);
  return time;
}

function buildCard(msg, ctx) {
  const card = document.createElement('article');
  card.className = `message-card priority-${msg.priority}`;
  card.dataset.msgId = msg.id;

  const header = document.createElement('div');
  header.className = 'msg-header';
  const left = document.createElement('div');
  left.className = 'msg-header-left';
  const right = document.createElement('div');
  right.className = 'msg-header-right';
  right.appendChild(buildTimeEl(msg));

  if (msg._locked) {
    card.classList.add('locked-message');
    const title = document.createElement('h3');
    title.className = 'msg-title';
    title.textContent = '🔒 Encrypted message';
    left.appendChild(title);
    header.append(left, right);
    const body = document.createElement('div');
    body.className = 'msg-body locked-body';
    body.textContent = 'Enter the topic passphrase to decrypt this message.';
    const unlock = document.createElement('button');
    unlock.type = 'button';
    unlock.className = 'btn btn-secondary unlock-btn';
    unlock.dataset.action = 'unlock-topic';
    unlock.dataset.topic = msg.topic;
    unlock.textContent = 'Unlock';
    body.appendChild(document.createTextNode(' '));
    body.appendChild(unlock);
    card.append(header, body);
    return card;
  }

  const titleText = msg.title || '';
  if (ctx.isTodo) card.classList.add('is-todo');
  if (ctx.isDone) card.classList.add('is-done');

  if (ctx.isTodo) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'todo-checkbox';
    cb.checked = ctx.isDone;
    // A completed todo stays tickable. Disabling it stranded keyboard focus on
    // a dead control and left an accidental tick with no way back other than
    // deleting the task outright; unticking is the expected undo.
    cb.dataset.action = 'toggle-todo';
    cb.dataset.msgId = msg.id;
    cb.dataset.topic = msg.topic;
    cb.dataset.done = ctx.isDone ? '1' : '0';
    cb.setAttribute('aria-label',
      ctx.isDone ? `Mark "${titleText}" not complete` : `Mark "${titleText}" complete`);
    left.appendChild(cb);
  }

  if (titleText) {
    const title = document.createElement('h3');
    title.className = 'msg-title';
    title.appendChild(document.createTextNode(titleText));
    if (msg.priority >= 3) title.appendChild(buildPriorityBadge(msg.priority));
    left.appendChild(title);
  } else if (msg.priority >= 3) {
    left.appendChild(buildPriorityBadge(msg.priority));
  }

  const messageLabel = titleText || 'message';
  right.appendChild(iconButton('edit-btn', EDIT_ICON, `Edit message: ${messageLabel}`, 'edit-msg', msg.id));
  right.appendChild(iconButton('copy-btn', COPY_ICON, `Copy message: ${messageLabel}`, 'copy-msg', msg.id));
  right.appendChild(iconButton('edit-btn delete-btn', DELETE_ICON, `Delete message: ${messageLabel}`, 'delete-msg', msg.id));

  header.append(left, right);
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'msg-body' + (ctx.isDone ? ' todo-done' : '');
  if (msg.markdown) {
    body.innerHTML = renderMarkdown(msg.message, msg.id);
    // Give each rendered `- [ ]` checkbox the text of its own list item.
    body.querySelectorAll('.md-task-checkbox').forEach((cb, i) => {
      const li = cb.closest('li');
      const text = li ? li.textContent.trim() : '';
      cb.setAttribute('aria-label', text || `Task ${i + 1}`);
    });
  } else {
    body.textContent = msg.message == null ? '' : String(msg.message);
  }
  // A todo title that exactly repeats its body adds no information and makes
  // the card sound broken when read aloud. Keep the title and omit the copy.
  const duplicateTodoBody = ctx.isTodo && titleText && titleText.trim() === String(msg.message || '').trim();
  if (!duplicateTodoBody) card.appendChild(body);

  const safeImage = safeHttpUrl(msg.image);
  if (safeImage) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-image';
    const img = document.createElement('img');
    img.src = safeImage;
    // The title is publisher-supplied and describes the image when available.
    // Keep an explicitly empty alt for purely decorative images without one.
    img.alt = typeof msg.imageAlt === 'string' ? msg.imageAlt : (msg.title || '');
    img.loading = 'lazy';
    wrap.appendChild(img);
    card.appendChild(wrap);
  }

  const tagNames = msgTags(msg).filter(Boolean);
  if (tagNames.length) {
    const tags = document.createElement('div');
    tags.className = 'msg-tags';
    for (const raw of tagNames) tags.appendChild(buildTagChip(raw, isTagActive(raw)));
    card.appendChild(tags);
  }

  return card;
}

// Everything that changes a card's rendered output. Timestamps are excluded
// deliberately — they're refreshed in place by the ticker below, so a passing
// minute must not rebuild (and re-animate) every card.
function cardSignature(msg, ctx) {
  return JSON.stringify([
    msg.title, msg.message, msg.tags, msg.priority, msg.image, msg.imageAlt,
    !!msg.markdown, !!msg._locked, ctx.isTodo, ctx.isDone, ctx.editingThis,
  ]);
}

function getCard(msg, ctx) {
  const sig = cardSignature(msg, ctx);
  const cached = messageEls.get(msg.id);
  if (cached && cached.dataset.sig === sig) {
    cached.hidden = ctx.editingThis;
    // A click flips `checked` in the DOM before the server has confirmed it.
    // Re-assert the stored state so a failed round trip visibly rolls back
    // instead of leaving a tick the server never recorded.
    const cb = cached.querySelector('.todo-checkbox');
    if (cb && cb.checked !== ctx.isDone) cb.checked = ctx.isDone;
    syncChipPressedState(cached);
    return cached;
  }
  const card = buildCard(msg, ctx);
  card.dataset.sig = sig;
  card.hidden = ctx.editingThis;
  if (!animatedIds.has(msg.id)) {
    card.classList.add('is-new');
    animatedIds.add(msg.id);
  }
  messageEls.set(msg.id, card);
  return card;
}

function getComposeSlot(id) {
  let slot = composeSlots.get(id);
  if (!slot) {
    slot = document.createElement('div');
    slot.className = 'compose-slot';
    slot.dataset.msgId = id;
    composeSlots.set(id, slot);
  }
  return slot;
}

function buildFilterRow(uniqueTags) {
  const active = new Set(getActiveFilterTags());
  // Keep an active chip reachable even when its tag no longer appears in the
  // topic's current tag set (e.g. every matching message was deleted), so the
  // user can still toggle it off.
  const chipTags = Array.from(new Set([...uniqueTags, ...active])).sort();
  if (chipTags.length === 0) return null;

  const row = document.createElement('div');
  row.className = 'tags-row';
  const label = document.createElement('span');
  label.className = 'tags-label';
  label.id = 'tags-row-label';
  label.textContent = 'Filter by tag:';
  const chips = document.createElement('div');
  chips.className = 'tags-chips-container';
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-labelledby', 'tags-row-label');
  for (const t of chipTags) chips.appendChild(buildTagChip(t, active.has(t)));
  if (active.size > 0) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn btn-tertiary clear-filter-btn';
    clear.dataset.action = 'clear-filter';
    clear.textContent = 'Clear';
    chips.appendChild(clear);
  }
  row.append(label, chips);
  return row;
}

function getFilterRow(uniqueTags) {
  const sig = JSON.stringify([getActiveFilterTags(), uniqueTags]);
  if (filterRowSig !== sig) {
    filterRowSig = sig;
    filterRowEl = buildFilterRow(uniqueTags);
  }
  return filterRowEl;
}

function buildEmptyState(kind, topic) {
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'empty-state-icon');
  icon.setAttribute('viewBox', '0 0 80 80');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = kind === 'no-topic'
    ? '<circle cx="40" cy="40" r="32" stroke="currentColor" stroke-width="2" opacity="0.2"/><path d="M40 25v15l10 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.4"/>'
    : '<rect x="12" y="24" width="56" height="36" rx="4" stroke="currentColor" stroke-width="2"/><path d="M12 28l28 18 28-18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="62" cy="22" r="8" fill="#7a8b5c" opacity="0.2" stroke="#7a8b5c" stroke-width="2"/><path d="M59 22l2 2 4-4" stroke="#7a8b5c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  wrap.appendChild(icon);

  const title = document.createElement('p');
  title.className = 'empty-state-title';
  const hint = document.createElement('p');
  hint.className = 'empty-state-hint';

  if (kind === 'no-topic') {
    title.textContent = 'No topic selected';
    hint.textContent = 'Select a topic from the list or subscribe to a new one.';
    wrap.append(title, hint);
  } else if (kind === 'filtered') {
    title.textContent = 'No messages match this filter';
    hint.textContent = 'Try clearing the filter or sending a message with these tags.';
    wrap.append(title, hint);
  } else {
    title.textContent = 'Listening for messages';
    hint.textContent = 'Use the compose area below or send one via HTTP:';
    const cmd = document.createElement('code');
    cmd.className = 'empty-state-cmd';
    cmd.textContent = `curl -d "Hello!" ${location.origin}/${topic}`;
    wrap.append(title, hint, cmd);
  }
  return wrap;
}

function getEmptyState(kind, topic) {
  const sig = `${kind}|${topic || ''}`;
  if (emptyStateSig !== sig) {
    emptyStateSig = sig;
    emptyStateEl = buildEmptyState(kind, topic);
  }
  return emptyStateEl;
}

function renderMessages() {
  const topic = state.activeTopic;
  const desired = [];
  const savedFocus = captureFocus();

  if (!topic) {
    messageEls.clear();
    desired.push(getEmptyState('no-topic'));
    reconcileChildren(messagesList, desired);
    if (clearCompletedBtn) clearCompletedBtn.hidden = true;
    placeCompose();
    return;
  }

  const allMsgs = state.messages[topic] || [];
  const { doneIds } = getDoneTodoIds(allMsgs);
  if (clearCompletedBtn) clearCompletedBtn.hidden = doneIds.size === 0;

  // Newest first, except that an edited message keeps the position of the one
  // it replaced. Array.sort is stable, so messages sharing a timestamp (the
  // server records whole seconds) keep their arrival order.
  let msgs = allMsgs.slice()
    .sort((a, b) => orderKey(b) - orderKey(a))
    .filter(m => !isTodoMarker(m));

  // Every tag present in the topic, offered as quick filters.
  const uniqueTags = Array.from(new Set(msgs.flatMap(m => msgTags(m)))).sort();

  const activeFilterTags = getActiveFilterTags();
  if (activeFilterTags.length > 0) {
    msgs = msgs.filter(m => {
      const tags = msgTags(m);
      return activeFilterTags.every(t => tags.includes(t));
    });
  }

  const filterRow = getFilterRow(uniqueTags);
  if (filterRow) desired.push(filterRow);

  const visible = new Set();
  for (const msg of msgs) {
    const tagList = msgTags(msg);
    const isTodo = tagList.includes('todo');
    const ctx = {
      isTodo,
      isDone: isTodo && doneIds.has(msg.id),
      editingThis: !!(state.editing && state.editing.id === msg.id),
    };
    visible.add(msg.id);
    desired.push(getCard(msg, ctx));
    if (ctx.editingThis) desired.push(getComposeSlot(msg.id));
  }

  // Drop cached cards for messages that are no longer shown.
  for (const id of Array.from(messageEls.keys())) {
    if (!visible.has(id)) messageEls.delete(id);
  }

  if (msgs.length === 0) {
    desired.push(getEmptyState(activeFilterTags.length ? 'filtered' : 'listening', topic));
  }

  reconcileChildren(messagesList, desired);
  placeCompose();
  restoreFocus(savedFocus);
  if (!state.editing) composeSlots.clear();
}

// Move the compose form to its correct location after a render. While editing,
// the form lives inside the slot rendered under the message being edited;
// otherwise it sits in its original parent. Because slots are cached and
// reconciled rather than rebuilt, an ongoing edit survives a re-render with no
// DOM move at all — which matters because re-parenting the Toast UI editor
// resets its selection.
function placeCompose() {
  if (!composeEl || !composeHome) return;
  if (state.editing) {
    const slot = composeSlots.get(state.editing.id);
    if (slot && slot.isConnected) {
      if (composeEl.parentElement !== slot) slot.appendChild(composeEl);
      return;
    }
  }
  if (composeEl.parentElement !== composeHome) composeHome.appendChild(composeEl);
}

function isTagActive(tag) {
  if (!state.activeTopic) return false;
  const set = state.filterTags.get(state.activeTopic);
  return !!set && set.has(tag);
}

function getActiveFilterTags() {
  if (!state.activeTopic) return [];
  const set = state.filterTags.get(state.activeTopic);
  return set ? Array.from(set).sort() : [];
}

// Toggle a filter chip. Active filters are AND-ed: a message must carry every
// active tag to stay visible.
function setFilterTag(tag) {
  if (!state.activeTopic) return;
  let set = state.filterTags.get(state.activeTopic);
  if (!set) {
    set = new Set();
    state.filterTags.set(state.activeTopic, set);
  }
  if (set.has(tag)) set.delete(tag);
  else set.add(tag);
  if (set.size === 0) state.filterTags.delete(state.activeTopic);
  renderMessages();
  syncUrl();
}

function clearFilterTag() {
  if (!state.activeTopic) return;
  state.filterTags.delete(state.activeTopic);
  renderMessages();
  syncUrl();
}

// Keep message-card chips' pressed state in sync after a filter change without
// rebuilding the card (cardSignature deliberately omits filter state).
function syncChipPressedState(root) {
  root.querySelectorAll('.tag-chip').forEach((chip) => {
    const on = isTagActive(chip.dataset.tag);
    chip.classList.toggle('is-active', on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

// Mirror the active topic and its filter in the URL query string so a filtered
// view can be shared and survives reload. replaceState avoids history spam.
function syncUrl() {
  const params = new URLSearchParams(location.search);
  const topic = state.activeTopic;
  const tags = getActiveFilterTags();
  if (topic) params.set('topic', topic);
  else params.delete('topic');
  if (tags.length) params.set('tags', tags.join(','));
  else params.delete('tags');
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
}

// Restore the topic/filter encoded in ?topic=…&tags=… when still subscribed.
function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  const topic = params.get('topic');
  if (!topic || !state.topics.includes(topic)) return false;
  const tagsParam = params.get('tags');
  const tags = tagsParam ? tagsParam.split(',').map(t => t.trim()).filter(Boolean) : [];
  if (tags.length) state.filterTags.set(topic, new Set(tags));
  selectTopic(topic);
  return true;
}

async function toggleTodo(id, topic, done) {
  if (done) {
    await uncompleteTodo(id, topic);
    return;
  }
  try {
    if (isE2eeTopic(topic)) {
      const key = state.topicKeys[topic];
      if (!key) {
        toastError('No passphrase loaded for this topic, so it can\'t be marked complete.');
        return;
      }
      const meta = state.topicMeta[topic];
      const envelope = await PigeonCrypto.encryptFields(
        key,
        { message: id, tags: 'todo,done' },
        meta.salt,
        meta.iter,
      );
      await apiFetch(`/${topic}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.pigeon.e2ee+json',
          'X-Encrypted': '1',
        },
        body: envelope,
      });
    } else {
      await apiFetch(`/${topic}`, {
        method: 'POST',
        headers: { 'X-Tags': 'todo,done' },
        body: id,
      });
    }
    // The tick itself is silent to a screen reader — the checkbox state change
    // isn't announced when the card is rebuilt underneath it.
    announce(`${todoLabel(topic, id)} marked complete.`);
  } catch (err) {
    console.error('toggleTodo failed:', err);
    toastError("Couldn't mark that task complete.", {
      actionLabel: 'Retry',
      onAction: () => toggleTodo(id, topic, done),
    });
    // The optimistic tick is undone by the next render, which reads completion
    // state back from the message stream.
    renderMessages();
  }
}

// Un-tick a completed todo by deleting the marker message(s) that claim it.
// The task itself is untouched — this is the undo for an accidental tick, not
// a delete.
async function uncompleteTodo(id, topic) {
  const markers = getDoneTodoIds(state.messages[topic] || []).markersFor.get(id) || [];
  if (markers.length === 0) {
    renderMessages();
    return;
  }
  try {
    for (const markerId of markers) {
      await apiFetch(`/${topic}/messages/${markerId}`, { method: 'DELETE' });
    }
    announce(`${todoLabel(topic, id)} marked not complete.`);
  } catch (err) {
    console.error('uncompleteTodo failed:', err);
    toastError("Couldn't reopen that task.", {
      actionLabel: 'Retry',
      onAction: () => uncompleteTodo(id, topic),
    });
    // Put the tick back — the task is still complete on the server.
    renderMessages();
  }
}

function todoLabel(topic, id) {
  const msg = (state.messages[topic] || []).find(m => m.id === id);
  const label = msg && (msg.title || msg.message);
  return label ? `"${String(label).slice(0, 60)}"` : 'Task';
}

// Toggle the Nth `- [ ]` task in a markdown todo body. Mirrors the edit
// pipeline (DELETE old + POST new) so the change propagates via the same
// publish channel as any other edit. Per-message lock prevents id races
// when the user clicks several boxes faster than the round-trip.
async function toggleMarkdownTask(msgId, index) {
  const topic = state.activeTopic;
  if (!topic) return;
  const msgs = state.messages[topic] || [];
  const msg = msgs.find(m => m.id === msgId);
  if (!msg || msg._toggling) return;

  const re = /^(\s*[-*+]\s+)\[([ xX])\]/gm;
  let count = 0;
  let match;
  let newBody = null;
  let nowChecked = false;
  while ((match = re.exec(msg.message)) !== null) {
    if (count === index) {
      nowChecked = match[2] === ' ';
      const replacement = match[1] + (nowChecked ? '[x]' : '[ ]');
      newBody = msg.message.slice(0, match.index) + replacement + msg.message.slice(match.index + match[0].length);
      break;
    }
    count++;
  }
  if (newBody === null) return;

  // The encrypted path needs its key before anything is destroyed.
  const encrypted = isE2eeTopic(topic);
  const key = encrypted ? state.topicKeys[topic] : null;
  if (encrypted && !key) {
    toastError('No passphrase loaded for this topic, so the task can\'t be updated.');
    return;
  }

  const previousBody = msg.message;
  // Read the position now: the republished copy has to land here, not at the
  // top of the list, so the row the user just clicked stays put.
  const position = orderKeyForId(topic, msg.id);
  msg._toggling = true;
  msg.message = newBody;
  renderMessages();

  // Registered before the publish, because the server broadcasts the new
  // message over the WebSocket before it answers the POST.
  const cancelRepublish = expectRepublish(topic, msg.id, position, {
    title: msg.title || '',
    tags: msg.tags || '',
    message: newBody,
  });

  try {
    // Publish the updated message *before* deleting the original. The old
    // order (DELETE then POST) lost the message outright whenever the publish
    // failed — the delete had already gone through.
    if (encrypted) {
      const meta = state.topicMeta[topic];
      const fields = {
        title: msg.title || '',
        message: newBody,
        tags: msg.tags || '',
        markdown: true,
      };
      const envelope = await PigeonCrypto.encryptFields(key, fields, meta.salt, meta.iter);
      await apiFetch(`/${topic}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.pigeon.e2ee+json',
          'X-Encrypted': '1',
          'X-Priority': String(msg.priority || 3),
        },
        body: envelope,
      });
    } else {
      const headers = { 'X-Markdown': '1', 'X-Priority': String(msg.priority || 3) };
      if (msg.title) headers['X-Title'] = msg.title;
      if (msg.tags) headers['X-Tags'] = msg.tags;
      await apiFetch(`/${topic}`, { method: 'POST', headers, body: newBody });
    }
    await apiFetch(`/${topic}/messages/${msg.id}`, { method: 'DELETE' });
    announce(`Task ${index + 1} marked ${nowChecked ? 'complete' : 'not complete'}.`);
  } catch (err) {
    console.error('toggleMarkdownTask failed:', err);
    cancelRepublish();
    // Roll the optimistic edit back so the checkbox matches what's stored.
    msg.message = previousBody;
    renderMessages();
    toastError("Couldn't update that task.", {
      actionLabel: 'Retry',
      onAction: () => toggleMarkdownTask(msgId, index),
    });
  } finally {
    msg._toggling = false;
  }
}

async function requestTopicUnlock(topic) {
  const passphrase = await promptForPassphrase();
  if (!passphrase) return;
  const meta = state.topicMeta[topic];
  if (!meta || !meta.e2ee) return;

  clearTopicCryptoState(topic);
  state.passphrases[topic] = passphrase;
  const locked = (state.messages[topic] || []).filter(msg => msg._locked);
  await Promise.all(locked.map(msg => tryDecryptMessage(topic, msg)));
  if (!locked.some(msg => !msg._locked)) {
    clearTopicCryptoState(topic);
    toastError("That passphrase couldn't decrypt this topic.");
    return;
  }

  try {
    state.topicKeys[topic] = await PigeonCrypto.deriveKey(passphrase, meta.salt, meta.iter);
    await PigeonKeystore.putTopicKey(topic, { passphrase, salt: meta.salt, iter: meta.iter, e2ee: true });
    renderMessages();
    announce(`Unlocked ${topic}.`);
  } catch (err) {
    clearTopicCryptoState(topic);
    console.error('unlockTopic failed:', err);
    toastError("Couldn't save this topic's passphrase.");
  }
}

function promptForPassphrase() {
  if (!unlockDialog || !unlockForm || !unlockPassphrase || typeof unlockDialog.showModal !== 'function') {
    return Promise.resolve(window.prompt('Enter the shared passphrase:') || '');
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      unlockForm.removeEventListener('submit', onSubmit);
      unlockDialog.removeEventListener('close', onClose);
      unlockPassphrase.value = '';
      resolve(value);
    };
    const onSubmit = (event) => {
      event.preventDefault();
      const submitter = event.submitter;
      const value = submitter && submitter.value === 'unlock' ? unlockPassphrase.value : '';
      finish(value);
      unlockDialog.close();
    };
    const onClose = () => finish('');
    unlockForm.addEventListener('submit', onSubmit);
    unlockDialog.addEventListener('close', onClose, { once: true });
    unlockDialog.showModal();
    unlockPassphrase.focus();
  });
}

async function requestDeleteMessage(id) {
  const topic = state.activeTopic;
  const msg = (state.messages[topic] || []).find(item => item.id === id);
  if (!topic || !msg) return;
  const label = msg.title || String(msg.message || 'this message').slice(0, 80);
  const confirmed = await confirmDialog({
    title: 'Delete message?',
    body: `This permanently deletes “${label}”.`,
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (!confirmed) return;
  try {
    await apiFetch(`/${topic}/messages/${id}`, { method: 'DELETE' });
    state.messages[topic] = (state.messages[topic] || []).filter(item => item.id !== id);
    forgetMessageOrder(id);
    cacheTopicMessages(topic);
    if (state.editing && state.editing.id === id) cancelEdit();
    else renderMessages();
    showToast('Message deleted.', { tone: 'success' });
    announce('Message deleted.');
  } catch (err) {
    console.error('requestDeleteMessage failed:', err);
    toastError("Couldn't delete that message.", { actionLabel: 'Retry', onAction: () => requestDeleteMessage(id) });
  }
}

function editMessage(id) {
  const msgs = state.messages[state.activeTopic] || [];
  const msg = msgs.find(m => m.id === id);
  if (!msg) return;

  state.editing = { id: msg.id, topic: msg.topic };
  composeTitle.value = msg.title || '';
  if (composeTags) composeTags.value = msg.tags || '';
  if (composePriority) composePriority.value = String(msg.priority || 3);
  if (editor) editor.setMarkdown(msg.message || '');

  sendBtn.textContent = 'Save';
  composeEditBanner.hidden = false;

  // Re-render to inject the inline slot and transplant the compose form into it.
  renderMessages();
  if (composeEl) composeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Follow the user's focus into the form they just opened — pressing Edit used
  // to destroy the button focus was on and drop focus to <body>.
  focusEditor();
  announce('Editing message. Press Escape to cancel.');
}

// Focus the markdown editor if it exists, else the first field in the form.
function focusEditor() {
  if (editor && typeof editor.focus === 'function') {
    try {
      editor.focus();
      return;
    } catch (err) {
      console.warn('Editor focus failed:', err);
    }
  }
  if (composeTitle) composeTitle.focus();
}

function cancelEdit() {
  const wasEditing = state.editing && state.editing.id;
  state.editing = null;
  composeTitle.value = '';
  if (composeTags) composeTags.value = '';
  if (composePriority) composePriority.value = '3';
  if (editor) editor.setMarkdown('');
  sendBtn.textContent = 'Send';
  composeEditBanner.hidden = true;
  // renderMessages restores the compose form to its home and un-hides the card.
  renderMessages();
  // Return focus to the control that opened the editor.
  if (wasEditing) {
    const card = messageEls.get(wasEditing);
    const btn = card && card.querySelector('.edit-btn');
    if (btn) btn.focus();
  }
}

// Send message from compose form
const composeTitle = document.getElementById('compose-title');
const composeTags = document.getElementById('compose-tags');
const composePriority = document.getElementById('compose-priority');
const sendBtn = document.getElementById('send-btn');
const composeEditBanner = document.getElementById('compose-edit-banner');
const composeEl = document.querySelector('.compose');
// Original parent of `.compose`, captured at startup so we can return the
// form home after it gets transplanted into an inline edit slot.
const composeHome = composeEl ? composeEl.parentElement : null;

let editor = null;
if (typeof toastui !== 'undefined' && toastui.Editor) {
  const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  editor = new toastui.Editor({
    el: document.querySelector('#compose-editor-container'),
    height: '150px',
    initialEditType: 'markdown',
    previewStyle: 'tab',
    theme: isDarkMode ? 'dark' : 'light',
    hideModeSwitch: true,
    toolbarItems: [
      ['heading', 'bold', 'italic', 'strike'],
      ['hr', 'quote'],
      ['ul', 'ol', 'task', 'indent', 'outdent'],
      ['table', 'image', 'link'],
      ['code', 'codeblock']
    ]
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => {
    // Basic reload for theme updates could be done, or dynamically swap classes
  });
}

sendBtn.addEventListener('click', sendMessage);

// Cmd/Ctrl+Enter sends, Escape cancels an edit — the conventions for a
// multi-line composer, neither of which the app previously supported.
document.addEventListener('keydown', (e) => {
  if (!composeEl || !composeEl.contains(document.activeElement)) return;
  if (e.key === 'Escape' && state.editing) {
    e.preventDefault();
    cancelEdit();
    return;
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    sendMessage();
  }
});

async function sendMessage() {
  const body = editor ? editor.getMarkdown().trim() : '';
  if (!body || !state.activeTopic) return;

  const topic = state.activeTopic;
  const title = composeTitle.value.trim();
  const tags = composeTags ? composeTags.value.trim() : '';
  const priority = composePriority ? composePriority.value : '3';

  const editing = state.editing;
  // Saving an edit republishes the message under a new id; read the position it
  // holds now, before the delete below retires it, so the saved copy stays put
  // in the list rather than jumping to the top.
  const position = editing ? orderKeyForId(editing.topic, editing.id) : null;
  const cancelRepublish = editing
    ? expectRepublish(editing.topic, editing.id, position, { title, tags, message: body })
    : () => {};

  sendBtn.disabled = true;
  try {
    if (isE2eeTopic(topic)) {
      const key = state.topicKeys[topic];
      if (!key) {
        toastError('No passphrase loaded for this topic, so the message can\'t be encrypted.');
        cancelRepublish();
        return;
      }
      if (editing) {
        await apiFetch(`/${editing.topic}/messages/${editing.id}`, { method: 'DELETE' });
      }
      const meta = state.topicMeta[topic];
      const fields = { title, message: body, tags, markdown: true };
      const envelope = await PigeonCrypto.encryptFields(key, fields, meta.salt, meta.iter);
      await apiFetch(`/${topic}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.pigeon.e2ee+json',
          'X-Encrypted': '1',
          'X-Priority': priority,
        },
        body: envelope,
      });
    } else {
      if (editing) {
        await apiFetch(`/${editing.topic}/messages/${editing.id}`, { method: 'DELETE' });
      }
      const headers = {};
      if (title) headers['X-Title'] = title;
      if (tags) headers['X-Tags'] = tags;
      headers['X-Markdown'] = '1';
      headers['X-Priority'] = priority;
      await apiFetch(`/${topic}`, {
        method: 'POST',
        headers,
        body,
      });
    }
    if (editor) editor.setMarkdown('');
    composeTitle.value = '';
    if (composeTags) composeTags.value = '';
    if (editing) {
      state.editing = null;
      sendBtn.textContent = 'Send';
      if (composeEditBanner) composeEditBanner.hidden = true;
      // Re-render to restore the compose form home and un-hide the edited card.
      // The pending DELETE will remove the card moments later via the WS event.
      renderMessages();
    }
    announce(editing ? 'Message saved' : 'Message sent');
  } catch (err) {
    console.error('Send failed:', err);
    cancelRepublish();
    // Leave the composed text in place so a retry doesn't mean retyping it.
    toastError(
      editing ? "Couldn't save your changes." : "Couldn't send your message.",
      { actionLabel: 'Retry', onAction: () => sendMessage() },
    );
  } finally {
    sendBtn.disabled = false;
  }
}

// Clear messages for active topic. This deletes them server-side for every
// subscriber and cannot be undone, so it always confirms first.
clearMessagesBtn.addEventListener('click', async () => {
  const topic = state.activeTopic;
  if (!topic) return;
  const count = (state.messages[topic] || []).length;
  if (count === 0) return;

  const ok = await confirmDialog({
    title: `Delete all messages in “${topic}”?`,
    body: `This permanently deletes ${count} message${count === 1 ? '' : 's'} on the server, for every subscriber to this topic. It can't be undone.`,
    confirmLabel: `Delete ${count} message${count === 1 ? '' : 's'}`,
    destructive: true,
  });
  if (!ok) return;

  clearMessagesBtn.disabled = true;
  try {
    await apiFetch(`/${topic}/messages`, { method: 'DELETE' });
    state.messages[topic] = [];
    cacheTopicMessages(topic);
    renderMessages();
    showToast(`Deleted ${count} message${count === 1 ? '' : 's'} from ${topic}.`);
  } catch (err) {
    console.error('Clear messages failed:', err);
    toastError("Couldn't delete the messages.");
  } finally {
    clearMessagesBtn.disabled = false;
  }
});

// Clear only completed todos (originals + their done-marker messages). Each
// DELETE broadcasts a `deleted` event from the worker, so other tabs sync.
if (clearCompletedBtn) {
  clearCompletedBtn.addEventListener('click', async () => {
    const topic = state.activeTopic;
    if (!topic) return;
    const all = state.messages[topic] || [];
    const { doneIds, markerIds } = getDoneTodoIds(all);
    const ids = [...doneIds, ...markerIds];
    if (ids.length === 0) return;

    // Confirm every time, not only past an arbitrary count of three — the
    // deletion is server-side and irreversible whether it's one task or ten.
    const ok = await confirmDialog({
      title: `Delete ${doneIds.size} completed task${doneIds.size === 1 ? '' : 's'}?`,
      body: 'Completed tasks are removed from the server for every subscriber to this topic. This can\'t be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;

    clearCompletedBtn.disabled = true;
    try {
      await Promise.all(ids.map(id =>
        apiFetch(`/${topic}/messages/${id}`, { method: 'DELETE' })
      ));
      showToast(`Deleted ${doneIds.size} completed task${doneIds.size === 1 ? '' : 's'}.`);
    } catch (err) {
      console.error('Clear completed failed:', err);
      toastError("Couldn't delete every completed task. Some may remain.");
    } finally {
      clearCompletedBtn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Push notifications
//
// Three separate things can each keep notifications arriving, so turning push
// off has to deal with all three:
//
//   1. the browser's PushSubscription (the endpoint the push service delivers to)
//   2. the server's push_subscriptions rows — one per topic, keyed by endpoint
//   3. the user's intent, which has to survive a reload
//
// Disabling used to be impossible: the button turned into a disabled "Push
// Enabled" chip with no off state, unsubscribing from a topic left its server
// row behind, and every reload re-registered every topic from whatever
// subscription the browser still had. Now intent is persisted, teardown is
// resumable, and any DELETE the server didn't acknowledge is queued and retried.
// ---------------------------------------------------------------------------

const PUSH_PREF_KEY = 'pigeon_push_enabled';
const PUSH_REGISTRATIONS_KEY = 'pigeon_push_registrations';
const PUSH_PENDING_UNSUB_KEY = 'pigeon_push_pending_unsub';

function readStoredArray(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`Discarding unreadable ${key}:`, err);
    return [];
  }
}

// The user's explicit choice. Anything other than a stored "1" means off, so a
// wiped or corrupt value fails closed (no notifications) rather than open.
function pushPrefEnabled() {
  return localStorage.getItem(PUSH_PREF_KEY) === '1';
}

function setPushPref(on) {
  localStorage.setItem(PUSH_PREF_KEY, on ? '1' : '0');
}

// Installs that enabled push before this preference existed have a live
// subscription and no stored intent — that means on, not off.
function migratePushPref(hasSubscription) {
  if (localStorage.getItem(PUSH_PREF_KEY) === null && hasSubscription) setPushPref(true);
}

// Every (topic, endpoint) pair the server has been told about. Kept because the
// topic list is not a reliable record of what the server still has: a topic
// removed while offline, or an endpoint the browser rotated, would otherwise
// keep pushing with nothing left to point at it.
function loadPushRegistrations() {
  return readStoredArray(PUSH_REGISTRATIONS_KEY);
}

function savePushRegistrations(list) {
  localStorage.setItem(PUSH_REGISTRATIONS_KEY, JSON.stringify(list));
  // Mirror to IDB so the service worker can re-register every topic after an
  // endpoint rotation (pushsubscriptionchange) without a page load.
  PigeonKeystore.setMeta('push_registrations', list).catch(() => {});
}

function rememberPushRegistration(topic, endpoint) {
  const list = loadPushRegistrations();
  if (list.some(r => r.topic === topic && r.endpoint === endpoint)) return;
  list.push({ topic, endpoint });
  savePushRegistrations(list);
}

function forgetPushRegistration(topic, endpoint) {
  savePushRegistrations(loadPushRegistrations().filter(
    r => !(r.endpoint === endpoint && (topic === null || r.topic === topic))));
}

// Endpoints the server may still be pushing to for this topic — the current
// subscription plus any older one we registered and never cleaned up.
function pushEndpointsFor(topic) {
  const endpoints = loadPushRegistrations().filter(r => r.topic === topic).map(r => r.endpoint);
  const current = state.pushSubscription && state.pushSubscription.endpoint;
  if (current && !endpoints.includes(current)) endpoints.push(current);
  return endpoints;
}

// Deletes the server never acknowledged. A failed unsubscribe is the whole
// reason push felt impossible to turn off, so it becomes a durable to-do
// instead of a console.error.
function loadPendingUnsubs() {
  return readStoredArray(PUSH_PENDING_UNSUB_KEY);
}

function savePendingUnsubs(list) {
  localStorage.setItem(PUSH_PENDING_UNSUB_KEY, JSON.stringify(list));
}

function sameUnsub(a, b) {
  return a.endpoint === b.endpoint && (a.topic || null) === (b.topic || null);
}

function queuePendingUnsub(entry) {
  const topic = entry.topic || null;
  // An all-topics delete subsumes the per-topic ones for the same endpoint.
  const list = topic === null
    ? loadPendingUnsubs().filter(e => e.endpoint !== entry.endpoint)
    : loadPendingUnsubs();
  if (list.some(e => sameUnsub(e, { topic, endpoint: entry.endpoint }))) return;
  list.push({ topic, endpoint: entry.endpoint });
  savePendingUnsubs(list);
}

// Drops queued deletes that are no longer owed. An all-topics entry supersedes
// the per-topic ones for the same endpoint, and re-subscribing to a topic
// cancels its pending delete.
function dropPendingUnsub(entry) {
  savePendingUnsubs(loadPendingUnsubs().filter(e => !(
    e.endpoint === entry.endpoint &&
    (entry.topic == null || e.topic === entry.topic)
  )));
}

async function sendPushUnsubscribe(entry) {
  const path = entry.topic ? `/${entry.topic}/push/subscribe` : '/push/subscribe';
  await apiFetch(path, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: entry.endpoint }),
  });
}

// Retries everything owed to the server. Runs at startup and whenever the
// network comes back, so a disable that happened offline still lands.
async function flushPendingUnsubs() {
  const pending = loadPendingUnsubs();
  if (pending.length === 0) return true;

  let allDone = true;
  for (const entry of pending) {
    try {
      await sendPushUnsubscribe(entry);
      dropPendingUnsub(entry);
      forgetPushRegistration(entry.topic, entry.endpoint);
    } catch (err) {
      console.error('Retrying push unsubscribe later:', entry, err);
      allDone = false;
    }
  }
  return allDone;
}

async function registerPushForTopic(topic, subscription) {
  // A registration racing a disable would silently re-arm notifications.
  if (!pushPrefEnabled()) return;
  try {
    await apiFetch(`/${topic}/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        keys: {
          p256dh: arrayBufferToBase64Url(subscription.getKey('p256dh')),
          auth: arrayBufferToBase64Url(subscription.getKey('auth')),
        },
      }),
    });
    rememberPushRegistration(topic, subscription.endpoint);
    dropPendingUnsub({ topic, endpoint: subscription.endpoint });
  } catch (err) {
    console.error(`Push registration failed for topic ${topic}:`, err);
    toastError(`Push notifications couldn't be enabled for ${topic}.`, {
      actionLabel: 'Retry',
      onAction: () => registerPushForTopic(topic, subscription),
    });
  }
}

// Stops the server pushing this topic to this browser. Called when a topic is
// unsubscribed — removing the tab used to leave the server row untouched, so
// notifications kept arriving for a topic no longer in the list.
async function unregisterPushForTopic(topic, endpoint) {
  try {
    await sendPushUnsubscribe({ topic, endpoint });
    forgetPushRegistration(topic, endpoint);
    dropPendingUnsub({ topic, endpoint });
    return true;
  } catch (err) {
    console.error(`Push unregistration failed for topic ${topic}:`, err);
    queuePendingUnsub({ topic, endpoint });
    return false;
  }
}

// Unsubscribe requests in flight, keyed by topic, so an Undo waits for the
// delete it would otherwise race.
const pushCleanupInFlight = new Map();

// Clears every endpoint this browser ever registered for a topic — the current
// subscription plus any the browser rotated away from.
function cleanUpPushForTopic(topic) {
  const endpoints = pushEndpointsFor(topic);
  if (endpoints.length === 0) return Promise.resolve();

  const done = Promise.all(endpoints.map(ep => unregisterPushForTopic(topic, ep)))
    .then(renderPushState)
    .finally(() => {
      if (pushCleanupInFlight.get(topic) === done) pushCleanupInFlight.delete(topic);
    });
  pushCleanupInFlight.set(topic, done);
  return done;
}

// One request clears the endpoint from every topic, including topics this
// browser has already forgotten about.
async function unregisterPushEverywhere(endpoint) {
  try {
    await sendPushUnsubscribe({ topic: null, endpoint });
    forgetPushRegistration(null, endpoint);
    dropPendingUnsub({ topic: null, endpoint });
    return true;
  } catch (err) {
    console.error('Push unregistration failed:', err);
    queuePendingUnsub({ topic: null, endpoint });
    return false;
  }
}

// Full teardown, safe to run repeatedly and safe to interrupt. Intent is
// recorded first: if the tab dies halfway through, the next load resumes the
// teardown instead of treating the leftover subscription as "still enabled".
async function teardownPush(subscription) {
  setPushPref(false);
  state.pushEnabled = false;
  state.pushSubscription = null;

  const endpoint = subscription && subscription.endpoint;
  if (!endpoint) return { serverOk: true, browserOk: true };

  const serverOk = await unregisterPushEverywhere(endpoint);

  let browserOk = true;
  try {
    // The decisive step: once the endpoint is gone the push service rejects
    // further deliveries with 410, which also prunes any server row a failed
    // DELETE left behind.
    browserOk = (await subscription.unsubscribe()) !== false;
  } catch (err) {
    console.error('pushManager.unsubscribe() failed:', err);
    browserOk = false;
  }

  return { serverOk, browserOk };
}

// Push has three states, not two: not enabled, enabled, and blocked at the OS
// or browser level. The blocked state used to be invisible — denying the
// permission left the button reading "Enable Push Notifications" forever.
function setPushHint(message) {
  if (!pushHint) return;
  pushHint.textContent = message || '';
  pushHint.hidden = !message;
}

function renderPushState() {
  if (!enablePushBtn) return;
  const supported = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;

  if (!supported) {
    enablePushBtn.disabled = true;
    enablePushBtn.textContent = 'Push Unavailable';
    setPushHint(isIosSafariNotInstalled()
      ? 'Add Pigeon to your Home Screen to receive push notifications on iOS.'
      : 'This browser doesn\'t support Web Push.');
    return;
  }

  if (state.pushBusy) {
    enablePushBtn.disabled = true;
    enablePushBtn.textContent = state.pushEnabled ? 'Disabling…' : 'Enabling…';
    return;
  }

  const pendingCleanup = loadPendingUnsubs().length > 0;

  if (state.pushEnabled) {
    // The button is the off switch, not a status badge — it stays clickable.
    enablePushBtn.disabled = false;
    enablePushBtn.textContent = 'Disable Push Notifications';
    enablePushBtn.classList.add('enabled');
    setPushHint('Push notifications are on for every subscribed topic.');
    return;
  }

  if (Notification.permission === 'denied') {
    enablePushBtn.disabled = true;
    enablePushBtn.textContent = 'Push Blocked';
    enablePushBtn.classList.remove('enabled');
    setPushHint('Notifications are blocked for this site. Re-enable them in your browser\'s site settings, then reload.');
    return;
  }

  enablePushBtn.disabled = false;
  enablePushBtn.textContent = 'Enable Push Notifications';
  enablePushBtn.classList.remove('enabled');
  // Delivery already stopped when the subscription went away; this is only
  // about the server rows the retry queue is still working through.
  setPushHint(pendingCleanup
    ? 'Push is off on this device. Still clearing it on the server — this retries automatically.'
    : '');
}

// iOS only exposes Web Push to a PWA installed to the Home Screen.
function isIosSafariNotInstalled() {
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  return iOS && !standalone;
}

// Push notification setup
async function enablePush() {
  state.pushBusy = true;
  renderPushState();
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      showToast(permission === 'denied'
        ? 'Notifications are blocked. Re-enable them in your browser\'s site settings.'
        : 'Push notifications were not enabled.');
      return;
    }

    const reg = await navigator.serviceWorker.ready;
    const vapidKeyResponse = await apiFetch('/vapid-key');
    const vapidKey = await vapidKeyResponse.text();
    // Cache the key in IDB so the service worker can resubscribe on endpoint
    // rotation without a page load.
    PigeonKeystore.setMeta('vapid_key', vapidKey).catch(() => {});

    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });

    state.pushSubscription = subscription;
    // Record intent before the first registration, so a registration that
    // lands after a rapid disable can still be told to stand down.
    setPushPref(true);
    state.pushEnabled = true;

    // Register subscription for all current topics
    for (const topic of state.topics) {
      await registerPushForTopic(topic, subscription);
    }

    showToast('Push notifications enabled.', { tone: 'success' });
  } catch (err) {
    console.error('Push subscription failed:', err);
    toastError("Couldn't enable push notifications.", {
      actionLabel: 'Retry',
      onAction: () => enablePush(),
    });
  } finally {
    state.pushBusy = false;
    renderPushState();
  }
}

async function disablePush() {
  state.pushBusy = true;
  renderPushState();
  try {
    let subscription = state.pushSubscription;
    if (!subscription && 'serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      subscription = await reg.pushManager.getSubscription();
    }

    const { serverOk, browserOk } = await teardownPush(subscription);

    if (browserOk && serverOk) {
      showToast('Push notifications disabled.', { tone: 'success' });
    } else if (browserOk) {
      // Delivery has already stopped — the endpoint is gone. The server rows
      // are cleaned up by the retry queue (or pruned by the 410 on next send).
      showToast('Push notifications disabled. Finishing server cleanup in the background.');
    } else {
      toastError("Couldn't fully turn off push notifications on this device.", {
        actionLabel: 'Retry',
        onAction: () => disablePush(),
      });
    }
    announce(browserOk ? 'Push notifications disabled' : 'Push notifications could not be fully disabled');
  } catch (err) {
    console.error('Disabling push failed:', err);
    toastError("Couldn't turn off push notifications.", {
      actionLabel: 'Retry',
      onAction: () => disablePush(),
    });
  } finally {
    state.pushBusy = false;
    renderPushState();
  }
}

enablePushBtn.addEventListener('click', () => {
  if (state.pushBusy) return;
  if (state.pushEnabled) {
    disablePush();
  } else {
    enablePush();
  }
});

// A disable that failed offline is retried as soon as there's a network again.
window.addEventListener('online', () => {
  flushPendingUnsubs().then(renderPushState).catch(err => console.error('Unsubscribe retry failed:', err));
});

// Disabling in one tab has to disable in all of them — a second tab still
// showing push as on is exactly the kind of thing that makes the setting feel
// unreliable, and its re-registrations would fight the teardown.
window.addEventListener('storage', async (e) => {
  if (e.key !== PUSH_PREF_KEY) return;

  if (!pushPrefEnabled()) {
    state.pushEnabled = false;
    state.pushSubscription = null;
  } else if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.getSubscription();
      state.pushSubscription = subscription;
      state.pushEnabled = !!subscription;
    } catch (err) {
      console.error('Reading push subscription failed:', err);
    }
  }
  renderPushState();
});

// ---------------------------------------------------------------------------
// Installed-app notification hygiene (epic #34, child #37)
//
// The service worker posts two kinds of messages to the page: a request to
// open a topic (from a notification click), and a forwarded payload (when a
// push was suppressed because the topic is already on screen). Both feed the
// same in-memory state the WebSocket uses, so nothing is duplicated.
// ---------------------------------------------------------------------------

function handleServiceWorkerMessage(event) {
  const data = event.data;
  if (!data || !data.type) return;
  if (data.type === 'open-topic') {
    openTopicFromNotification(data.topic, data.id);
  } else if (data.type === 'push-forward') {
    ingestPushForwarded(data.payload);
  }
}

// Focus-and-navigate without spawning a second window: the notification click
// lands here when a window was already open.
function openTopicFromNotification(topic, id) {
  if (!topic || !state.topics.includes(topic)) return;
  selectTopic(topic);
  if (id) {
    const card = messagesList.querySelector(`.message-card[data-msg-id="${cssValue(id)}"]`);
    if (card) card.scrollIntoView({ block: 'center' });
  }
}

// Merges a payload the service worker forwarded instead of showing as an OS
// toast (suppressed because the topic was already visible). Dedupes by id so a
// WebSocket delivery of the same message never double-counts.
async function ingestPushForwarded(payload) {
  if (!payload || typeof payload !== 'object') return;
  const topic = payload.topic;
  if (!topic || !state.topics.includes(topic)) return;
  if (!state.messages[topic]) state.messages[topic] = [];
  const msg = { ...payload };
  // Encrypted push payloads ship the envelope as `ct`; the page decrypt path
  // reads `message`.
  if (msg.encrypted && msg.ct != null && msg.message == null) {
    msg.message = msg.ct;
  }
  delete msg.ct;
  await tryDecryptMessage(topic, msg);
  if (!msg.id || state.messages[topic].some((m) => m.id === msg.id)) return;
  insertMessage(topic, msg);
  cacheTopicMessages(topic);
  if (state.activeTopic === topic) {
    renderMessages();
  } else {
    state.unreadCounts[topic] = (state.unreadCounts[topic] || 0) + 1;
    renderTopicTabs();
    updateAppBadge();
  }
}

// Tells the controlling service worker which topic this window is viewing, so
// it can suppress the OS toast for a message that's already on screen.
function notifyServiceWorkerActiveTopic(topic) {
  if (!('serviceWorker' in navigator)) return;
  const controller = navigator.serviceWorker.controller;
  if (controller) controller.postMessage({ type: 'active-topic', topic: topic || null });
}

// Keeps the home-screen badge in step with the in-app unread count, and
// persists the sum to IDB so the service worker can read-modify-write it for
// pushes that arrive while the page is closed.
async function updateAppBadge() {
  const sum = Object.keys(state.unreadCounts)
    .reduce((total, topic) => total + (state.unreadCounts[topic] || 0), 0);
  PigeonKeystore.setMeta('unread_sum', sum).catch(() => {});
  if (!('setAppBadge' in navigator)) return;
  try {
    if (sum > 0) await navigator.setAppBadge(sum);
    else await navigator.clearAppBadge();
  } catch (err) {
    console.warn('Updating the app badge failed:', err);
  }
}

// Helpers
// GitHub-style shortcode → emoji. Unknown shortcodes fall through unchanged.
const EMOJI_SHORTCODES = {
  tada: '🎉', eyes: '👀', white_check_mark: '✅', x: '❌',
  warning: '⚠️', rocket: '🚀', fire: '🔥', bug: '🐛',
  sparkles: '✨', heart: '❤️', thumbsup: '👍', '+1': '👍',
  thumbsdown: '👎', '-1': '👎', heavy_check_mark: '✔️',
  question: '❓', exclamation: '❗', bell: '🔔', lock: '🔒',
  unlock: '🔓', key: '🔑', star: '⭐', zap: '⚡',
  boom: '💥', bomb: '💣', wrench: '🔧', hammer: '🔨',
  gear: '⚙️', mag: '🔍', package: '📦', memo: '📝',
  book: '📖', bookmark: '🔖', calendar: '📅', clock: '🕐',
  hourglass: '⌛', email: '📧', mailbox: '📬', phone: '📞',
  computer: '💻', printer: '🖨️', tv: '📺', camera: '📷',
  movie_camera: '🎥', microphone: '🎤', speaker: '🔊', mute: '🔇',
  house: '🏠', office: '🏢', school: '🏫', hospital: '🏥',
  sunny: '☀️', cloud: '☁️', umbrella: '☂️', snowflake: '❄️',
  zap_bolt: '⚡', rainbow: '🌈', earth_americas: '🌎',
  moon: '🌙', sun: '☀️', fire_engine: '🚒', car: '🚗',
  airplane: '✈️', ship: '🚢', train: '🚆', bike: '🚲',
  trophy: '🏆', medal: '🏅', gift: '🎁', balloon: '🎈',
  art: '🎨', musical_note: '🎵', dart: '🎯', game_die: '🎲',
  coffee: '☕', beer: '🍺', pizza: '🍕', apple: '🍎',
  dog: '🐶', cat: '🐱', mouse: '🐭', rabbit: '🐰',
  bird: '🐦', fish: '🐟', bee: '🐝', ant: '🐜',
  turtle: '🐢', snake: '🐍', dragon: '🐉', unicorn: '🦄',
  skull: '💀', ghost: '👻', alien: '👽', robot: '🤖',
  construction: '🚧', no_entry: '⛔', recycle: '♻️', checkered_flag: '🏁',
  green_circle: '🟢', yellow_circle: '🟡', red_circle: '🔴',
  large_blue_circle: '🔵', black_circle: '⚫', white_circle: '⚪',
  arrow_up: '⬆️', arrow_down: '⬇️', arrow_left: '⬅️', arrow_right: '➡️',
  up: '🆙', new: '🆕', ok: '🆗', cool: '🆒', free: '🆓',
  hundred: '💯', rotating_light: '🚨', mega: '📣', loudspeaker: '📢',
  hourglass_flowing_sand: '⏳', stopwatch: '⏱️', alarm_clock: '⏰',
  pushpin: '📌', paperclip: '📎', scissors: '✂️', pencil2: '✏️',
  eye: '👁️', speech_balloon: '💬', thought_balloon: '💭',
  zzz: '💤', dash: '💨', sweat_drops: '💦',
};

function emojifyTag(tag) {
  // Accept either `tada` or `:tada:`; leave unknown shortcodes alone. Returns
  // the emoji (decorative) separately from the label (always the real tag).
  const key = tag.replace(/^:|:$/g, '');
  return { emoji: EMOJI_SHORTCODES[key] || null, label: tag };
}

// Escapes &, <, > only — safe for HTML text content. Do NOT use inside HTML
// attribute values or JS string literals; use escapeAttr there instead.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// Escapes everything that could break out of a double-quoted HTML attribute.
function escapeAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

// Returns the URL string if it parses to http(s)/mailto; otherwise null.
// Used to gate `<img src>` and `<a href>` targets from publisher-controlled
// headers (X-Image, X-Click) and markdown links.
function safeHttpUrl(str) {
  if (typeof str !== 'string' || !str) return null;
  try {
    const u = new URL(str, location.origin);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
      return u.href;
    }
  } catch {
    // fall through
  }
  return null;
}

function sanitizeMarkdownHtml(html) {
  if (typeof DOMPurify !== 'undefined') {
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'svg', 'math'],
      FORBID_ATTR: ['style'],
      ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
    });
  }
  // No sanitizer available — refuse to render untrusted HTML at all. The
  // caller's input is escaped and shown literally instead.
  return null;
}

function renderMarkdown(str, msgId) {
  if (typeof marked !== 'undefined') {
    const parsed = marked.parse(str);
    const clean = sanitizeMarkdownHtml(parsed);
    if (clean !== null) {
      let html = clean
        .replace(/<pre><code/g, '<div class="code-wrapper"><button class="code-copy-btn" data-action="copy-code">Copy</button><pre><code')
        .replace(/<\/code><\/pre>/g, '</code></pre></div>');
      // Replace marked's `disabled` task checkboxes with interactive ones that
      // toggle the corresponding `- [ ]` in the markdown source via republish.
      // Done after sanitization since DOMPurify lets `<input type="checkbox">`
      // and `data-*` attributes through.
      if (msgId) {
        let taskIdx = 0;
        const safeId = escapeAttr(msgId);
        html = html.replace(/<input\b[^>]*\bdisabled\b[^>]*>/gi, (m) => {
          const checked = /\bchecked\b/i.test(m);
          const idx = taskIdx++;
          return `<input type="checkbox" class="md-task-checkbox"${checked ? ' checked' : ''} data-action="toggle-md-task" data-msg-id="${safeId}" data-task-index="${idx}">`;
        });
      }
      return html;
    }
    // Fall through to the safe minimal renderer below.
  }

  let html = escapeHtml(str);
  // Code blocks: ```...```
  html = html.replace(/```([\s\S]*?)```/g, '<div class="code-wrapper"><button class="code-copy-btn" data-action="copy-code">Copy</button><pre><code>$1</code></pre></div>');
  // Inline code: `...`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold: **...**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic: _..._ or *...*
  html = html.replace(/\b_(.+?)_\b/g, '<em>$1</em>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Links: [text](url) — http(s) only.
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  return html;
}

function copyCode(btn) {
  const code = btn.nextElementSibling.querySelector('code').innerText;
  navigator.clipboard.writeText(code).then(() => {
    const original = btn.innerText;
    btn.innerText = 'Copied';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.innerText = original;
      btn.classList.remove('copied');
    }, 1600);
  });
}

function copyMessage(id, btn) {
  const msgs = state.messages[state.activeTopic] || [];
  const msg = msgs.find(m => m.id === id);
  if (!msg) return;

  navigator.clipboard.writeText(msg.message).then(() => {
    const original = btn.innerHTML;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.innerHTML = original;
      btn.classList.remove('copied');
    }, 1600);
  });
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

function timeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 30) return "Just now";
  let interval = seconds / 31536000;
  if (interval > 1) return Math.floor(interval) + "y ago";
  interval = seconds / 2592000;
  if (interval > 1) return Math.floor(interval) + "mo ago";
  interval = seconds / 86400;
  if (interval > 1) return Math.floor(interval) + "d ago";
  interval = seconds / 3600;
  if (interval > 1) return Math.floor(interval) + "h ago";
  interval = seconds / 60;
  if (interval > 1) return Math.floor(interval) + "m ago";
  return Math.floor(seconds) + "s ago";
}

setInterval(() => {
  if (!state.activeTopic) return;
  document.querySelectorAll('.msg-time').forEach(el => {
    const timeVal = el.getAttribute('data-time');
    if (timeVal) {
      el.textContent = timeAgo(new Date(timeVal * 1000));
    }
  });
}, 60000);

// Re-fetch messages when tab becomes visible to catch anything missed while backgrounded
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  for (const topic of state.topics) {
    const conn = state.eventSources[topic];
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      // Connection is dead, reconnect
      if (conn) {
        clearInterval(conn.heartbeatId);
        conn.ws.close();
        delete state.eventSources[topic];
      }
      connectTopic(topic);
    } else {
      // Connection alive, but re-fetch to catch missed messages
      try {
        const res = await apiFetch(`/${topic}/json?since=all`);
        const msgs = await res.json();
        await Promise.all(msgs.map(m => tryDecryptMessage(topic, m)));
        state.messages[topic] = msgs.reverse();
        // Catching up isn't the same as receiving — don't animate the backlog.
        markMessagesSeen(topic);
        if (state.activeTopic === topic) renderMessages();
      } catch (err) {
        console.warn(`Refresh for ${topic} failed:`, err);
      }
    }
  }
  renderConnectionStatus();
});

init();

