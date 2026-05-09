-- ══════════════════════════════════════════════════════════════════════════════
--  WALLET & PAYOUT TABLES — Run this in Supabase SQL Editor to fix wallet loading
--  This will create the missing tables that are causing "Could not load wallet" error
-- ══════════════════════════════════════════════════════════════════════════════

-- UPDATE creators table to add payout fields (if not already present)
ALTER TABLE creators ADD COLUMN IF NOT EXISTS upi_id TEXT DEFAULT '';
ALTER TABLE creators ADD COLUMN IF NOT EXISTS upi_provider TEXT DEFAULT '';
ALTER TABLE creators ADD COLUMN IF NOT EXISTS upi_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS bank_account TEXT DEFAULT '';
ALTER TABLE creators ADD COLUMN IF NOT EXISTS bank_ifsc TEXT DEFAULT '';
ALTER TABLE creators ADD COLUMN IF NOT EXISTS bank_name TEXT DEFAULT '';
ALTER TABLE creators ADD COLUMN IF NOT EXISTS bank_branch TEXT DEFAULT '';
ALTER TABLE creators ADD COLUMN IF NOT EXISTS bank_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS payout_method TEXT DEFAULT '';
ALTER TABLE creators ADD COLUMN IF NOT EXISTS razorpay_account_id TEXT DEFAULT '';

SELECT 'Creator payout fields added ✅' AS step1;

-- WALLETS — Main wallet balance tracking
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

SELECT 'Wallets table created ✅' AS step2;

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

SELECT 'Wallet transactions table created ✅' AS step3;

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

SELECT 'Payouts table created ✅' AS step4;

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_wallets_creator_id ON wallets(creator_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_creator_id ON wallet_transactions(creator_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_id ON wallet_transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_payouts_creator_id ON payouts(creator_id);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);

SELECT '🎉 All wallet tables and indexes created successfully!' AS result;
