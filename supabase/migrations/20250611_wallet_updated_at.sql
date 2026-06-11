-- Fix: wallet_transactions needs updated_at for backend createModel
ALTER TABLE wallet_transactions
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DROP TRIGGER IF EXISTS trg_wallet_transactions_updated_at ON wallet_transactions;
CREATE TRIGGER trg_wallet_transactions_updated_at
    BEFORE UPDATE ON wallet_transactions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
