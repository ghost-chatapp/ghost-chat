const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

let accessToken = null;
let refreshTokenValue = null;
let refreshPromise = null;

export function setTokens(access, refresh) {
  accessToken = access;
  refreshTokenValue = refresh;
}

export function clearTokens() {
  accessToken = null;
  refreshTokenValue = null;
}

async function refreshAccessToken() {
  if (!refreshTokenValue) throw new Error('No refresh token');

  if (refreshPromise) return refreshPromise;

  refreshPromise = fetch(`${BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: refreshTokenValue }),
  }).then(async (res) => {
    refreshPromise = null;
    if (!res.ok) throw new Error('Refresh failed');
    const data = await res.json();
    accessToken = data.accessToken;
    return accessToken;
  }).catch((err) => {
    refreshPromise = null;
    clearTokens();
    window.dispatchEvent(new CustomEvent('auth:logout'));
    throw err;
  });

  return refreshPromise;
}

async function request(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  let res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  // Auto-refresh on 401
  if (res.status === 401 && refreshTokenValue) {
    try {
      await refreshAccessToken();
      headers['Authorization'] = `Bearer ${accessToken}`;
      res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
    } catch {
      throw new Error('Session expired');
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function getPoWChallenge() {
  return request('/auth/pow-challenge');
}

export async function register(password, powChallenge, powNonce, powTimestamp) {
  return request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ password, powChallenge, powNonce, powTimestamp }),
  });
}

export async function login(accountCode, password) {
  return request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ accountCode, password }),
  });
}

export async function logout() {
  return request('/auth/logout', { method: 'POST' });
}

export async function setPublicKey(publicKey) {
  return request('/auth/set-public-key', {
    method: 'POST',
    body: JSON.stringify({ publicKey }),
  });
}

export async function getPublicKey(accountCode) {
  return request(`/auth/public-key/${accountCode}`);
}

export async function rotateKeys(newPublicKey) {
  return request('/auth/rotate-keys', {
    method: 'POST',
    body: JSON.stringify({ newPublicKey }),
  });
}

export async function setDecoyPassword(decoyPassword) {
  return request('/auth/set-decoy-password', {
    method: 'POST',
    body: JSON.stringify({ decoyPassword }),
  });
}

// ── Messages ──────────────────────────────────────────────────────────────────

export async function sendMessage(recipientCode, encryptedPayload, selfDestructSeconds) {
  return request('/messages/send', {
    method: 'POST',
    body: JSON.stringify({ recipientCode, encryptedPayload, selfDestructSeconds }),
  });
}

export async function drainInbox() {
  return request('/messages/inbox');
}

export async function sendVoiceMessage(recipientCode, encryptedAudio, duration) {
  return request('/messages/voice', {
    method: 'POST',
    body: JSON.stringify({ recipientCode, encryptedAudio, duration }),
  });
}

export async function recallMessage(messageId, recipientCode) {
  return request('/messages/recall', {
    method: 'POST',
    body: JSON.stringify({ messageId, recipientCode }),
  });
}

// ── Friends ───────────────────────────────────────────────────────────────────

export async function getFriends() {
  return request('/friends');
}

export async function addFriend(friendCode) {
  return request('/friends/add', {
    method: 'POST',
    body: JSON.stringify({ friendCode }),
  });
}

export async function acceptFriend(requesterCode) {
  return request('/friends/accept', {
    method: 'POST',
    body: JSON.stringify({ requesterCode }),
  });
}

export async function removeFriend(friendCode) {
  return request(`/friends/${friendCode}`, { method: 'DELETE' });
}

export async function blockUser(targetCode) {
  return request('/friends/block', {
    method: 'POST',
    body: JSON.stringify({ targetCode }),
  });
}

export async function getPendingRequests() {
  return request('/friends/pending');
}

// ── World ─────────────────────────────────────────────────────────────────────

export async function getWorldMessages() {
  return request('/world');
}

export async function sendWorldMessage(content) {
  return request('/world', {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

// ── Clipboard auto-clear ──────────────────────────────────────────────────────

export function copyWithAutoClear(text, delayMs = 5000) {
  navigator.clipboard.writeText(text).then(() => {
    setTimeout(() => {
      navigator.clipboard.writeText('').catch(() => {});
    }, delayMs);
  });
}
