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
  eventSources: {},   // topic -> { ws, heartbeatId }
  unreadCounts: {},
  pushEnabled: false,
  pushSubscription: null,
  filterTag: null,
};

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
  const env = PigeonCrypto.parseEnvelope(msg.message);
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
  } catch (err) {
    console.warn('Decrypt failed for message', msg.id, err);
    msg._locked = true;
  }
  return msg;
}

// DOM elements
const topicInput = document.getElementById('topic-input');
const subscribeBtn = document.getElementById('subscribe-btn');
const e2eeCheckbox = document.getElementById('e2ee-checkbox');
const e2eePassphrase = document.getElementById('e2ee-passphrase');
const topicsSection = document.getElementById('topics-section');
const topicTabs = document.getElementById('topic-tabs');
const messagesSection = document.getElementById('messages-section');
const messagesList = document.getElementById('messages-list');
const enablePushBtn = document.getElementById('enable-push-btn');
const clearMessagesBtn = document.getElementById('clear-messages-btn');

// Open rendered-message links in a new tab so clicking them doesn't tear down
// the SPA (WebSockets, in-memory state) and force a full reload on back-nav.
messagesList.addEventListener('click', (e) => {
  const link = e.target.closest('a[href]');
  if (!link || !messagesList.contains(link)) return;
  const href = link.getAttribute('href');
  if (/^https?:\/\//i.test(href)) {
    e.preventDefault();
    window.open(href, '_blank', 'noopener,noreferrer');
  }
});

// Initialize
async function init() {
  if (typeof Sortable !== 'undefined') {
    new Sortable(topicTabs, {
      animation: 150,
      ghostClass: 'topic-tab-ghost',
      onEnd: function (evt) {
        if (evt.oldIndex === evt.newIndex) return;

        const itemEl = state.topics.splice(evt.oldIndex, 1)[0];
        state.topics.splice(evt.newIndex, 0, itemEl);
        
        localStorage.setItem('pigeon_topics', JSON.stringify(state.topics));
        renderTopicTabs();
      },
    });
  }

  if ('serviceWorker' in navigator) {
    await navigator.serviceWorker.register('/sw.js');

    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      state.pushEnabled = true;
      state.pushSubscription = existing;
      enablePushBtn.textContent = 'Push Enabled';
      enablePushBtn.classList.add('enabled');
      // Re-register push for all topics (idempotent via INSERT OR REPLACE on server)
      Promise.all(
        state.topics.map(topic => registerPushForTopic(topic, existing))
      ).catch(err => console.error('Push re-registration failed:', err));
    }
  }

  // Derive encryption keys for any e2ee topics whose passphrase is in IDB
  await Promise.all(state.topics.filter(isE2eeTopic).map(loadTopicKey));

  state.topics.forEach(topic => connectTopic(topic));
  renderTopicTabs();

  if (state.topics.length > 0) {
    selectTopic(state.topics[0]);
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
  const ok = window.confirm(`Join end-to-end encrypted topic "${topic}"?`);
  if (!ok) return;
  await subscribeToTopic(topic, { e2ee: true, passphrase: k, salt: s, iter: i });
}

// Subscribe to a topic (UI handler)
subscribeBtn.addEventListener('click', async () => {
  const topic = topicInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!topic || state.topics.includes(topic)) return;

  const wantE2ee = !!(e2eeCheckbox && e2eeCheckbox.checked);
  if (wantE2ee) {
    const passphrase = (e2eePassphrase && e2eePassphrase.value) || '';
    if (!passphrase) {
      window.alert('Enter a passphrase to enable end-to-end encryption.');
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
    window.alert(`Subscribe failed: ${err && err.message ? err.message : err}`);
    throw err;
  }
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

window.shareActiveTopic = async () => {
  const topic = state.activeTopic;
  if (!topic || !isE2eeTopic(topic)) return;
  const meta = state.topicMeta[topic];
  const rec = await PigeonKeystore.getTopicKey(topic);
  if (!rec || !rec.passphrase) return;
  const k = encodeURIComponent(rec.passphrase);
  const s = encodeURIComponent(meta.salt);
  const i = meta.iter;
  const url = `${location.origin}/#topic=${encodeURIComponent(topic)}&k=${k}&s=${s}&i=${i}`;
  try {
    await navigator.clipboard.writeText(url);
    window.alert('Share link copied to clipboard.\n\nSend it via a trusted channel — anyone who opens it can read this topic.');
  } catch {
    window.prompt('Copy this share link:', url);
  }
};

// Connect WebSocket for a topic
async function connectTopic(topic) {
  if (state.eventSources[topic]) return;
  state.messages[topic] = state.messages[topic] || [];

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/${topic}/sse`);

  // Buffer messages arriving before history is loaded
  const earlyMessages = [];
  let historyLoaded = false;

  ws.onopen = async () => {
    try {
      const res = await fetch(`/${topic}/json?since=all`);
      const msgs = await res.json();
      const reversed = msgs.reverse();
      await Promise.all(reversed.map(m => tryDecryptMessage(topic, m)));
      state.messages[topic] = reversed;
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
      historyLoaded = true;
      if (state.activeTopic === topic) {
        renderMessages();
      } else if (newEarly > 0) {
        state.unreadCounts[topic] = (state.unreadCounts[topic] || 0) + newEarly;
        renderTopicTabs();
      }
    } catch {}
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
        if (state.messages[topic].length !== before && state.activeTopic === topic) {
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
      state.messages[topic].unshift(msg);
      if (state.activeTopic === topic) {
        renderMessages();
      } else {
        state.unreadCounts[topic] = (state.unreadCounts[topic] || 0) + 1;
        renderTopicTabs();
      }
    } catch {}
  };

  const reconnect = () => {
    clearInterval(heartbeatId);
    delete state.eventSources[topic];
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
  state.activeTopic = topic;
  state.unreadCounts[topic] = 0;
  topicsSection.hidden = false;
  messagesSection.hidden = false;
  const shareBtn = document.getElementById('share-topic-btn');
  if (shareBtn) shareBtn.hidden = !isE2eeTopic(topic);
  renderTopicTabs();
  renderMessages();
}

function removeTopic(topic) {
  disconnectTopic(topic);
  state.topics = state.topics.filter(t => t !== topic);
  localStorage.setItem('pigeon_topics', JSON.stringify(state.topics));

  if (state.topicMeta[topic]) {
    delete state.topicMeta[topic];
    saveTopicMeta();
  }
  clearTopicCryptoState(topic);
  PigeonKeystore.deleteTopicKey(topic).catch(err => console.error('keystore delete:', err));

  if (state.activeTopic === topic) {
    state.activeTopic = state.topics[0] || null;
  }

  renderTopicTabs();
  renderMessages();

  if (state.topics.length === 0) {
    topicsSection.hidden = true;
    messagesSection.hidden = true;
  }
}

function renderTopicTabs() {
  if (state.topics.length === 0) {
    topicsSection.hidden = true;
    return;
  }
  topicsSection.hidden = false;

  topicTabs.innerHTML = state.topics
    .map(t => {
      const unread = state.unreadCounts && state.unreadCounts[t] ? `<span class="unread-badge">${state.unreadCounts[t]}</span>` : '';
      const lockIcon = isE2eeTopic(t)
        ? `<span class="topic-lock" title="End-to-end encrypted" aria-label="encrypted">🔒</span>`
        : '';
      return `
      <button class="topic-tab ${t === state.activeTopic ? 'active' : ''}"
              onclick="selectTopic('${t}')">
        ${lockIcon}${t}${unread}<span class="remove" onclick="event.stopPropagation(); removeTopic('${t}')">×</span>
      </button>
    `})
    .join('');
}

function msgTags(msg) {
  return msg.tags ? msg.tags.split(',').map(t => t.trim()) : [];
}

function renderMessages() {
  const allMsgs = state.messages[state.activeTopic] || [];

  // Todo convention: a message with tags `todo,done` whose body is an existing
  // message id marks that message as complete. We hide the marker itself from
  // the list and only render the original todo with a checked checkbox.
  const doneIds = new Set();
  for (const m of allMsgs) {
    const tags = msgTags(m);
    if (tags.includes('todo') && tags.includes('done')) {
      const ref = (m.message || '').trim();
      if (ref) doneIds.add(ref);
    }
  }

  let msgs = allMsgs.filter(m => {
    const tags = msgTags(m);
    return !(tags.includes('todo') && tags.includes('done'));
  });

  // Extract all unique tags for the current topic to show as quick-filters
  const uniqueTags = Array.from(new Set(
    msgs.flatMap(m => msgTags(m))
  )).sort();

  const filterBanner = state.filterTag 
    ? `<div class="filter-banner">
        <span>Filtering by tag: <strong>${escapeHtml(emojifyTag(state.filterTag))}</strong></span>
        <button class="btn btn-tertiary clear-filter-btn" onclick="clearFilterTag()">Clear Filter</button>
       </div>`    : (uniqueTags.length > 0 ? `
      <div class="tags-row">
        <span class="tags-label">Filter by tag:</span>
        <div class="tags-chips-container">
          ${uniqueTags.map(t => `<span class="tag-chip" onclick="setFilterTag('${escapeHtml(t)}')">${escapeHtml(emojifyTag(t))}</span>`).join('')}
        </div>
      </div>
    ` : '');

  if (state.filterTag) {
    msgs = msgs.filter(msg => {
      if (!msg.tags) return false;
      return msg.tags.split(',').map(t => t.trim()).includes(state.filterTag);
    });
  }

  if (msgs.length === 0) {
    messagesList.innerHTML = filterBanner + `
      <div class="empty-state">
        <svg class="empty-state-icon" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="12" y="24" width="56" height="36" rx="4" stroke="currentColor" stroke-width="2"/>
          <path d="M12 28l28 18 28-18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="62" cy="22" r="8" fill="#7a8b5c" opacity="0.2" stroke="#7a8b5c" stroke-width="2"/>
          <path d="M59 22l2 2 4-4" stroke="#7a8b5c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <p class="empty-state-title">${state.filterTag ? 'No messages with this tag' : 'Listening for messages'}</p>
        <p class="empty-state-hint">${state.filterTag ? 'Try clearing the filter or sending a message with this tag.' : 'Use the compose area below or send one via HTTP:'}</p>
        ${state.filterTag ? '' : `<code class="empty-state-cmd">curl -d "Hello!" ${location.origin}/${state.activeTopic}</code>`}
      </div>
    `;
    return;
  }

  messagesList.innerHTML = filterBanner + msgs
    .map(msg => {
      const time = timeAgo(new Date(msg.created_at * 1000));
      if (msg._locked) {
        return `
        <div class="message-card priority-${msg.priority} locked-message">
          <div class="msg-header">
            <span class="msg-title">🔒 Encrypted message</span>
            <div class="msg-header-right">
              <span class="msg-time" data-time="${msg.created_at}">${time}</span>
            </div>
          </div>
          <div class="msg-body locked-body">Enter the topic passphrase to decrypt this message.</div>
        </div>`;
      }
      const title = msg.title || msg.topic;
      const tagList = msgTags(msg);
      const isTodo = tagList.includes('todo');
      const isDone = isTodo && doneIds.has(msg.id);
      const tags = msg.tags
        ? `<div class="msg-tags">` + msg.tags.split(',').map(t => {
            const raw = t.trim();
            return `<span class="tag-chip" onclick="setFilterTag('${escapeHtml(raw)}')">${escapeHtml(emojifyTag(raw))}</span>`;
          }).join('') + `</div>`
        : '';

      let icon = '';
      if (msg.priority === 5) icon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; vertical-align: text-bottom;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
      else if (msg.priority === 4) icon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; vertical-align: text-bottom;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
      else if (msg.priority === 3) icon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; vertical-align: text-bottom;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;

      const priorityLabel = msg.priority >= 3
        ? `<span class="msg-priority-badge">${icon}P${msg.priority}</span>`
        : '';
      const image = msg.image ? `<div class="msg-image"><img src="${escapeHtml(msg.image)}" alt="" loading="lazy"></div>` : '';

      const copyIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
      const editIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>`;

      const todoCheckbox = isTodo
        ? `<input type="checkbox" class="todo-checkbox" ${isDone ? 'checked' : ''} ${isDone ? 'disabled' : ''} onclick="toggleTodo('${msg.id}', '${msg.topic}', ${isDone})" title="${isDone ? 'Completed' : 'Mark complete'}">`
        : '';

      return `
        <div class="message-card priority-${msg.priority}${isTodo ? ' is-todo' : ''}${isDone ? ' is-done' : ''}">
          <div class="msg-header">
            <span class="msg-title">${todoCheckbox}${escapeHtml(title)}${priorityLabel}</span>
            <div class="msg-header-right">
              <span class="msg-time" data-time="${msg.created_at}">${time}</span>
              <button class="edit-btn" title="Edit message" onclick="editMessage('${msg.id}')">
                ${editIcon}
              </button>
              <button class="copy-btn" title="Copy message" onclick="copyMessage('${msg.id}', this)">
                ${copyIcon}
              </button>
            </div>
          </div>
          <div class="msg-body${isDone ? ' todo-done' : ''}">${msg.markdown ? renderMarkdown(msg.message) : escapeHtml(msg.message)}</div>
          ${image}
          ${tags}
        </div>
      `;
    })
    .join('');
}

window.setFilterTag = (tag) => {
  state.filterTag = tag;
  renderMessages();
};

window.clearFilterTag = () => {
  state.filterTag = null;
  renderMessages();
};

window.toggleTodo = async (id, topic, done) => {
  if (done) return;
  try {
    if (isE2eeTopic(topic)) {
      const key = state.topicKeys[topic];
      if (!key) {
        window.alert('No key loaded for this topic — cannot mark complete.');
        return;
      }
      const meta = state.topicMeta[topic];
      const envelope = await PigeonCrypto.encryptFields(
        key,
        { message: id, tags: 'todo,done' },
        meta.salt,
        meta.iter,
      );
      await fetch(`/${topic}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.pigeon.e2ee+json',
          'X-Encrypted': '1',
        },
        body: envelope,
      });
      return;
    }
    await fetch(`/${topic}`, {
      method: 'POST',
      headers: { 'X-Tags': 'todo,done' },
      body: id,
    });
  } catch (err) {
    console.error('toggleTodo failed:', err);
  }
};

window.editMessage = (id) => {
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

  const composeEl = document.querySelector('.compose');
  if (composeEl) composeEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
};

window.cancelEdit = () => {
  state.editing = null;
  composeTitle.value = '';
  if (composeTags) composeTags.value = '';
  if (composePriority) composePriority.value = '3';
  if (editor) editor.setMarkdown('');
  sendBtn.textContent = 'Send';
  composeEditBanner.hidden = true;
};

// Send message from compose form
const composeTitle = document.getElementById('compose-title');
const composeTags = document.getElementById('compose-tags');
const composePriority = document.getElementById('compose-priority');
const sendBtn = document.getElementById('send-btn');
const composeEditBanner = document.getElementById('compose-edit-banner');

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

async function sendMessage() {
  const body = editor ? editor.getMarkdown().trim() : '';
  if (!body || !state.activeTopic) return;

  const topic = state.activeTopic;
  const title = composeTitle.value.trim();
  const tags = composeTags ? composeTags.value.trim() : '';
  const priority = composePriority ? composePriority.value : '3';

  const editing = state.editing;

  sendBtn.disabled = true;
  try {
    if (isE2eeTopic(topic)) {
      const key = state.topicKeys[topic];
      if (!key) {
        window.alert('No key loaded for this topic — cannot encrypt.');
        return;
      }
      if (editing) {
        await fetch(`/${editing.topic}/messages/${editing.id}`, { method: 'DELETE' });
      }
      const meta = state.topicMeta[topic];
      const fields = { title, message: body, tags, markdown: true };
      const envelope = await PigeonCrypto.encryptFields(key, fields, meta.salt, meta.iter);
      await fetch(`/${topic}`, {
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
        await fetch(`/${editing.topic}/messages/${editing.id}`, { method: 'DELETE' });
      }
      const headers = {};
      if (title) headers['X-Title'] = title;
      if (tags) headers['X-Tags'] = tags;
      headers['X-Markdown'] = '1';
      headers['X-Priority'] = priority;
      await fetch(`/${topic}`, {
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
    }
  } catch (err) {
    console.error('Send failed:', err);
  } finally {
    sendBtn.disabled = false;
  }
}

// Clear messages for active topic
clearMessagesBtn.addEventListener('click', async () => {
  if (!state.activeTopic) return;
  await fetch(`/${state.activeTopic}/messages`, { method: 'DELETE' });
  state.messages[state.activeTopic] = [];
  renderMessages();
});

// Push notification helpers
async function registerPushForTopic(topic, subscription) {
  try {
    await fetch(`/${topic}/push/subscribe`, {
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
  } catch (err) {
    console.error(`Push registration failed for topic ${topic}:`, err);
  }
}

// Push notification setup
enablePushBtn.addEventListener('click', async () => {
  if (state.pushEnabled) return;

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const reg = await navigator.serviceWorker.ready;
    const vapidKeyResponse = await fetch('/vapid-key');
    const vapidKey = await vapidKeyResponse.text();

    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });

    state.pushSubscription = subscription;

    // Register subscription for all current topics
    for (const topic of state.topics) {
      await registerPushForTopic(topic, subscription);
    }

    state.pushEnabled = true;
    enablePushBtn.textContent = 'Push Enabled';
    enablePushBtn.classList.add('enabled');
  } catch (err) {
    console.error('Push subscription failed:', err);
  }
});

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
  // Accept either `tada` or `:tada:`; leave unknown shortcodes alone.
  const key = tag.replace(/^:|:$/g, '');
  return EMOJI_SHORTCODES[key] || tag;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderMarkdown(str) {
  if (typeof marked !== 'undefined') {
    const html = marked.parse(str);
    // Expert UI touch: Inject copy buttons into code blocks
    return html.replace(/<pre><code/g, '<div class="code-wrapper"><button class="code-copy-btn" onclick="copyCode(this)">Copy</button><pre><code').replace(/<\/code><\/pre>/g, '</code></pre></div>');
  }
  
  let html = escapeHtml(str);
  // Code blocks: ```...```
  html = html.replace(/```([\s\S]*?)```/g, '<div class="code-wrapper"><button class="code-copy-btn" onclick="copyCode(this)">Copy</button><pre><code>$1</code></pre></div>');
  // Inline code: `...`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold: **...**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic: _..._ or *...*
  html = html.replace(/\b_(.+?)_\b/g, '<em>$1</em>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Links: [text](url)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  return html;
}

window.copyCode = (btn) => {
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
};

window.copyMessage = (id, btn) => {
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
};

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
        const res = await fetch(`/${topic}/json?since=all`);
        const msgs = await res.json();
        state.messages[topic] = msgs.reverse();
        if (state.activeTopic === topic) renderMessages();
      } catch {}
    }
  }
});

init();

