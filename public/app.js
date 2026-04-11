const state = {
  topics: JSON.parse(localStorage.getItem('pigeon_topics') || '[]'),
  activeTopic: null,
  messages: {},       // topic -> Message[]
  eventSources: {},   // topic -> { ws, heartbeatId }
  pushEnabled: false,
  pushSubscription: null,
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
      for (const msg of earlyMessages) {
        if (!state.messages[topic].some(m => m.id === msg.id)) {
          state.messages[topic].unshift(msg);
        }
      }
      historyLoaded = true;
      if (state.activeTopic === topic) renderMessages();
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
      if (state.activeTopic === topic) renderMessages();
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
    .map(t => `
      <button class="topic-tab ${t === state.activeTopic ? 'active' : ''}"
              onclick="selectTopic('${t}')">
        ${t}<span class="remove" onclick="event.stopPropagation(); removeTopic('${t}')">×</span>
      </button>
    `)
    .join('');
}

function renderMessages() {
  const msgs = state.messages[state.activeTopic] || [];
  if (msgs.length === 0) {
    messagesList.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:2rem">No messages yet. Send one with curl!</p>';
    return;
  }

  messagesList.innerHTML = msgs
    .map(msg => {
      const time = new Date(msg.created_at * 1000).toLocaleTimeString();
      const title = msg.title || msg.topic;
      const tags = msg.tags ? `<div class="msg-tags">${msg.tags}</div>` : '';
      return `
        <div class="message-card priority-${msg.priority}">
          <div class="msg-header">
            <span class="msg-title">${escapeHtml(title)}</span>
            <span class="msg-time">${time}</span>
          </div>
          <div class="msg-body">${msg.markdown ? renderMarkdown(msg.message) : escapeHtml(msg.message)}</div>
          ${tags}
        </div>
      `;
    })
    .join('');
}

// Send message from compose form
const composeTitle = document.getElementById('compose-title');
const composeMessage = document.getElementById('compose-message');
const sendBtn = document.getElementById('send-btn');

sendBtn.addEventListener('click', sendMessage);
composeMessage.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

async function sendMessage() {
  const body = composeMessage.value.trim();
  if (!body || !state.activeTopic) return;

  const headers = {};
  const title = composeTitle.value.trim();
  if (title) headers['X-Title'] = title;

  sendBtn.disabled = true;
  try {
    await fetch(`/${state.activeTopic}`, {
      method: 'POST',
      headers,
      body,
    });
    composeMessage.value = '';
    composeTitle.value = '';
  } catch (err) {
    console.error('Send failed:', err);
  } finally {
    sendBtn.disabled = false;
  }
}

// Clear messages for active topic
clearMessagesBtn.addEventListener('click', () => {
  if (state.activeTopic) {
    state.messages[state.activeTopic] = [];
    renderMessages();
  }
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
  let html = escapeHtml(str);
  // Code blocks: ```...```
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
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
