# Ghost Chat v2.0

Anonymous, ephemeral, end-to-end encrypted messaging. No usernames. No email. No server-side message storage.

---

## Features

### Privacy & Anonymity
- **No usernames** — accounts identified only by cryptographic codes
- **Device-only message storage** — server routes messages and immediately discards them. All messages live in IndexedDB on your device only.
- **End-to-end encryption** — TweetNaCl box encryption with ephemeral keypairs per message (forward secrecy)
- **Key fingerprint verification** — compare fingerprints out-of-band to detect MITM attacks
- **Automatic key rotation** — E2E keypairs rotate every 30 days
- **Ghost mode** — appear completely offline while still using the app
- **No CDN dependencies** — no Google Fonts, no external tracking

### Account Security
- **Proof of Work + IP soft limit** — account creation requires browser-solved PoW puzzle; soft limit of 3 per IP per week (hard block at 10)
- **Decoy password** — second password that shows empty fake chat
- **Brute force protection** — account locked after 10 failed attempts
- **Session lock** — auto-locks after 5 minutes of inactivity
- **Panic button (☠)** — one tap wipes ALL local data and disconnects immediately
- **JWT with revocation** — 15-minute access tokens + refresh tokens; logout blacklists tokens
- **Auto-rotate clipboard** — clipboard clears 5 seconds after copying your friend code

### Messaging
- **Message self-destruct** — set timer (30s, 1m, 5m, 1h, 24h) per message
- **Burn on read** — message deletes immediately after being opened (optional)
- **Message recall** — unsend within 10 seconds of sending
- **Voice messages** — encrypted, stored locally on recipient device
- **Typing indicators** — ephemeral, never stored
- **Delivery receipts** — sent → delivered → seen, then auto-cleared

### World Chat
- Anonymous world chat — no identity attached to any message
- 24-hour TTL on all world messages
- Rate limited: 1 message per 3 seconds

### Groups
- HMAC-anonymized member aliases — members see Ghost#abc123, not real codes
- Anonymous mode — no display names at all
- Self-destruct groups — entire group auto-deletes after N days of inactivity
- Max member cap
- Message self-destruct in groups

### Ghost Mascot
- 8 mood states (idle, sleeping, typing, excited, alert, happy, spooked, locked)
- Reacts to app activity in real time
- 4 accessories (hat, crown, glasses, headphones)
- Easter egg: tap 7 times to cycle accessories

---

## Setup

### Prerequisites
- Node.js 18+
- PostgreSQL (Supabase recommended)
- Redis (Upstash recommended)

### Server

```bash
cd server
npm install
cp .env.example .env
# Fill in all env vars — NO fallbacks exist, server will refuse to start with missing vars
node schema.sql  # or paste into Supabase SQL editor
npm run dev
```

### Client

```bash
cd client
npm install
# Create .env.local:
# VITE_API_URL=http://localhost:3000
npm run dev
```

### Production

```bash
cd client && npm run build
# Deploy /dist to Vercel, Netlify, or any static host
# Deploy /server to Railway, Render, Fly.io, etc.
# Set ALLOWED_ORIGIN in server .env to your frontend domain
```

---

## Security Architecture

| Layer | Implementation |
|-------|---------------|
| Transport | HTTPS + WSS |
| Message encryption | NaCl box with ephemeral keypair per message |
| Forward secrecy | New ephemeral keypair for every message |
| Server storage | Zero — messages deleted from Redis immediately after pickup |
| Client storage | IndexedDB only (device-local) |
| Authentication | JWT (15m) + refresh (30d) with Redis blacklist on logout |
| WebSocket auth | JWT verified in Socket.IO middleware |
| Account creation | Proof of Work (SHA-256, difficulty 4) + IP soft limit |
| CORS | Locked to single allowed origin |
| Rate limiting | Per-endpoint HTTP + per-socket token bucket |
| Headers | Helmet with strict CSP, no-referrer, permissions policy |
| HMAC | Required env var — no fallback, server refuses to start |
| Admin | Separate secret, never exposed to client |

---

## What's NOT stored on the server

- Message content (ever, at any point)
- Voice message audio
- Who talked to whom (no conversation metadata)
- Account codes in message responses
- IP addresses (used only for soft rate limiting, not logged)

---

## Limitations

- **If you lose your device or clear browser data, your messages are gone forever.** No cloud backup.
- Voice messages are limited to 2MB (~2 minutes of audio).
- PoW puzzle takes 2-10 seconds on registration depending on device speed.
