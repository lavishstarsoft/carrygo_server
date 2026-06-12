-- Fix: otps table needs updated_at for driver/user OTP upsert saves
ALTER TABLE otps
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DROP TRIGGER IF EXISTS trg_otps_updated_at ON otps;
CREATE TRIGGER trg_otps_updated_at
    BEFORE UPDATE ON otps
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
