const state = {
  topics: JSON.parse(localStorage.getItem('pigeon_topics') || '[]'),
  activeTopic: null,
  messages: {},       // topic -> Message[]
  eventSources: {},   // topic -> { ws, heartbeatId }
  unreadCounts: {},
  pushEnabled: false,
  pushSubscription: null,
  filterTag: null,
};

// DOM elements
const topicInput = document.getElementById('topic-input');
const subscribeBtn = document.getElementById('subscribe-btn');
const topicsSection = document.getElementById('topics-section');
const topicTabs = document.getElementById('topic-tabs');
const messagesSection = document.getElementById('messages-section');
const messagesList = document.getElementById('messages-list');
const enablePushBtn = document.getElementById('enable-push-btn');
const clearMessagesBtn = document.getElementById('clear-messages-btn');

// Initialize
async function init() {
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

  state.topics.forEach(topic => connectTopic(topic));
  renderTopicTabs();

  if (state.topics.length > 0) {
    selectTopic(state.topics[0]);
  }
}

// Subscribe to a topic
subscribeBtn.addEventListener('click', () => {
  const topic = topicInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!topic || state.topics.includes(topic)) return;

  state.topics.push(topic);
  state.messages[topic] = [];
  localStorage.setItem('pigeon_topics', JSON.stringify(state.topics));

  connectTopic(topic);
  if (state.pushEnabled && state.pushSubscription) {
    registerPushForTopic(topic, state.pushSubscription);
  }
  selectTopic(topic);
  renderTopicTabs();

  topicInput.value = '';
});

topicInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') subscribeBtn.click();
});

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
      state.messages[topic] = msgs.reverse();
      // Merge any messages that arrived via WS while fetching history
      let newEarly = 0;
      for (const msg of earlyMessages) {
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

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
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
  renderTopicTabs();
  renderMessages();
}

function removeTopic(topic) {
  disconnectTopic(topic);
  state.topics = state.topics.filter(t => t !== topic);
  localStorage.setItem('pigeon_topics', JSON.stringify(state.topics));

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
      return `
      <button class="topic-tab ${t === state.activeTopic ? 'active' : ''}"
              onclick="selectTopic('${t}')">
        ${t}${unread}<span class="remove" onclick="event.stopPropagation(); removeTopic('${t}')">×</span>
      </button>
    `})
    .join('');
}

function renderMessages() {
  const allMsgs = state.messages[state.activeTopic] || [];
  let msgs = [...allMsgs];
  
  // Extract all unique tags for the current topic to show as quick-filters
  const uniqueTags = Array.from(new Set(
    allMsgs.flatMap(m => m.tags ? m.tags.split(',').map(t => t.trim()) : [])
  )).sort();

  const filterBanner = state.filterTag 
    ? `<div class="filter-banner">
        <span>Filtering by tag: <strong>${escapeHtml(state.filterTag)}</strong></span>
        <button class="clear-filter-btn" onclick="clearFilterTag()">Clear Filter</button>
       </div>`
    : (uniqueTags.length > 0 ? `
      <div class="tags-row">
        <span class="tags-label">Filter by tag:</span>
        <div class="tags-chips-container">
          ${uniqueTags.map(t => `<span class="tag-chip" onclick="setFilterTag('${escapeHtml(t)}')">${escapeHtml(t)}</span>`).join('')}
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
      const title = msg.title || msg.topic;
      const tags = msg.tags 
        ? `<div class="msg-tags">` + msg.tags.split(',').map(t => `<span class="tag-chip" onclick="setFilterTag('${escapeHtml(t.trim())}')">${escapeHtml(t.trim())}</span>`).join('') + `</div>`
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

      return `
        <div class="message-card priority-${msg.priority}">
          <div class="msg-header">
            <span class="msg-title">${escapeHtml(title)}${priorityLabel}</span>
            <div class="msg-header-right">
              <span class="msg-time">${time}</span>
              <button class="copy-btn" title="Copy message" onclick="copyMessage('${msg.id}', this)">
                ${copyIcon}
              </button>
            </div>
          </div>
          <div class="msg-body">${msg.markdown ? renderMarkdown(msg.message) : escapeHtml(msg.message)}</div>
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

// Send message from compose form
const composeTitle = document.getElementById('compose-title');
const composeTags = document.getElementById('compose-tags');
const composePriority = document.getElementById('compose-priority');
const sendBtn = document.getElementById('send-btn');

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

  const headers = {};
  const title = composeTitle.value.trim();
  if (title) headers['X-Title'] = title;
  const tags = composeTags ? composeTags.value.trim() : '';
  if (tags) headers['X-Tags'] = tags;
  headers['X-Markdown'] = '1';
  if (composePriority) headers['X-Priority'] = composePriority.value;

  sendBtn.disabled = true;
  try {
    await fetch(`/${state.activeTopic}`, {
      method: 'POST',
      headers,
      body,
    });
    if (editor) editor.setMarkdown('');
    composeTitle.value = '';
    if (composeTags) composeTags.value = '';
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
    btn.innerText = 'Copied!';
    setTimeout(() => btn.innerText = original, 2000);
  });
};

window.copyMessage = (id, btn) => {
  const msgs = state.messages[state.activeTopic] || [];
  const msg = msgs.find(m => m.id === id);
  if (!msg) return;
  
  navigator.clipboard.writeText(msg.message).then(() => {
    const original = btn.innerHTML;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    setTimeout(() => btn.innerHTML = original, 2000);
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
  if (state.activeTopic) renderMessages();
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

