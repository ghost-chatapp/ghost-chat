import { openDB } from 'idb';

const DB_NAME = 'ghostchat';
const DB_VERSION = 1;

let _db = null;

async function getDB() {
  if (_db) return _db;

  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // Messages store
      if (!db.objectStoreNames.contains('messages')) {
        const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
        msgStore.createIndex('conversation', 'conversationId');
        msgStore.createIndex('ts', 'ts');
        msgStore.createIndex('selfDestructAt', 'selfDestructAt');
      }

      // Voice messages store
      if (!db.objectStoreNames.contains('voice')) {
        const voiceStore = db.createObjectStore('voice', { keyPath: 'id' });
        voiceStore.createIndex('conversation', 'conversationId');
      }

      // Contacts/friends store
      if (!db.objectStoreNames.contains('contacts')) {
        db.createObjectStore('contacts', { keyPath: 'accountCode' });
      }

      // Key store (encrypted keypair)
      if (!db.objectStoreNames.contains('keys')) {
        db.createObjectStore('keys', { keyPath: 'id' });
      }

      // Settings store
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }

      // Login history (own account only)
      if (!db.objectStoreNames.contains('loginHistory')) {
        const lhStore = db.createObjectStore('loginHistory', { keyPath: 'id', autoIncrement: true });
        lhStore.createIndex('ts', 'ts');
      }
    },
  });

  return _db;
}

// ── Messages ──────────────────────────────────────────────────────────────────

export async function saveMessage(message) {
  const db = await getDB();
  await db.put('messages', {
    ...message,
    stored: Date.now(),
  });
}

export async function getMessages(conversationId, limit = 100) {
  const db = await getDB();
  const tx = db.transaction('messages', 'readonly');
  const index = tx.store.index('conversation');
  const all = await index.getAll(conversationId);
  return all
    .filter(m => !m.selfDestructAt || m.selfDestructAt > Date.now())
    .sort((a, b) => a.ts - b.ts)
    .slice(-limit);
}

export async function deleteMessage(id) {
  const db = await getDB();
  await db.delete('messages', id);
}

export async function recallMessage(id) {
  await deleteMessage(id);
}

// Purge all expired self-destruct messages
export async function purgeExpiredMessages() {
  const db = await getDB();
  const all = await db.getAll('messages');
  const now = Date.now();
  const expired = all.filter(m => m.selfDestructAt && m.selfDestructAt <= now);

  const tx = db.transaction('messages', 'readwrite');
  for (const m of expired) {
    await tx.store.delete(m.id);
  }
  await tx.done;

  return expired.length;
}

// Mark message as seen (for self-destruct-on-read)
export async function markMessageSeen(id) {
  const db = await getDB();
  const msg = await db.get('messages', id);
  if (!msg) return;

  if (msg.burnOnRead) {
    await db.delete('messages', id);
    return { deleted: true };
  }

  await db.put('messages', { ...msg, seen: true, seenAt: Date.now() });
  return { seen: true };
}

// ── Voice messages ────────────────────────────────────────────────────────────

export async function saveVoiceMessage(voiceMsg) {
  const db = await getDB();
  await db.put('voice', voiceMsg);
}

export async function getVoiceMessages(conversationId) {
  const db = await getDB();
  const index = (await getDB()).transaction('voice').store.index('conversation');
  return index.getAll(conversationId);
}

export async function deleteVoiceMessage(id) {
  const db = await getDB();
  await db.delete('voice', id);
}

// ── Contacts ──────────────────────────────────────────────────────────────────

export async function saveContact(contact) {
  const db = await getDB();
  await db.put('contacts', contact);
}

export async function getContacts() {
  const db = await getDB();
  return db.getAll('contacts');
}

export async function getContact(accountCode) {
  const db = await getDB();
  return db.get('contacts', accountCode);
}

export async function deleteContact(accountCode) {
  const db = await getDB();
  await db.delete('contacts', accountCode);
}

// ── Keys ──────────────────────────────────────────────────────────────────────

export async function saveKeys(keys) {
  const db = await getDB();
  await db.put('keys', { id: 'main', ...keys, savedAt: Date.now() });
}

export async function getKeys() {
  const db = await getDB();
  return db.get('keys', 'main');
}

// ── Settings ──────────────────────────────────────────────────────────────────

export async function getSetting(key, defaultValue = null) {
  const db = await getDB();
  const entry = await db.get('settings', key);
  return entry ? entry.value : defaultValue;
}

export async function setSetting(key, value) {
  const db = await getDB();
  await db.put('settings', { key, value });
}

// ── Login history ─────────────────────────────────────────────────────────────

export async function logLogin() {
  const db = await getDB();
  await db.add('loginHistory', {
    ts: Date.now(),
    userAgent: navigator.userAgent,
  });

  // Keep last 20 logins only
  const all = await db.getAllFromIndex('loginHistory', 'ts');
  if (all.length > 20) {
    const toDelete = all.slice(0, all.length - 20);
    const tx = db.transaction('loginHistory', 'readwrite');
    for (const entry of toDelete) await tx.store.delete(entry.id);
    await tx.done;
  }
}

export async function getLoginHistory() {
  const db = await getDB();
  const all = await db.getAllFromIndex('loginHistory', 'ts');
  return all.reverse();
}

// ── Panic wipe ────────────────────────────────────────────────────────────────

export async function panicWipe() {
  _db?.close();
  _db = null;
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = resolve;
    req.onerror = reject;
    req.onblocked = resolve;
  });
}
