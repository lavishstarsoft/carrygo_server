CREATE TABLE IF NOT EXISTS coupons (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    discount_type TEXT NOT NULL CHECK (discount_type IN ('percentage', 'flat')),
    discount_value NUMERIC NOT NULL CHECK (discount_value >= 0),
    max_discount NUMERIC DEFAULT 0,
    min_order_value NUMERIC DEFAULT 0,
    valid_from TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    valid_to TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT true,
    usage_limit INTEGER DEFAULT 0,
    times_used INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
