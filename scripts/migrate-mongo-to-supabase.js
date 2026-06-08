#!/usr/bin/env node
/**
 * Carry Goo — MongoDB → Supabase data migration
 *
 * Usage:
 *   node scripts/migrate-mongo-to-supabase.js --dry-run   # count only, no writes
 *   node scripts/migrate-mongo-to-supabase.js             # full migration
 *
 * Prerequisites:
 *   1. Run backend/supabase/schema.sql in Supabase SQL Editor
 *   2. Set MONGO_URI, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in backend/.env
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const { getSupabaseAdmin } = require('../config/supabase');

// Use raw MongoDB collections (models now point to Supabase)
const MONGO_COLLECTIONS = {
    admins: 'admins',
    settings: 'settings',
    delivery_zones: 'delivery_zones',
    users: 'users',
    otps: 'otps',
    drivers: 'drivers',
    pricings: 'pricings',
    orders: 'orders',
    payments: 'payments',
    notifications: 'notifications',
};

const BATCH_SIZE = 50;
const DRY_RUN = process.argv.includes('--dry-run');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const toId = (val) => {
    if (!val) return null;
    return val.toString ? val.toString() : String(val);
};

const toIds = (arr) => (arr || []).map(toId).filter(Boolean);

const toDate = (val) => (val ? new Date(val).toISOString() : null);

const toJson = (val, fallback = null) => {
    if (val === undefined || val === null) return fallback;
    return JSON.parse(JSON.stringify(val));
};

// ─── Transformers (Mongo doc → Supabase row) ───────────────────────────────

const transformAdmin = (doc) => ({
    id: toId(doc._id),
    email: doc.email,
    password: doc.password,
    created_at: toDate(doc.createdAt),
    updated_at: toDate(doc.updatedAt),
});

const transformSetting = (doc) => ({
    id: toId(doc._id),
    key: doc.key,
    value: toJson(doc.value, {}),
    created_at: toDate(doc.createdAt),
    updated_at: toDate(doc.updatedAt),
});

const transformDeliveryZone = (doc) => ({
    id: toId(doc._id),
    name: doc.name,
    description: doc.description || '',
    type: doc.type || 'polygon',
    coordinates: toJson(doc.coordinates, []),
    center: toJson(doc.center),
    radius: doc.radius ?? null,
    color: doc.color || '#0891b2',
    is_active: doc.isActive !== false,
    delivery_fee: doc.delivery_fee ?? 0,
    min_order: doc.min_order ?? 0,
    free_delivery_above: doc.free_delivery_above ?? 0,
    est_delivery_time: doc.est_delivery_time || '2-3 days',
    created_at: toDate(doc.createdAt),
    updated_at: toDate(doc.updatedAt),
});

const transformUser = (doc) => ({
    id: toId(doc._id),
    name: doc.name || '',
    phone: doc.phone,
    email: doc.email || null,
    usage_type: doc.usage_type || 'Personal usages',
    profile_image: doc.profile_image || '',
    saved_addresses: toJson(doc.saved_addresses, []),
    fcm_token: doc.fcm_token || '',
    average_rating: doc.average_rating ?? 5.0,
    total_ratings: doc.total_ratings ?? 0,
    total_rides: doc.total_rides ?? 0,
    is_active: doc.is_active !== false,
    is_blocked: doc.is_blocked || false,
    block_reason: doc.block_reason || '',
    created_at: toDate(doc.createdAt),
    updated_at: toDate(doc.updatedAt),
});

const transformDriver = (doc) => {
    const coords = doc.location?.coordinates;
    const lng = coords?.[0] ?? doc.longitude ?? null;
    const lat = coords?.[1] ?? doc.latitude ?? null;

    return {
        id: toId(doc._id),
        name: doc.name || '',
        phone: doc.phone,
        email: doc.email || '',
        city: doc.city || '',
        vehicle_type: doc.vehicle_type || '',
        vehicle_body_type: doc.vehicle_body_type || '',
        vehicle_fuel_type: doc.vehicle_fuel_type || '',
        vehicle_advanced_info: toJson(doc.vehicle_advanced_info, {}),
        vehicle_number: doc.vehicle_number || '',
        latitude: lat,
        longitude: lng,
        location: doc.location ? toJson(doc.location) : null,
        is_active: doc.is_active || false,
        terms_accepted: doc.terms_accepted || false,
        kyc_status: doc.kyc_status || 'not_started',
        kyc_rejection_reason: doc.kyc_rejection_reason || '',
        kyc_issue_document: doc.kyc_issue_document || '',
        kyc_issue_reason: doc.kyc_issue_reason || '',
        kyc_issues: toJson(doc.kyc_issues, []),
        aadhaar_front: doc.aadhaar_front || '',
        aadhaar_back: doc.aadhaar_back || '',
        pan_front: doc.pan_front || '',
        pan_back: doc.pan_back || '',
        license_front: doc.license_front || '',
        license_back: doc.license_back || '',
        rc_front: doc.rc_front || '',
        rc_back: doc.rc_back || '',
        insurance: doc.insurance || '',
        selfie: doc.selfie || '',
        driver_is_self: doc.driver_is_self !== false,
        driver_name: doc.driver_name || '',
        driver_phone: doc.driver_phone || '',
        is_on_trip: doc.is_on_trip || false,
        current_order_id: toId(doc.current_order_id),
        total_earnings: doc.total_earnings ?? 0,
        total_deliveries: doc.total_deliveries ?? 0,
        average_rating: doc.average_rating ?? 5.0,
        total_ratings: doc.total_ratings ?? 0,
        fcm_token: doc.fcm_token || '',
        is_blocked: doc.is_blocked || false,
        block_reason: doc.block_reason || '',
        vehicles: toJson(doc.vehicles, []),
        created_at: toDate(doc.createdAt),
        updated_at: toDate(doc.updatedAt),
    };
};

const transformPricing = (doc) => ({
    id: toId(doc._id),
    city: doc.city,
    vehicle_type: doc.vehicle_type,
    vehicle_body_type: doc.vehicle_body_type || 'all',
    delivery_zone_id: toId(doc.delivery_zone),
    base_fare: doc.base_fare ?? 50,
    base_km: doc.base_km ?? 2,
    per_km_rate: doc.per_km_rate ?? 15,
    per_min_rate: doc.per_min_rate ?? 2,
    waiting_charge_per_min: doc.waiting_charge_per_min ?? 0,
    min_fare: doc.min_fare ?? 80,
    max_fare: doc.max_fare ?? 0,
    max_distance_km: doc.max_distance_km ?? 0,
    loading_charges: doc.loading_charges ?? 0,
    unloading_charges: doc.unloading_charges ?? 0,
    surge_multiplier: doc.surge_multiplier ?? 1.0,
    surge_active: doc.surge_active || false,
    surge_reason: doc.surge_reason || '',
    peak_hours: toJson(doc.peak_hours, []),
    platform_commission_percent: doc.platform_commission_percent ?? 15,
    active: doc.active !== false,
    created_at: toDate(doc.createdAt),
    updated_at: toDate(doc.updatedAt),
});

const transformOrder = (doc) => ({
    id: toId(doc._id),
    order_number: doc.order_number || null,
    user_id: toId(doc.user_id),
    driver_id: toId(doc.driver_id),
    pickup: toJson(doc.pickup, {}),
    dropoff: toJson(doc.dropoff, {}),
    vehicle_type: doc.vehicle_type,
    vehicle_body_type: doc.vehicle_body_type || '',
    distance_km: doc.distance_km ?? 0,
    duration_min: doc.duration_min ?? 0,
    estimated_travel_mins: doc.estimated_travel_mins ?? 0,
    actual_wait_mins: doc.actual_wait_mins ?? 0,
    route_polyline: doc.route_polyline || '',
    fare: toJson(doc.fare, {}),
    status: doc.status || 'searching',
    payment_method: doc.payment_method || 'cash',
    payment_status: doc.payment_status || 'pending',
    payment_id: toId(doc.payment_id),
    pickup_otp: doc.pickup_otp || '',
    delivery_otp: doc.delivery_otp || '',
    user_rating: toJson(doc.user_rating),
    driver_rating: toJson(doc.driver_rating),
    goods_type: doc.goods_type || '',
    goods_description: toJson(doc.goods_description, {}),
    cancelled_by: doc.cancelled_by || '',
    cancellation_reason: doc.cancellation_reason || '',
    cancelled_at: toDate(doc.cancelled_at),
    rejected_drivers: toIds(doc.rejected_drivers),
    dispatch_candidate_driver_ids: toIds(doc.dispatch_candidate_driver_ids),
    dispatch_cursor: doc.dispatch_cursor ?? 0,
    offered_driver_id: toId(doc.offered_driver_id),
    offer_expires_at: toDate(doc.offer_expires_at),
    offer_attempt: doc.offer_attempt ?? 0,
    timeline: toJson(doc.timeline, []),
    is_scheduled: doc.is_scheduled || false,
    scheduled_at: toDate(doc.scheduled_at),
    delivery_photo: doc.delivery_photo || '',
    city: doc.city || '',
    created_at: toDate(doc.createdAt),
    updated_at: toDate(doc.updatedAt),
});

const transformPayment = (doc) => ({
    id: toId(doc._id),
    order_id: toId(doc.order_id),
    user_id: toId(doc.user_id),
    driver_id: toId(doc.driver_id),
    amount: doc.amount,
    method: doc.method || 'cash',
    status: doc.status || 'pending',
    razorpay_order_id: doc.razorpay_order_id || '',
    razorpay_payment_id: doc.razorpay_payment_id || '',
    razorpay_signature: doc.razorpay_signature || '',
    platform_commission: doc.platform_commission ?? 0,
    driver_earnings: doc.driver_earnings ?? 0,
    refund_amount: doc.refund_amount ?? 0,
    refund_reason: doc.refund_reason || '',
    refund_id: doc.refund_id || '',
    created_at: toDate(doc.createdAt),
    updated_at: toDate(doc.updatedAt),
});

const transformNotification = (doc) => ({
    id: toId(doc._id),
    title: doc.title,
    message: doc.message,
    type: doc.type || 'system_alert',
    related_id: toId(doc.relatedId),
    on_model: doc.onModel || null,
    is_read: doc.isRead || false,
    created_at: toDate(doc.createdAt),
});

const transformOtp = (doc) => ({
    id: toId(doc._id),
    phone: doc.phone,
    otp: doc.otp,
    expires_at: toDate(doc.expiresAt),
    created_at: toDate(doc.createdAt) || new Date().toISOString(),
});

// ─── Migration runner ────────────────────────────────────────────────────────

const COLLECTIONS = [
    { name: 'admins', table: 'admins', transform: transformAdmin },
    { name: 'settings', table: 'settings', transform: transformSetting },
    { name: 'delivery_zones', table: 'delivery_zones', transform: transformDeliveryZone },
    { name: 'users', table: 'users', transform: transformUser },
    { name: 'otps', table: 'otps', transform: transformOtp },
    { name: 'drivers', table: 'drivers', transform: transformDriver, deferFks: ['current_order_id'] },
    { name: 'pricings', table: 'pricings', transform: transformPricing },
    { name: 'orders', table: 'orders', transform: transformOrder, deferFks: ['payment_id'] },
    { name: 'payments', table: 'payments', transform: transformPayment },
    { name: 'notifications', table: 'notifications', transform: transformNotification },
];

async function ensureTablesExist(supabase) {
    const { error } = await supabase.from('admins').select('id').limit(1);
    if (error && /schema cache|does not exist|relation/i.test(error.message)) {
        console.error('\n❌ Supabase tables not found. Schema was not applied yet.\n');
        console.error('Fix — choose ONE option:\n');
        console.error('  Option A (automated):');
        console.error('    1. Add SUPABASE_DB_URL to backend/.env');
        console.error('       (Supabase Dashboard → Settings → Database → Connection string → URI)');
        console.error('    2. Run: npm run migrate:setup');
        console.error('    3. Run: npm run migrate:supabase\n');
        console.error('  Option B (manual):');
        console.error('    1. Open Supabase Dashboard → SQL Editor');
        console.error('    2. Paste contents of backend/supabase/schema.sql');
        console.error('    3. Click Run, then: npm run migrate:supabase\n');
        throw new Error('Supabase schema missing — run migrate:setup first');
    }
    if (error) throw new Error(`[schema check] ${error.message}`);
}

async function upsertBatch(supabase, table, rows) {
    const { error } = await supabase.from(table).upsert(rows, { onConflict: 'id' });
    if (error) throw new Error(`[${table}] upsert failed: ${error.message}`);
}

async function migrateCollection(supabase, { name, table, transform, deferFks }) {
    const collectionName = MONGO_COLLECTIONS[name];
    const docs = await mongoose.connection.db.collection(collectionName).find({}).toArray();
    const mongoCount = docs.length;

    console.log(`\n📦 ${name}: ${mongoCount} documents`);

    if (mongoCount === 0) {
        return { name, table, mongoCount, supabaseCount: 0, deferred: null };
    }

    if (DRY_RUN) {
        console.log(`   [dry-run] Would migrate ${mongoCount} rows to "${table}"`);
        return { name, table, mongoCount, supabaseCount: mongoCount, deferred: null };
    }

    const deferred = [];
    const rows = docs.map((doc) => {
        const row = transform(doc);
        if (deferFks) {
            for (const field of deferFks) {
                if (row[field]) {
                    deferred.push({ id: row.id, field, value: row[field] });
                    row[field] = null;
                }
            }
        }
        return row;
    });

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        await upsertBatch(supabase, table, batch);
        process.stdout.write(`   ✅ ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}\r`);
    }
    console.log(`   ✅ ${rows.length}/${rows.length} migrated`);

    const { count, error } = await supabase
        .from(table)
        .select('*', { count: 'exact', head: true });

    if (error) throw new Error(`[${table}] count failed: ${error.message}`);

    const supabaseCount = count ?? 0;

    if (supabaseCount < mongoCount) {
        throw new Error(
            `[${table}] COUNT MISMATCH: mongo=${mongoCount}, supabase=${supabaseCount}`
        );
    }

    // Log to migration_meta
    await supabase.from('migration_meta').insert({
        source: 'mongodb',
        collection: name,
        mongo_count: mongoCount,
        supabase_count: supabaseCount,
        status: mongoCount === supabaseCount ? 'success' : 'mismatch',
    });

    return { name, table, mongoCount, supabaseCount, deferred: deferred.length ? deferred : null };
}

async function applyDeferredFks(supabase, deferredUpdates) {
    for (const { table, field, items } of deferredUpdates) {
        if (!items?.length) continue;
        console.log(`\n🔗 Restoring ${items.length} deferred FK(s) on ${table}.${field}...`);
        for (const { id, value } of items) {
            const { error } = await supabase.from(table).update({ [field]: value }).eq('id', id);
            if (error) throw new Error(`[${table}] FK restore failed for ${id}: ${error.message}`);
        }
        console.log(`   ✅ ${items.length} FK values restored`);
    }
}

async function main() {
    console.log('═══════════════════════════════════════════════════');
    console.log('  Carry Goo — MongoDB → Supabase Migration');
    console.log(DRY_RUN ? '  Mode: DRY RUN (no writes)' : '  Mode: LIVE MIGRATION');
    console.log('═══════════════════════════════════════════════════');

    if (!process.env.MONGO_URI) {
        console.error('❌ MONGO_URI is not set in backend/.env');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log(`✅ MongoDB connected: ${mongoose.connection.host}`);

    let supabase = null;
    if (!DRY_RUN) {
        supabase = getSupabaseAdmin();
        console.log(`✅ Supabase connected: ${process.env.SUPABASE_URL}`);
        await ensureTablesExist(supabase);
        console.log('✅ Supabase tables verified');
    }

    const results = [];
    const allDeferred = [];

    for (const col of COLLECTIONS) {
        try {
            const result = await migrateCollection(supabase, col);
            results.push(result);
            if (result.deferred?.length) {
                allDeferred.push({
                    table: col.table,
                    field: col.deferFks[0],
                    items: result.deferred.map((d) => ({ id: d.id, value: d.value })),
                });
            }
        } catch (err) {
            console.error(`\n❌ Failed on "${col.name}": ${err.message}`);
            await mongoose.disconnect();
            process.exit(1);
        }
    }

    // Restore circular FKs: orders.payment_id, drivers.current_order_id
    if (!DRY_RUN && allDeferred.length) {
        // orders.payment_id first (payments already migrated), then drivers.current_order_id
        const ordered = [
            allDeferred.find((d) => d.table === 'orders'),
            allDeferred.find((d) => d.table === 'drivers'),
        ].filter(Boolean);
        await applyDeferredFks(supabase, ordered);
    }

    console.log('\n═══════════════════════════════════════════════════');
    console.log('  MIGRATION SUMMARY');
    console.log('═══════════════════════════════════════════════════');
    console.log('Collection'.padEnd(20), 'Mongo'.padStart(8), 'Supabase'.padStart(10), 'Status'.padStart(10));
    console.log('─'.repeat(50));

    let allOk = true;
    for (const r of results) {
        const ok = r.mongoCount === r.supabaseCount;
        if (!ok) allOk = false;
        console.log(
            r.name.padEnd(20),
            String(r.mongoCount).padStart(8),
            String(r.supabaseCount).padStart(10),
            (ok ? '✅ OK' : '❌ FAIL').padStart(10)
        );
    }

    const totalMongo = results.reduce((s, r) => s + r.mongoCount, 0);
    const totalSupa = results.reduce((s, r) => s + r.supabaseCount, 0);
    console.log('─'.repeat(50));
    console.log('TOTAL'.padEnd(20), String(totalMongo).padStart(8), String(totalSupa).padStart(10));

    await mongoose.disconnect();

    if (DRY_RUN) {
        console.log('\nℹ️  Dry run complete. Run without --dry-run to migrate.');
    } else if (allOk) {
        console.log('\n🎉 Migration successful — zero data loss verified!');
    } else {
        console.log('\n⚠️  Migration completed with count mismatches. Check logs.');
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
