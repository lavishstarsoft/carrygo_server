require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function insertCoupon() {
    const { data, error } = await supabase
        .from('coupons')
        .upsert({
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
        }, { onConflict: 'code' });

    if (error) {
        console.error('Error inserting coupon:', error);
    } else {
        console.log('Successfully inserted WELCOME20 coupon!');
    }
}

insertCoupon();
