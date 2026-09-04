// IndexedDB key store shared between page (app.js) and Service Worker (sw.js).
//
// Storing the passphrase in IDB is the same trust level as localStorage — it's
// at rest on disk, decryptable by anyone with device access. We use IDB
// (not localStorage) because Service Workers cannot read localStorage but can
// read IndexedDB.
//
// Stores:
//   topic_keys      { topic (key), passphrase, salt, iter, e2ee: true }
//   topic_messages  { topic (key), messages, updatedAt }
//   meta            { key (key), value } — vapid_key, push_registrations, unread_sum
//   topic_muted     { topic (key), muted, mutedAt } — per-topic mute from the shade
//   pending_unsubs  auto-increment { topic, endpoint } — SW queued deletes

(function (root) {
  const DB_NAME = 'pigeon';
  const DB_VERSION = 4;
  const STORE_KEYS = 'topic_keys';
  const STORE_MESSAGES = 'topic_messages';
  const STORE_META = 'meta';
  const STORE_MUTED = 'topic_muted';
  const STORE_PENDING = 'pending_unsubs';

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_KEYS)) {
          db.createObjectStore(STORE_KEYS, { keyPath: 'topic' });
        }
        if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
          db.createObjectStore(STORE_MESSAGES, { keyPath: 'topic' });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_MUTED)) {
          db.createObjectStore(STORE_MUTED, { keyPath: 'topic' });
        }
        if (!db.objectStoreNames.contains(STORE_PENDING)) {
          db.createObjectStore(STORE_PENDING, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function txPromise(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function putTopicKey(topic, record) {
    const db = await open();
    const tx = db.transaction(STORE_KEYS, 'readwrite');
    tx.objectStore(STORE_KEYS).put({ topic, ...record });
    await txPromise(tx);
    db.close();
  }

  async function getTopicKey(topic) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KEYS, 'readonly');
      const req = tx.objectStore(STORE_KEYS).get(topic);
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }

  async function deleteTopicKey(topic) {
    const db = await open();
    const tx = db.transaction(STORE_KEYS, 'readwrite');
    tx.objectStore(STORE_KEYS).delete(topic);
    await txPromise(tx);
    db.close();
  }

  async function putTopicMessages(topic, messages) {
    const db = await open();
    const tx = db.transaction(STORE_MESSAGES, 'readwrite');
    tx.objectStore(STORE_MESSAGES).put({ topic, messages, updatedAt: Date.now() });
    await txPromise(tx);
    db.close();
  }

  async function getTopicMessages(topic) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readonly');
      const req = tx.objectStore(STORE_MESSAGES).get(topic);
      req.onsuccess = () => { db.close(); resolve(req.result ? req.result.messages : null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }

  async function deleteTopicMessages(topic) {
    const db = await open();
    const tx = db.transaction(STORE_MESSAGES, 'readwrite');
    tx.objectStore(STORE_MESSAGES).delete(topic);
    await txPromise(tx);
    db.close();
  }

  async function setMeta(key, value) {
    const db = await open();
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put({ key, value });
    await txPromise(tx);
    db.close();
  }

  async function getMeta(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const req = tx.objectStore(STORE_META).get(key);
      req.onsuccess = () => { db.close(); resolve(req.result ? req.result.value : null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }

  async function deleteMeta(key) {
    const db = await open();
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).delete(key);
    await txPromise(tx);
    db.close();
  }

  // Per-topic mute, set from the notification shade ("Mute topic"). Lives in
  // IDB so the Service Worker (which cannot read localStorage) can write it and
  // the page can read it back. #35 can adopt this as its in-PWA mute store.
  async function setTopicMuted(topic) {
    const db = await open();
    const tx = db.transaction(STORE_MUTED, 'readwrite');
    tx.objectStore(STORE_MUTED).put({ topic, muted: true, mutedAt: Date.now() });
    await txPromise(tx);
    db.close();
  }

  async function isTopicMuted(topic) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MUTED, 'readonly');
      const req = tx.objectStore(STORE_MUTED).get(topic);
      req.onsuccess = () => { db.close(); resolve(!!(req.result && req.result.muted)); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }

  async function getMutedTopics() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MUTED, 'readonly');
      const req = tx.objectStore(STORE_MUTED).getAll();
      req.onsuccess = () => { db.close(); resolve(req.result || []); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }

  async function clearTopicMuted(topic) {
    const db = await open();
    const tx = db.transaction(STORE_MUTED, 'readwrite');
    tx.objectStore(STORE_MUTED).delete(topic);
    await txPromise(tx);
    db.close();
  }

  // Unsubscribes the SW couldn't send (offline mute/teardown). The page drains
  // these into its own durable retry queue on load and on 'online'.
  async function addPendingUnsub(entry) {
    const db = await open();
    const tx = db.transaction(STORE_PENDING, 'readwrite');
    tx.objectStore(STORE_PENDING).add({ topic: entry.topic || null, endpoint: entry.endpoint });
    await txPromise(tx);
    db.close();
  }

  async function getPendingUnsubs() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PENDING, 'readonly');
      const req = tx.objectStore(STORE_PENDING).getAll();
      req.onsuccess = () => { db.close(); resolve(req.result || []); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }

  async function clearPendingUnsubs() {
    const db = await open();
    const tx = db.transaction(STORE_PENDING, 'readwrite');
    tx.objectStore(STORE_PENDING).clear();
    await txPromise(tx);
    db.close();
  }

  root.PigeonKeystore = {
    putTopicKey, getTopicKey, deleteTopicKey,
    putTopicMessages, getTopicMessages, deleteTopicMessages,
    setMeta, getMeta, deleteMeta,
    setTopicMuted, isTopicMuted, getMutedTopics, clearTopicMuted,
    addPendingUnsub, getPendingUnsubs, clearPendingUnsubs,
  };
})(typeof self !== 'undefined' ? self : window);
