-- ─────────────────────────────────────────────────────────────────────────────
--  SocialMitr — Full Schema v2 (paste into Supabase SQL Editor and Run)
-- ─────────────────────────────────────────────────────────────────────────────

-- USERS
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  password_hash text not null,
  type          text not null check(type in ('creator','business')),
  created_at    timestamptz default now()
);

-- CREATORS
create table if not exists creators (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid unique references users(id) on delete cascade,
  name            text not null,
  city            text not null,
  primary_skill   text not null,
  niche           text not null,
  rate            text not null,
  bio             text default '',
  portfolio_url   text default '',
  instagram       text default '',
  avatar_initials text default '',
  avatar_color    text default '#ff6b2b',
  rating          numeric default 0,
  total_reviews   int default 0,
  total_earned    numeric default 0,
  completed_jobs  int default 0
);

-- BUSINESSES
create table if not exists businesses (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid unique references users(id) on delete cascade,
  business_name text not null,
  owner_name    text not null,
  business_type text not null,
  city          text not null,
  budget        text not null
);

-- JOBS
create table if not exists jobs (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references businesses(id) on delete cascade,
  title         text not null,
  description   text not null,
  requirements  text default '',
  deliverables  text default '',
  budget        text not null,
  timeline      text not null,
  skills_needed text default '',
  niche         text not null,
  status        text default 'open' check(status in ('open','closed','in_progress','completed')),
  created_at    timestamptz default now()
);

-- APPLICATIONS
create table if not exists applications (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid references jobs(id) on delete cascade,
  creator_id   uuid references creators(id) on delete cascade,
  cover_letter text default '',
  status       text default 'pending' check(status in ('pending','accepted','rejected')),
  created_at   timestamptz default now(),
  unique(job_id, creator_id)
);

-- CONTRACTS (created when application is accepted)
create table if not exists contracts (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid references jobs(id) on delete cascade,
  creator_id      uuid references creators(id) on delete cascade,
  business_id     uuid references businesses(id) on delete cascade,
  application_id  uuid references applications(id),
  agreed_amount   numeric not null default 0,
  status          text default 'active' check(status in ('active','completed','disputed','cancelled')),
  creator_done    boolean default false,
  business_done   boolean default false,
  created_at      timestamptz default now(),
  completed_at    timestamptz
);

-- CHAT ROOMS (one per contract)
create table if not exists chat_rooms (
  id          uuid primary key default gen_random_uuid(),
  contract_id uuid unique references contracts(id) on delete cascade,
  created_at  timestamptz default now()
);

-- CHAT MESSAGES
create table if not exists chat_messages (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid references chat_rooms(id) on delete cascade,
  sender_id   uuid references users(id) on delete cascade,
  message     text not null,
  read        boolean default false,
  created_at  timestamptz default now()
);

-- PAYMENTS
create table if not exists payments (
  id           uuid primary key default gen_random_uuid(),
  contract_id  uuid references contracts(id) on delete cascade,
  amount       numeric not null,
  status       text default 'pending' check(status in ('pending','requested','released','disputed')),
  requested_at timestamptz,
  released_at  timestamptz,
  note         text default '',
  created_at   timestamptz default now()
);

-- REVIEWS
create table if not exists reviews (
  id          uuid primary key default gen_random_uuid(),
  contract_id uuid unique references contracts(id),
  creator_id  uuid references creators(id),
  business_id uuid references businesses(id),
  rating      int check(rating between 1 and 5),
  comment     text default '',
  created_at  timestamptz default now()
);

-- SAVED JOBS
create table if not exists saved_jobs (
  id         uuid primary key default gen_random_uuid(),
  creator_id uuid references creators(id) on delete cascade,
  job_id     uuid references jobs(id) on delete cascade,
  created_at timestamptz default now(),
  unique(creator_id, job_id)
);

-- NOTIFICATIONS
create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references users(id) on delete cascade,
  title      text not null,
  message    text not null,
  type       text default 'info',
  read       boolean default false,
  link       text default '',
  created_at timestamptz default now()
);

select 'SocialMitr schema v2 created successfully ✅' as result;

-- ─── RAZORPAY PAYMENT COLUMNS (run this in Supabase SQL editor) ──────────────
ALTER TABLE payments ADD COLUMN IF NOT EXISTS razorpay_order_id   TEXT DEFAULT '';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT DEFAULT '';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS razorpay_signature  TEXT DEFAULT '';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS creator_amount      NUMERIC DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS platform_fee        NUMERIC DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS transfer_id         TEXT DEFAULT '';

-- Creator's Razorpay linked account (for auto-transfer)
ALTER TABLE creators ADD COLUMN IF NOT EXISTS razorpay_account_id TEXT DEFAULT '';

-- Extended payment statuses
-- order_created → escrowed → release_requested → released
-- (also: failed, disputed)

SELECT 'Razorpay columns added ✅' as result;

-- ─────────────────────────────────────────────────────────────────────────────
--  ADD RAZORPAY FIELDS TO PAYMENTS TABLE
--  Run this in Supabase SQL Editor if you already have the payments table
-- ─────────────────────────────────────────────────────────────────────────────
alter table payments add column if not exists razorpay_order_id   text;
alter table payments add column if not exists razorpay_payment_id text;
alter table payments add column if not exists paid_at             timestamptz;
alter table payments add column if not exists creator_share       numeric default 0;
alter table payments add column if not exists platform_share      numeric default 0;
alter table payments add column if not exists payment_method      text default 'manual';

-- Update status check to include razorpay statuses
alter table payments drop constraint if exists payments_status_check;
alter table payments add constraint payments_status_check
  check (status in ('pending','awaiting_payment','held','requested','released','disputed','refunded'));

select 'Razorpay schema update complete ✅' as result;

-- ─────────────────────────────────────────────────────────────────────────────
--  TRUST & ESCROW ENFORCEMENT — run in Supabase SQL editor
-- ─────────────────────────────────────────────────────────────────────────────

-- delivered_at: set when creator submits work — used for 7-day auto-release timer
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

-- creator_share / platform_share: stored on payment record after release
ALTER TABLE payments ADD COLUMN IF NOT EXISTS creator_share  numeric DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS platform_share numeric DEFAULT 0;

-- Index to make auto-release query fast (checks delivered_at on active contracts)
CREATE INDEX IF NOT EXISTS idx_contracts_delivered_active
  ON contracts (delivered_at)
  WHERE status = 'active' AND delivered_at IS NOT NULL;

SELECT 'Trust & escrow schema update complete ✅' as result;
-- ─────────────────────────────────────────────────────────────────────────────
--  SocialMitr — Payout Fields Migration
--  Run this in Supabase SQL Editor before deploying the new server.js
-- ─────────────────────────────────────────────────────────────────────────────

-- Add payout columns to creators table
ALTER TABLE creators ADD COLUMN IF NOT EXISTS upi_id        TEXT DEFAULT '';
ALTER TABLE creators ADD COLUMN IF NOT EXISTS bank_account  TEXT DEFAULT '';
ALTER TABLE creators ADD COLUMN IF NOT EXISTS bank_ifsc     TEXT DEFAULT '';
ALTER TABLE creators ADD COLUMN IF NOT EXISTS payout_method TEXT DEFAULT 'upi';
ALTER TABLE creators ADD COLUMN IF NOT EXISTS upi_provider TEXT DEFAULT '';
ALTER TABLE creators ADD COLUMN IF NOT EXISTS upi_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS bank_name TEXT DEFAULT '';
ALTER TABLE creators ADD COLUMN IF NOT EXISTS bank_branch TEXT DEFAULT '';
ALTER TABLE creators ADD COLUMN IF NOT EXISTS bank_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS razorpay_account_id TEXT DEFAULT '';

SELECT 'Payout fields migration complete ✅' AS result;

-- ─────────────────────────────────────────────────────────────────────────────
--  WALLET & PAYOUT SYSTEM TABLES
--  Handles wallet balances, transaction ledger, and withdrawal history
-- ─────────────────────────────────────────────────────────────────────────────

-- WALLETS — Main wallet balance tracking per creator
CREATE TABLE IF NOT EXISTS wallets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id          UUID UNIQUE NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  available_balance   NUMERIC DEFAULT 0,
  pending_balance     NUMERIC DEFAULT 0,
  total_earned        NUMERIC DEFAULT 0,
  total_withdrawn     NUMERIC DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- WALLET TRANSACTIONS — Ledger of all credits, debits, and fees
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id       UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  creator_id      UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  amount          NUMERIC NOT NULL,
  balance_after   NUMERIC NOT NULL,
  status          TEXT DEFAULT 'completed',
  description     TEXT DEFAULT '',
  reference_id    TEXT DEFAULT '',
  reference_type  TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- PAYOUTS — Withdrawal history and status
CREATE TABLE IF NOT EXISTS payouts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id          UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  amount              NUMERIC NOT NULL,
  payout_method       TEXT NOT NULL,
  upi_id              TEXT DEFAULT '',
  bank_account        TEXT DEFAULT '',
  bank_ifsc           TEXT DEFAULT '',
  status              TEXT DEFAULT 'pending',
  payout_id           TEXT DEFAULT '',
  razorpay_payout_id  TEXT DEFAULT '',
  reference_id        TEXT DEFAULT '',
  failure_reason      TEXT DEFAULT '',
  initiated_at        TIMESTAMPTZ DEFAULT NOW(),
  processed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_wallets_creator_id ON wallets(creator_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_creator_id ON wallet_transactions(creator_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_id ON wallet_transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_payouts_creator_id ON payouts(creator_id);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);

SELECT 'Wallet & Payout tables created successfully ✅' AS result;
