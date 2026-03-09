import { createHash, randomBytes } from 'crypto';

const POW_DIFFICULTY = 4; // number of leading zeros required in hex hash
const POW_CHALLENGE_TTL = 300; // 5 minutes

/**
 * Generate a PoW challenge
 */
export function generateChallenge() {
  const challenge = randomBytes(16).toString('hex');
  const timestamp = Date.now();
  return { challenge, timestamp, difficulty: POW_DIFFICULTY };
}

/**
 * Verify a PoW solution
 * The client must find a nonce such that SHA256(challenge + nonce) starts with POW_DIFFICULTY zeros
 */
export function verifyPoW(challenge, nonce, timestamp) {
  // Check challenge isn't expired
  if (Date.now() - timestamp > POW_CHALLENGE_TTL * 1000) {
    return { valid: false, reason: 'Challenge expired' };
  }

  // Verify the hash
  const hash = createHash('sha256')
    .update(challenge + String(nonce))
    .digest('hex');

  const required = '0'.repeat(POW_DIFFICULTY);
  if (!hash.startsWith(required)) {
    return { valid: false, reason: 'Invalid proof of work' };
  }

  return { valid: true, hash };
}

/**
 * Client-side PoW solver (for reference / testing)
 * In production this runs in the browser via Web Worker
 */
export function solvePoW(challenge, difficulty = POW_DIFFICULTY) {
  const required = '0'.repeat(difficulty);
  let nonce = 0;
  while (true) {
    const hash = createHash('sha256')
      .update(challenge + String(nonce))
      .digest('hex');
    if (hash.startsWith(required)) {
      return { nonce, hash };
    }
    nonce++;
  }
}
