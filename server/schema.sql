-- Ghost Chat Database Schema v2.0
-- Run this in your Supabase SQL editor or psql

-- Accounts table
CREATE TABLE IF NOT EXISTS accounts (
  id                  SERIAL PRIMARY KEY,
  account_code        VARCHAR(64) UNIQUE NOT NULL,
  friend_code         VARCHAR(32) UNIQUE NOT NULL,
  password_hash       VARCHAR(128) NOT NULL,
  display_name        VARCHAR(24),
  decoy_password_hash VARCHAR(128),
  public_key          VARCHAR(256),
  is_banned           BOOLEAN DEFAULT FALSE,
  ban_reason          VARCHAR(500),
  key_rotated_at      TIMESTAMP,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accounts_friend_code ON accounts(friend_code);
CREATE INDEX IF NOT EXISTS idx_accounts_account_code ON accounts(account_code);

-- Friends table
CREATE TABLE IF NOT EXISTS friends (
  id              SERIAL PRIMARY KEY,
  account_code_1  VARCHAR(64) NOT NULL REFERENCES accounts(account_code) ON DELETE CASCADE,
  account_code_2  VARCHAR(64) NOT NULL REFERENCES accounts(account_code) ON DELETE CASCADE,
  status          VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(account_code_1, account_code_2)
);

-- Blocks table
CREATE TABLE IF NOT EXISTS blocks (
  id          SERIAL PRIMARY KEY,
  blocker     VARCHAR(64) NOT NULL REFERENCES accounts(account_code) ON DELETE CASCADE,
  blocked     VARCHAR(64) NOT NULL REFERENCES accounts(account_code) ON DELETE CASCADE,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(blocker, blocked)
);

-- World messages (public, ephemeral)
CREATE TABLE IF NOT EXISTS world_messages (
  id           SERIAL PRIMARY KEY,
  account_code VARCHAR(64) NOT NULL REFERENCES accounts(account_code) ON DELETE CASCADE,
  content      VARCHAR(500) NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_world_messages_created ON world_messages(created_at);

-- Groups
CREATE TABLE IF NOT EXISTS groups (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(50) NOT NULL,
  invite_code         VARCHAR(32) UNIQUE NOT NULL,
  creator_code        VARCHAR(64) REFERENCES accounts(account_code) ON DELETE SET NULL,
  anonymous_mode      BOOLEAN DEFAULT FALSE,
  self_destruct_days  INTEGER,
  max_members         INTEGER DEFAULT 50,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMP
);

-- Group members
CREATE TABLE IF NOT EXISTS group_members (
  id            SERIAL PRIMARY KEY,
  group_id      INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  account_code  VARCHAR(64) NOT NULL REFERENCES accounts(account_code) ON DELETE CASCADE,
  member_alias  VARCHAR(16) NOT NULL,  -- HMAC-derived, anonymous
  joined_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(group_id, account_code)
);

-- Group messages (with self-destruct support)
CREATE TABLE IF NOT EXISTS group_messages (
  id               SERIAL PRIMARY KEY,
  group_id         INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  sender_code      VARCHAR(64) NOT NULL REFERENCES accounts(account_code) ON DELETE CASCADE,
  content          VARCHAR(2000) NOT NULL,
  self_destruct_at TIMESTAMP,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_group_messages_destruct ON group_messages(self_destruct_at) WHERE self_destruct_at IS NOT NULL;

-- Reports
CREATE TABLE IF NOT EXISTS reports (
  id            SERIAL PRIMARY KEY,
  reporter_code VARCHAR(64) REFERENCES accounts(account_code) ON DELETE SET NULL,
  target_id     INTEGER NOT NULL,
  target_type   VARCHAR(32) NOT NULL,
  reason        VARCHAR(500),
  resolved      BOOLEAN DEFAULT FALSE,
  resolved_at   TIMESTAMP,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
-- Migration: add display_name if upgrading from old schema
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS display_name VARCHAR(24);
