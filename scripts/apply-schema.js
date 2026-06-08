#!/usr/bin/env node
/**
 * Apply backend/supabase/schema.sql to Supabase PostgreSQL.
 *
 * Requires SUPABASE_DB_URL in .env (from Supabase Dashboard → Settings → Database → URI)
 * Example:
 *   SUPABASE_DB_URL=postgresql://postgres.[ref]:[PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
 *
 * Usage: npm run migrate:setup
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');

async function main() {
    const dbUrl = process.env.SUPABASE_DB_URL;

    if (!dbUrl) {
        console.error('❌ SUPABASE_DB_URL is not set in backend/.env\n');
        console.error('Get it from: Supabase Dashboard → Project Settings → Database → Connection string → URI');
        console.error('Add to .env:');
        console.error('  SUPABASE_DB_URL=postgresql://postgres.[ref]:[PASSWORD]@...supabase.com:5432/postgres\n');
        console.error('OR paste backend/supabase/schema.sql manually in Supabase SQL Editor and run it.');
        process.exit(1);
    }

    let pg;
    try {
        pg = require('pg');
    } catch {
        console.error('❌ pg package not installed. Run: npm install pg');
        process.exit(1);
    }

    const schemaPath = path.join(__dirname, '..', 'supabase', 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    const client = new pg.Client({
        connectionString: dbUrl,
        ssl: { rejectUnauthorized: false },
    });

    console.log('🔧 Connecting to Supabase PostgreSQL...');
    await client.connect();
    console.log('✅ Connected. Applying schema...');

    try {
        await client.query(sql);
        console.log('✅ Schema applied successfully!');
    } catch (err) {
        console.error('❌ Schema apply failed:', err.message);
        process.exit(1);
    } finally {
        await client.end();
    }

    // Verify tables exist
    const { rows } = await (async () => {
        const c = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
        await c.connect();
        const result = await c.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('admins','users','drivers','orders','notifications','migration_meta')
            ORDER BY table_name
        `);
        await c.end();
        return result;
    })();

    console.log('\n📋 Tables verified:', rows.map((r) => r.table_name).join(', '));
    console.log('\n▶️  Next: npm run migrate:supabase');
}

main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
