#!/usr/bin/env node
/**
 * Verify MongoDB vs Supabase row counts match after migration.
 *
 * Usage: node scripts/verify-migration.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const { getSupabaseAdmin } = require('../config/supabase');

const PAIRS = [
    { name: 'admins', table: 'admins' },
    { name: 'settings', table: 'settings' },
    { name: 'delivery_zones', table: 'delivery_zones' },
    { name: 'users', table: 'users' },
    { name: 'otps', table: 'otps' },
    { name: 'drivers', table: 'drivers' },
    { name: 'pricings', table: 'pricings' },
    { name: 'orders', table: 'orders' },
    { name: 'payments', table: 'payments' },
    { name: 'notifications', table: 'notifications' },
];

async function main() {
    if (!process.env.MONGO_URI) {
        console.error('❌ MONGO_URI not set');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI);
    const supabase = getSupabaseAdmin();

    console.log('\n🔍 Verifying MongoDB ↔ Supabase counts...\n');
    console.log('Collection'.padEnd(20), 'Mongo'.padStart(8), 'Supabase'.padStart(10), 'Match'.padStart(8));
    console.log('─'.repeat(48));

    let allMatch = true;

    for (const { name, table } of PAIRS) {
        const mongoCount = await mongoose.connection.db.collection(name).countDocuments();
        const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });

        if (error) {
            console.log(name.padEnd(20), String(mongoCount).padStart(8), 'ERROR'.padStart(10));
            allMatch = false;
            continue;
        }

        const supaCount = count ?? 0;
        const match = mongoCount === supaCount;
        if (!match) allMatch = false;

        console.log(
            name.padEnd(20),
            String(mongoCount).padStart(8),
            String(supaCount).padStart(10),
            (match ? '✅' : '❌').padStart(8)
        );
    }

    await mongoose.disconnect();

    console.log('─'.repeat(48));
    if (allMatch) {
        console.log('\n✅ All collections match — no data loss detected.');
    } else {
        console.log('\n❌ Mismatches found. Re-run migration or investigate.');
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
