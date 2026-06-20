const { randomBytes } = require('crypto');

const newId = () => randomBytes(12).toString('hex');

const toDate = (v) => (v ? new Date(v) : v);

// ─── Row (snake_case DB) → API doc (mongoose-like) ───────────────────────────

const baseFromRow = (row) => {
    if (!row) return null;
    const doc = { ...row, _id: row.id, createdAt: toDate(row.created_at), updatedAt: toDate(row.updated_at) };
    delete doc.id;
    delete doc.created_at;
    delete doc.updated_at;
    return doc;
};

const userFromRow = (row) => {
    const doc = baseFromRow(row);
    if (!doc) return null;
    return doc;
};

const driverFromRow = (row) => {
    const doc = baseFromRow(row);
    if (!doc) return null;
    // Ensure GeoJSON location exists for map display (Supabase may have lat/lng columns only)
    if ((!doc.location || !doc.location.coordinates) && doc.latitude != null && doc.longitude != null) {
        doc.location = { type: 'Point', coordinates: [Number(doc.longitude), Number(doc.latitude)] };
    }
    if (doc.current_order_id) doc.current_order_id = doc.current_order_id;
    if (Array.isArray(doc.vehicles)) {
        doc.vehicles = doc.vehicles.map((v) => ({
            ...v,
            _id: v._id || v.id || newId(),
        }));
    }
    return doc;
};

const orderFromRow = (row) => {
    const doc = baseFromRow(row);
    if (!doc) return null;
    if (doc.user_id) doc.user_id = doc.user_id;
    if (doc.driver_id) doc.driver_id = doc.driver_id;
    if (doc.payment_id) doc.payment_id = doc.payment_id;
    if (doc.offered_driver_id) doc.offered_driver_id = doc.offered_driver_id;
    if (Array.isArray(doc.rejected_drivers)) {
        doc.rejected_drivers = doc.rejected_drivers.map(String);
    }
    if (Array.isArray(doc.dispatch_candidate_driver_ids)) {
        doc.dispatch_candidate_driver_ids = doc.dispatch_candidate_driver_ids.map(String);
    }
    if (doc.offer_expires_at) doc.offer_expires_at = toDate(doc.offer_expires_at);
    if (doc.cancelled_at) doc.cancelled_at = toDate(doc.cancelled_at);
    if (doc.scheduled_at) doc.scheduled_at = toDate(doc.scheduled_at);
    return doc;
};

const pricingFromRow = (row) => {
    const doc = baseFromRow(row);
    if (!doc) return null;
    if (doc.delivery_zone_id !== undefined) {
        doc.delivery_zone = doc.delivery_zone_id;
        delete doc.delivery_zone_id;
    }
    return doc;
};

const paymentFromRow = (row) => {
    const doc = baseFromRow(row);
    if (!doc) return null;
    return doc;
};

const notificationFromRow = (row) => {
    const doc = baseFromRow(row);
    if (!doc) return null;
    doc.relatedId = doc.related_id;
    doc.onModel = doc.on_model;
    doc.isRead = doc.is_read;
    doc.createdAt = toDate(doc.created_at);
    delete doc.related_id;
    delete doc.on_model;
    delete doc.is_read;
    delete doc.created_at;
    delete doc.updated_at;
    return doc;
};

const deliveryZoneFromRow = (row) => {
    const doc = baseFromRow(row);
    if (!doc) return null;
    doc.isActive = doc.is_active;
    delete doc.is_active;
    return doc;
};

const otpFromRow = (row) => {
    if (!row) return null;
    return {
        _id: row.id,
        phone: row.phone,
        otp: row.otp,
        expiresAt: toDate(row.expires_at),
        createdAt: toDate(row.created_at),
        updatedAt: toDate(row.updated_at),
    };
};

const settingFromRow = (row) => baseFromRow(row);
const adminFromRow = (row) => baseFromRow(row);

const walletTransactionFromRow = (row) => {
    const doc = baseFromRow(row);
    if (!doc) return null;
    if (doc.driver_id) doc.driver_id = doc.driver_id;
    if (doc.order_id) doc.order_id = doc.order_id;
    return doc;
};

const couponFromRow = (row) => {
    const doc = baseFromRow(row);
    if (!doc) return null;
    if (doc.is_active !== undefined) {
        doc.isActive = doc.is_active;
        delete doc.is_active;
    }
    if (doc.discount_type !== undefined) {
        doc.discountType = doc.discount_type;
        delete doc.discount_type;
    }
    if (doc.discount_value !== undefined) {
        doc.discountValue = Number(doc.discount_value);
        delete doc.discount_value;
    }
    if (doc.min_order_value !== undefined) {
        doc.minOrderValue = Number(doc.min_order_value);
        delete doc.min_order_value;
    }
    if (doc.max_discount !== undefined) {
        doc.maxDiscount = Number(doc.max_discount);
        delete doc.max_discount;
    }
    if (doc.times_used !== undefined) {
        doc.timesUsed = doc.times_used;
        delete doc.times_used;
    }
    if (doc.usage_limit !== undefined) {
        doc.usageLimit = doc.usage_limit;
        delete doc.usage_limit;
    }
    if (doc.valid_from) doc.validFrom = toDate(doc.valid_from);
    if (doc.valid_to) doc.validUntil = toDate(doc.valid_to);
    delete doc.valid_from;
    delete doc.valid_to;
    return doc;
};

const FROM_ROW = {
    users: userFromRow,
    drivers: driverFromRow,
    orders: orderFromRow,
    pricings: pricingFromRow,
    payments: paymentFromRow,
    notifications: notificationFromRow,
    delivery_zones: deliveryZoneFromRow,
    otps: otpFromRow,
    settings: settingFromRow,
    admins: adminFromRow,
    wallet_transactions: walletTransactionFromRow,
    coupons: couponFromRow,
};

// ─── API doc → Row (snake_case DB) ───────────────────────────────────────────

const baseToRow = (doc, extra = {}) => {
    const row = { ...extra };
    const id = doc._id || doc.id;
    if (id) row.id = String(id);
    if (doc.createdAt) row.created_at = new Date(doc.createdAt).toISOString();
    if (doc.updatedAt) row.updated_at = new Date(doc.updatedAt).toISOString();
    return row;
};

const userToRow = (doc) => {
    const row = baseToRow(doc);
    const fields = ['name','phone','email','usage_type','profile_image','saved_addresses','fcm_token',
        'average_rating','total_ratings','total_rides','is_active','is_blocked','block_reason'];
    fields.forEach((f) => { if (doc[f] !== undefined) row[f] = doc[f]; });
    return row;
};

const driverToRow = (doc) => {
    const row = baseToRow(doc);
    const fields = ['name','phone','email','city','vehicle_type','vehicle_body_type','vehicle_fuel_type',
        'vehicle_advanced_info','vehicle_number','latitude','longitude','location','is_active','terms_accepted',
        'kyc_status','kyc_rejection_reason','kyc_issue_document','kyc_issue_reason','kyc_issues',
        'aadhaar_front','aadhaar_back','pan_front','pan_back','license_front','license_back',
        'rc_front','rc_back','insurance','selfie','driver_is_self','driver_name','driver_phone',
        'is_on_trip','current_order_id','total_earnings','wallet_balance','total_deliveries','average_rating',
        'total_ratings','fcm_token','is_blocked','block_reason','vehicles'];
    fields.forEach((f) => { if (doc[f] !== undefined) row[f] = doc[f]; });
    if (row.current_order_id) row.current_order_id = String(row.current_order_id);
    return row;
};

const orderToRow = (doc) => {
    const row = baseToRow(doc);
    const fields = ['order_number','user_id','driver_id','pickup','dropoff','vehicle_type','vehicle_body_type',
        'distance_km','duration_min','estimated_travel_mins','actual_wait_mins','route_polyline','fare',
        'status','payment_method','payment_status','payment_id','pickup_otp','delivery_otp','user_rating',
        'driver_rating','goods_type','goods_description','cancelled_by','cancellation_reason','cancelled_at',
        'rejected_drivers','dispatch_candidate_driver_ids','dispatch_cursor','offered_driver_id',
        'offer_expires_at','offer_attempt','timeline','is_scheduled','scheduled_at','delivery_photo','city'];
    fields.forEach((f) => { if (doc[f] !== undefined) row[f] = doc[f]; });
    ['duration_min', 'estimated_travel_mins', 'actual_wait_mins', 'offer_attempt', 'dispatch_cursor'].forEach((f) => {
        if (row[f] != null && row[f] !== '') row[f] = Math.round(Number(row[f]) || 0);
    });
    ['user_id','driver_id','payment_id','offered_driver_id'].forEach((f) => {
        if (row[f]) {
            row[f] = typeof row[f] === 'object' ? String(row[f]._id || row[f].id) : String(row[f]);
        }
    });
    if (row.cancelled_at) row.cancelled_at = new Date(row.cancelled_at).toISOString();
    if (row.offer_expires_at) row.offer_expires_at = new Date(row.offer_expires_at).toISOString();
    if (row.scheduled_at) row.scheduled_at = new Date(row.scheduled_at).toISOString();
    return row;
};

const pricingToRow = (doc) => {
    const row = baseToRow(doc);
    const fields = ['city','vehicle_type','vehicle_body_type','base_fare','base_km','per_km_rate',
        'per_min_rate','waiting_charge_per_min','min_fare','max_fare','max_distance_km','loading_charges',
        'unloading_charges','surge_multiplier','surge_active','surge_reason','peak_hours',
        'platform_commission_percent','active'];
    fields.forEach((f) => { if (doc[f] !== undefined) row[f] = doc[f]; });
    const zoneId = doc.delivery_zone ?? doc.delivery_zone_id;
    if (zoneId !== undefined) row.delivery_zone_id = zoneId || null;
    return row;
};

const paymentToRow = (doc) => {
    const row = baseToRow(doc);
    const fields = ['order_id','user_id','driver_id','amount','method','status','razorpay_order_id',
        'razorpay_payment_id','razorpay_signature','platform_commission','driver_earnings',
        'refund_amount','refund_reason','refund_id'];
    fields.forEach((f) => { if (doc[f] !== undefined) row[f] = doc[f]; });
    ['order_id','user_id','driver_id'].forEach((f) => { 
        if (row[f]) {
            row[f] = typeof row[f] === 'object' ? String(row[f]._id || row[f].id) : String(row[f]);
        }
    });
    return row;
};

const notificationToRow = (doc) => {
    const row = {};
    const id = doc._id || doc.id;
    if (id) row.id = String(id);
    if (doc.title !== undefined) row.title = doc.title;
    if (doc.message !== undefined) row.message = doc.message;
    if (doc.type !== undefined) row.type = doc.type;
    if (doc.relatedId !== undefined) row.related_id = doc.relatedId ? String(doc.relatedId) : null;
    if (doc.onModel !== undefined) row.on_model = doc.onModel;
    if (doc.isRead !== undefined) row.is_read = doc.isRead;
    if (doc.createdAt) row.created_at = new Date(doc.createdAt).toISOString();
    return row;
};

const deliveryZoneToRow = (doc) => {
    const row = baseToRow(doc);
    const fields = ['name','description','type','coordinates','center','radius','color',
        'delivery_fee','min_order','free_delivery_above','est_delivery_time'];
    fields.forEach((f) => { if (doc[f] !== undefined) row[f] = doc[f]; });
    if (doc.isActive !== undefined) row.is_active = doc.isActive;
    return row;
};

const otpToRow = (doc) => ({
    id: String(doc._id || doc.id || newId()),
    phone: doc.phone,
    otp: doc.otp,
    expires_at: doc.expiresAt ? new Date(doc.expiresAt).toISOString() : new Date(Date.now() + 300000).toISOString(),
    created_at: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
});

const settingToRow = (doc) => {
    const row = baseToRow(doc);
    if (doc.key !== undefined) row.key = doc.key;
    if (doc.value !== undefined) row.value = doc.value;
    return row;
};

const adminToRow = (doc) => {
    const row = baseToRow(doc);
    if (doc.email !== undefined) row.email = doc.email;
    if (doc.password !== undefined) row.password = doc.password;
    return row;
};

const walletTransactionToRow = (doc) => {
    const row = baseToRow(doc);
    const fields = [
        'driver_id', 'order_id', 'order_number', 'type', 'payment_method',
        'total_fare', 'commission_amount', 'commission_percent', 'driver_earnings',
        'wallet_delta', 'balance_after', 'note',
    ];
    fields.forEach((f) => { if (doc[f] !== undefined) row[f] = doc[f]; });
    ['driver_id', 'order_id'].forEach((f) => { 
        if (row[f]) {
            row[f] = typeof row[f] === 'object' ? String(row[f]._id || row[f].id) : String(row[f]);
        }
    });
    return row;
};

const couponToRow = (doc) => {
    const row = baseToRow(doc);
    const fields = ['code', 'title', 'description'];
    fields.forEach((f) => { if (doc[f] !== undefined) row[f] = doc[f]; });
    if (doc.isActive !== undefined) row.is_active = doc.isActive;
    if (doc.discountType !== undefined) row.discount_type = doc.discountType;
    if (doc.discountValue !== undefined) row.discount_value = doc.discountValue;
    if (doc.minOrderValue !== undefined) row.min_order_value = doc.minOrderValue;
    if (doc.maxDiscount !== undefined) row.max_discount = doc.maxDiscount;
    if (doc.timesUsed !== undefined) row.times_used = doc.timesUsed;
    if (doc.usageLimit !== undefined) row.usage_limit = doc.usageLimit;
    if (doc.validFrom) row.valid_from = new Date(doc.validFrom).toISOString();
    if (doc.validUntil) row.valid_to = new Date(doc.validUntil).toISOString();
    return row;
};

const TO_ROW = {
    users: userToRow,
    drivers: driverToRow,
    orders: orderToRow,
    pricings: pricingToRow,
    payments: paymentToRow,
    notifications: notificationToRow,
    delivery_zones: deliveryZoneToRow,
    otps: otpToRow,
    settings: settingToRow,
    admins: adminToRow,
    wallet_transactions: walletTransactionToRow,
    coupons: couponToRow,
};

module.exports = {
    newId,
    FROM_ROW,
    TO_ROW,
};
