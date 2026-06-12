#!/usr/bin/env node
/**
 * Run a single SQL migration file against Supabase PostgreSQL.
 *
 * Requires SUPABASE_DB_URL in backend/.env
 * Get from: Supabase Dashboard → Project Settings → Database → Connection string → URI
 *
 * Usage:
 *   node scripts/apply-migration-file.js supabase/migrations/20250612_otps_updated_at.sql
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');

async function main() {
    const relPath = process.argv[2];
    if (!relPath) {
        console.error('Usage: node scripts/apply-migration-file.js <path-to.sql>');
        process.exit(1);
    }

    const dbUrl = process.env.SUPABASE_DB_URL;
    if (!dbUrl) {
        console.error('❌ SUPABASE_DB_URL is not set in backend/.env');
        console.error('Supabase Dashboard → Settings → Database → Connection string → URI');
        console.error('Example: postgresql://postgres.[ref]:[PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres');
        process.exit(1);
    }

    const filePath = path.isAbsolute(relPath)
        ? relPath
        : path.join(__dirname, '..', relPath);

    if (!fs.existsSync(filePath)) {
        console.error(`❌ File not found: ${filePath}`);
        process.exit(1);
    }

    const sql = fs.readFileSync(filePath, 'utf8');
    const pg = require('pg');
    const client = new pg.Client({
        connectionString: dbUrl,
        ssl: { rejectUnauthorized: false },
    });

    console.log(`🔧 Applying migration: ${relPath}`);
    await client.connect();
    try {
        await client.query(sql);
        console.log('✅ Migration applied successfully!');
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        process.exit(1);
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
