-- Carry Goo: MongoDB → Supabase (PostgreSQL) schema
-- Run this in Supabase SQL Editor BEFORE running the migration script.
-- Preserves MongoDB ObjectId strings as TEXT primary keys for zero app breakage.

-- ─── Extensions ───────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS postgis;

-- ─── Admins ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admins (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    password    TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Settings (key-value store) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
    id          TEXT PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    value       JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Delivery Zones ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS delivery_zones (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    description         TEXT DEFAULT '',
    type                TEXT DEFAULT 'polygon' CHECK (type IN ('polygon', 'circle')),
    coordinates         JSONB DEFAULT '[]',
    center              JSONB,
    radius              NUMERIC,
    color               TEXT DEFAULT '#0891b2',
    is_active           BOOLEAN DEFAULT TRUE,
    delivery_fee        NUMERIC DEFAULT 0,
    min_order           NUMERIC DEFAULT 0,
    free_delivery_above NUMERIC DEFAULT 0,
    est_delivery_time   TEXT DEFAULT '2-3 days',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_delivery_zones_active ON delivery_zones (is_active);

-- ─── Users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    name            TEXT DEFAULT '',
    phone           TEXT NOT NULL UNIQUE,
    email           TEXT UNIQUE,
    usage_type      TEXT DEFAULT 'Personal usages',
    profile_image   TEXT DEFAULT '',
    saved_addresses JSONB DEFAULT '[]',
    fcm_token       TEXT DEFAULT '',
    average_rating  NUMERIC DEFAULT 5.0,
    total_ratings   INTEGER DEFAULT 0,
    total_rides     INTEGER DEFAULT 0,
    is_active       BOOLEAN DEFAULT TRUE,
    is_blocked      BOOLEAN DEFAULT FALSE,
    block_reason    TEXT DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users (phone);

-- ─── Drivers ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS drivers (
    id                      TEXT PRIMARY KEY,
    name                    TEXT DEFAULT '',
    phone                   TEXT NOT NULL UNIQUE,
    email                   TEXT DEFAULT '',
    city                    TEXT DEFAULT '',
    vehicle_type            TEXT DEFAULT '',
    vehicle_body_type       TEXT DEFAULT '',
    vehicle_fuel_type       TEXT DEFAULT '',
    vehicle_advanced_info   JSONB DEFAULT '{}',
    vehicle_number          TEXT DEFAULT '',
    latitude                NUMERIC,
    longitude               NUMERIC,
    location                JSONB,  -- GeoJSON Point from MongoDB
    is_active               BOOLEAN DEFAULT FALSE,
    terms_accepted          BOOLEAN DEFAULT FALSE,
    kyc_status              TEXT DEFAULT 'not_started',
    kyc_rejection_reason    TEXT DEFAULT '',
    kyc_issue_document      TEXT DEFAULT '',
    kyc_issue_reason        TEXT DEFAULT '',
    kyc_issues              JSONB DEFAULT '[]',
    aadhaar_front           TEXT DEFAULT '',
    aadhaar_back            TEXT DEFAULT '',
    pan_front               TEXT DEFAULT '',
    pan_back                TEXT DEFAULT '',
    license_front           TEXT DEFAULT '',
    license_back            TEXT DEFAULT '',
    rc_front                TEXT DEFAULT '',
    rc_back                 TEXT DEFAULT '',
    insurance               TEXT DEFAULT '',
    selfie                  TEXT DEFAULT '',
    driver_is_self          BOOLEAN DEFAULT TRUE,
    driver_name             TEXT DEFAULT '',
    driver_phone            TEXT DEFAULT '',
    is_on_trip              BOOLEAN DEFAULT FALSE,
    current_order_id        TEXT,
    total_earnings          NUMERIC DEFAULT 0,
    wallet_balance          NUMERIC DEFAULT 0,
    total_deliveries        INTEGER DEFAULT 0,
    average_rating          NUMERIC DEFAULT 5.0,
    total_ratings           INTEGER DEFAULT 0,
    fcm_token               TEXT DEFAULT '',
    is_blocked              BOOLEAN DEFAULT FALSE,
    block_reason            TEXT DEFAULT '',
    vehicles                JSONB DEFAULT '[]',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_drivers_active ON drivers (is_active, is_on_trip, kyc_status);
CREATE INDEX IF NOT EXISTS idx_drivers_phone ON drivers (phone);

-- PostGIS geography column for proximity queries (generated from lat/lng)
ALTER TABLE drivers DROP COLUMN IF EXISTS location_geo;
ALTER TABLE drivers ADD COLUMN location_geo geography(Point, 4326)
    GENERATED ALWAYS AS (
        CASE
            WHEN longitude IS NOT NULL AND latitude IS NOT NULL
                 AND (longitude != 0 OR latitude != 0)
            THEN ST_SetSRID(ST_MakePoint(longitude::float8, latitude::float8), 4326)::geography
            ELSE NULL
        END
    ) STORED;
CREATE INDEX IF NOT EXISTS idx_drivers_location_geo ON drivers USING GIST (location_geo);

-- ─── Pricings ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pricings (
    id                          TEXT PRIMARY KEY,
    city                        TEXT NOT NULL,
    vehicle_type                TEXT NOT NULL,
    vehicle_body_type           TEXT DEFAULT 'all',
    delivery_zone_id            TEXT REFERENCES delivery_zones(id) ON DELETE SET NULL,
    base_fare                   NUMERIC NOT NULL DEFAULT 50,
    base_km                     NUMERIC DEFAULT 2,
    per_km_rate                 NUMERIC NOT NULL DEFAULT 15,
    per_min_rate                NUMERIC NOT NULL DEFAULT 2,
    waiting_charge_per_min      NUMERIC DEFAULT 0,
    min_fare                    NUMERIC NOT NULL DEFAULT 80,
    max_fare                    NUMERIC DEFAULT 0,
    max_distance_km             NUMERIC DEFAULT 0,
    loading_charges             NUMERIC DEFAULT 0,
    unloading_charges           NUMERIC DEFAULT 0,
    surge_multiplier            NUMERIC DEFAULT 1.0,
    surge_active                BOOLEAN DEFAULT FALSE,
    surge_reason                TEXT DEFAULT '',
    peak_hours                  JSONB DEFAULT '[]',
    platform_commission_percent NUMERIC DEFAULT 15,
    active                      BOOLEAN DEFAULT TRUE,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (city, vehicle_type, vehicle_body_type, delivery_zone_id)
);

-- ─── Orders ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
    id                              TEXT PRIMARY KEY,
    order_number                    TEXT UNIQUE,
    user_id                         TEXT NOT NULL REFERENCES users(id),
    driver_id                       TEXT REFERENCES drivers(id) ON DELETE SET NULL,
    pickup                          JSONB NOT NULL DEFAULT '{}',
    dropoff                         JSONB NOT NULL DEFAULT '{}',
    vehicle_type                    TEXT NOT NULL,
    vehicle_body_type               TEXT DEFAULT '',
    distance_km                     NUMERIC DEFAULT 0,
    duration_min                    INTEGER DEFAULT 0,
    estimated_travel_mins           INTEGER DEFAULT 0,
    actual_wait_mins                INTEGER DEFAULT 0,
    route_polyline                  TEXT DEFAULT '',
    fare                            JSONB DEFAULT '{}',
    status                          TEXT DEFAULT 'searching',
    payment_method                  TEXT DEFAULT 'cash',
    payment_status                  TEXT DEFAULT 'pending',
    payment_id                      TEXT,
    pickup_otp                      TEXT DEFAULT '',
    delivery_otp                    TEXT DEFAULT '',
    user_rating                     JSONB,
    driver_rating                   JSONB,
    goods_type                      TEXT DEFAULT '',
    goods_description               JSONB DEFAULT '{}',
    cancelled_by                    TEXT DEFAULT '',
    cancellation_reason             TEXT DEFAULT '',
    cancelled_at                    TIMESTAMPTZ,
    rejected_drivers                JSONB DEFAULT '[]',
    dispatch_candidate_driver_ids   JSONB DEFAULT '[]',
    dispatch_cursor                 INTEGER DEFAULT 0,
    offered_driver_id               TEXT,
    offer_expires_at                TIMESTAMPTZ,
    offer_attempt                   INTEGER DEFAULT 0,
    timeline                        JSONB DEFAULT '[]',
    is_scheduled                    BOOLEAN DEFAULT FALSE,
    scheduled_at                    TIMESTAMPTZ,
    delivery_photo                  TEXT DEFAULT '',
    city                            TEXT DEFAULT '',
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_driver_created ON orders (driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_city_status ON orders (city, status);

-- Deferred FK: drivers.current_order_id → orders
ALTER TABLE drivers DROP CONSTRAINT IF EXISTS fk_drivers_current_order;
ALTER TABLE drivers ADD CONSTRAINT fk_drivers_current_order
    FOREIGN KEY (current_order_id) REFERENCES orders(id) ON DELETE SET NULL;

-- ─── Payments ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
    id                  TEXT PRIMARY KEY,
    order_id            TEXT NOT NULL REFERENCES orders(id),
    user_id             TEXT NOT NULL REFERENCES users(id),
    driver_id           TEXT REFERENCES drivers(id) ON DELETE SET NULL,
    amount              NUMERIC NOT NULL,
    method              TEXT DEFAULT 'cash',
    status              TEXT DEFAULT 'pending',
    razorpay_order_id   TEXT DEFAULT '',
    razorpay_payment_id TEXT DEFAULT '',
    razorpay_signature  TEXT DEFAULT '',
    platform_commission NUMERIC DEFAULT 0,
    driver_earnings     NUMERIC DEFAULT 0,
    refund_amount       NUMERIC DEFAULT 0,
    refund_reason       TEXT DEFAULT '',
    refund_id           TEXT DEFAULT '',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_driver ON payments (driver_id);

-- ─── Driver Wallet Transactions (Rapido-style passbook) ─────────────────────
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

-- Deferred FK: orders.payment_id → payments
ALTER TABLE orders DROP CONSTRAINT IF EXISTS fk_orders_payment;
ALTER TABLE orders ADD CONSTRAINT fk_orders_payment
    FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL;

-- ─── Notifications ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    message     TEXT NOT NULL,
    type        TEXT DEFAULT 'system_alert',
    related_id  TEXT,
    on_model    TEXT CHECK (on_model IN ('Driver', 'Order', 'User')),
    is_read     BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_related ON notifications (related_id, on_model);

-- ─── OTPs ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otps (
    id          TEXT PRIMARY KEY,
    phone       TEXT NOT NULL,
    otp         TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_otps_phone ON otps (phone);
CREATE INDEX IF NOT EXISTS idx_otps_expires ON otps (expires_at);

-- ─── Migration metadata (tracks last successful run) ─────────────────────────
CREATE TABLE IF NOT EXISTS migration_meta (
    id          SERIAL PRIMARY KEY,
    source      TEXT NOT NULL DEFAULT 'mongodb',
    collection  TEXT NOT NULL,
    mongo_count INTEGER NOT NULL,
    supabase_count INTEGER NOT NULL,
    migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status      TEXT NOT NULL DEFAULT 'success'
);

-- ─── updated_at trigger ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['admins','settings','delivery_zones','users','drivers','pricings','orders','payments']
    LOOP
        EXECUTE format('
            DROP TRIGGER IF EXISTS trg_%s_updated_at ON %I;
            CREATE TRIGGER trg_%s_updated_at
                BEFORE UPDATE ON %I
                FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        ', t, t, t, t);
    END LOOP;
END;
$$;
