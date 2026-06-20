INSERT INTO coupons (id, code, title, description, discount_type, discount_value, max_discount, min_order_value, is_active, usage_limit, times_used)
VALUES ('coupon_welcome20_id', 'WELCOME20', 'Welcome 20', 'Get ₹20 off on your first order above ₹80', 'flat', 20, 0, 80, true, 0, 0)
ON CONFLICT (code) DO UPDATE SET 
    title = EXCLUDED.title,
    description = EXCLUDED.description,
    discount_type = EXCLUDED.discount_type,
    discount_value = EXCLUDED.discount_value,
    min_order_value = EXCLUDED.min_order_value;
