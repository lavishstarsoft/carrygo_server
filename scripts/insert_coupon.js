require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function insertCoupon() {
    const couponData = {
        id: 'coupon_' + Date.now(),
        code: 'WELCOME20',
        title: 'Welcome 20',
        description: 'Get ₹20 off on your first order above ₹80',
        discount_type: 'flat',
        discount_value: 20,
        max_discount: 0,
        min_order_value: 80,
        is_active: true,
        usage_limit: 0,
        times_used: 0
    };

    try {
        const res = await fetch(`${supabaseUrl}/rest/v1/coupons?on_conflict=code`, {
            method: 'POST',
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates'
            },
            body: JSON.stringify(couponData)
        });

        if (!res.ok) {
            const error = await res.text();
            console.error('Error inserting coupon:', error);
        } else {
            console.log('Successfully inserted WELCOME20 coupon!');
        }
    } catch (err) {
        console.error('Fetch failed:', err);
    }
}

insertCoupon();
