const { createClient } = require('@supabase/supabase-js');

let supabaseAdmin = null;

const getSupabaseAdmin = () => {
    if (supabaseAdmin) return supabaseAdmin;

    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceKey) {
        throw new Error(
            'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env before migration.'
        );
    }

    supabaseAdmin = createClient(url, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
    });

    return supabaseAdmin;
};

module.exports = { getSupabaseAdmin };
