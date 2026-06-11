-- Run once on production Supabase (SQL Editor or psql)
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC DEFAULT 0;

CREATE TABLE IF NOT EXISTS wallet_transactions (
    id                  TEXT PRIMARY KEY,
    driver_id           TEXT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    order_id            TEXT REFERENCES orders(id) ON DELETE SET NULL,
    order_number        TEXT DEFAULT '',
    type                TEXT DEFAULT 'trip_earning',
    payment_method      TEXT DEFAULT 'cash',
    total_fare          NUMERIC DEFAULT 0,
    commission_amount   NUMERIC DEFAULT 0,
    commission_percent  NUMERIC DEFAULT 0,
    driver_earnings     NUMERIC DEFAULT 0,
    wallet_delta        NUMERIC DEFAULT 0,
    balance_after       NUMERIC DEFAULT 0,
    note                TEXT DEFAULT '',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_driver_created ON wallet_transactions (driver_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tx_order_unique ON wallet_transactions (order_id) WHERE order_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_wallet_transactions_updated_at ON wallet_transactions;
