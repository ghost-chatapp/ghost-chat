import { createHmac } from 'crypto';

if (!process.env.HMAC_SECRET) {
  console.error('FATAL: HMAC_SECRET is not set. Refusing to start.');
  process.exit(1);
}

const secret = process.env.HMAC_SECRET;

export function hmacHash(value) {
  return createHmac('sha256', secret).update(value).digest('hex');
}
