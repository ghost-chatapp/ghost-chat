import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';

const KEY_ROTATION_INTERVAL = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Keypair management ────────────────────────────────────────────────────────

export function generateKeyPair() {
  return nacl.box.keyPair();
}

export function exportKeyPair(keyPair) {
  return {
    publicKey: encodeBase64(keyPair.publicKey),
    secretKey: encodeBase64(keyPair.secretKey),
  };
}

export function importKeyPair(exported) {
  return {
    publicKey: decodeBase64(exported.publicKey),
    secretKey: decodeBase64(exported.secretKey),
  };
}

// ── Encryption ────────────────────────────────────────────────────────────────

/**
 * Encrypt a message with forward secrecy using ephemeral keypair.
 * Recipient can decrypt using their secret key + ephemeral public key.
 */
export function encryptMessage(message, recipientPublicKeyB64, senderSecretKey) {
  const recipientPublicKey = decodeBase64(recipientPublicKeyB64);
  const nonce = nacl.randomBytes(nacl.box.nonceLength);

  // Generate ephemeral keypair for forward secrecy
  const ephemeral = nacl.box.keyPair();

  const messageBytes = encodeUTF8(typeof message === 'string' ? message : JSON.stringify(message));

  const encrypted = nacl.box(
    messageBytes,
    nonce,
    recipientPublicKey,
    ephemeral.secretKey
  );

  return encodeBase64(JSON.stringify({
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(encrypted),
    ephemeralPublicKey: encodeBase64(ephemeral.publicKey),
  }));
}

/**
 * Decrypt a message
 */
export function decryptMessage(encryptedB64, recipientSecretKey) {
  try {
    const decoded = JSON.parse(decodeUTF8(decodeBase64(encryptedB64)));
    const nonce = decodeBase64(decoded.nonce);
    const ciphertext = decodeBase64(decoded.ciphertext);
    const ephemeralPublicKey = decodeBase64(decoded.ephemeralPublicKey);

    const decrypted = nacl.box.open(
      ciphertext,
      nonce,
      ephemeralPublicKey,
      recipientSecretKey
    );

    if (!decrypted) return null;

    const text = decodeUTF8(decrypted);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

/**
 * Encrypt binary data (for voice messages)
 */
export function encryptBinary(data, recipientPublicKeyB64) {
  const recipientPublicKey = decodeBase64(recipientPublicKeyB64);
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ephemeral = nacl.box.keyPair();

  const encrypted = nacl.box(data, nonce, recipientPublicKey, ephemeral.secretKey);

  return {
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(encrypted),
    ephemeralPublicKey: encodeBase64(ephemeral.publicKey),
  };
}

export function decryptBinary(envelope, recipientSecretKey) {
  try {
    const nonce = decodeBase64(envelope.nonce);
    const ciphertext = decodeBase64(envelope.ciphertext);
    const ephemeralPublicKey = decodeBase64(envelope.ephemeralPublicKey);

    return nacl.box.open(ciphertext, nonce, ephemeralPublicKey, recipientSecretKey);
  } catch {
    return null;
  }
}

// ── Key fingerprint ───────────────────────────────────────────────────────────

export async function getKeyFingerprint(publicKeyB64) {
  const keyBytes = decodeBase64(publicKeyB64);
  const hashBuffer = await crypto.subtle.digest('SHA-256', keyBytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join(':');
}

// ── Key rotation check ────────────────────────────────────────────────────────

export function shouldRotateKeys(lastRotatedAt) {
  if (!lastRotatedAt) return true;
  return Date.now() - new Date(lastRotatedAt).getTime() > KEY_ROTATION_INTERVAL;
}

// ── Proof of Work (client solver) ─────────────────────────────────────────────
// Runs in a Web Worker to avoid blocking UI

export function createPoWSolverCode() {
  return `
    self.onmessage = function(e) {
      const { challenge, difficulty } = e.data;
      const required = '0'.repeat(difficulty);
      let nonce = 0;
      
      async function solve() {
        while (true) {
          const data = new TextEncoder().encode(challenge + String(nonce));
          const hashBuffer = await crypto.subtle.digest('SHA-256', data);
          const hashArray = Array.from(new Uint8Array(hashBuffer));
          const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
          
          if (hash.startsWith(required)) {
            self.postMessage({ nonce, hash });
            return;
          }
          nonce++;
          
          // Yield every 1000 iterations to not lock up
          if (nonce % 1000 === 0) {
            await new Promise(r => setTimeout(r, 0));
          }
        }
      }
      
      solve();
    };
  `;
}

export async function solvePoW(challenge, difficulty) {
  return new Promise((resolve) => {
    const blob = new Blob([createPoWSolverCode()], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    const worker = new Worker(workerUrl);

    worker.onmessage = (e) => {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      resolve(e.data);
    };

    worker.postMessage({ challenge, difficulty });
  });
}
