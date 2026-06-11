const Driver = require('../models/Driver');
const Order = require('../models/Order');
const { redis } = require('../config/redis');

const ACTIVE_TRIP_STATUSES = ['accepted', 'driver_arrived', 'picked_up', 'in_transit'];

/** Source of truth: live order row beats is_on_trip flag. */
const driverHasLiveTrip = async (driverId) => {
    const activeOrder = await Order.findOne({
        driver_id: String(driverId),
        status: { $in: ACTIVE_TRIP_STATUSES },
    }).select('_id');
    return !!activeOrder;
};

const syncDriverGeoIndex = async (driver) => {
    if (!driver?._id) return;
    const id = String(driver._id);
    const coords = driver.location?.coordinates;
    const latitude = coords?.[1] ?? driver.latitude;
    const longitude = coords?.[0] ?? driver.longitude;

    const onLiveTrip = await driverHasLiveTrip(id);
    const canIndex = driver.is_active
        && !onLiveTrip
        && !driver.is_blocked
        && /approved/i.test(driver.kyc_status || '')
        && latitude != null
        && longitude != null;

    try {
        if (canIndex) {
            await redis.geoadd('drivers_locations', Number(longitude), Number(latitude), id);
            console.log(`📍 [Redis] Indexed driver ${id} at ${latitude},${longitude}`);
        } else {
            await redis.zrem('drivers_locations', id);
        }
    } catch (redisErr) {
        console.error('❌ [Redis GEO sync Error]:', redisErr.message);
    }
};

/**
 * Clear stuck is_on_trip / current_order_id when driver has no live order.
 * Returns true when stale state was released.
 */
const releaseStaleDriverTripState = async (driverId) => {
    const id = String(driverId);
    const activeOrder = await Order.findOne({
        driver_id: id,
        status: { $in: ACTIVE_TRIP_STATUSES },
    }).select('_id');

    if (activeOrder) return false;

    const driver = await Driver.findById(id);
    if (!driver) return false;
    if (!driver.is_on_trip && !driver.current_order_id) return false;

    driver.is_on_trip = false;
    driver.current_order_id = null;
    await driver.save();
    await syncDriverGeoIndex(driver);
    console.log(`🔓 [DriverAvailability] Released stale trip lock for driver ${id}`);
    return true;
};

const haversineKm = (lat1, lng1, lat2, lng2) => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const releaseStaleTripStateNearPickup = async (lat, lng, radiusKm = 15) => {
    const seen = new Set();
    try {
        const ids = await redis.georadius('drivers_locations', lng, lat, radiusKm, 'km');
        for (const driverId of ids) {
            seen.add(String(driverId));
            await releaseStaleDriverTripState(driverId);
        }
    } catch (err) {
        console.error('[DriverAvailability] Near-pickup Redis stale release error:', err.message);
    }

    try {
        const flagged = await Driver.find({
            is_active: true,
            is_on_trip: true,
        }).limit(50);

        for (const driver of flagged) {
            const id = String(driver._id);
            if (seen.has(id)) continue;
            const coords = driver.location?.coordinates;
            const dLat = coords?.[1] ?? driver.latitude;
            const dLng = coords?.[0] ?? driver.longitude;
            if (dLat == null || dLng == null) continue;
            if (haversineKm(lat, lng, Number(dLat), Number(dLng)) <= radiusKm) {
                await releaseStaleDriverTripState(id);
            }
        }
    } catch (err) {
        console.error('[DriverAvailability] Near-pickup DB stale release error:', err.message);
    }
};

/**
 * Production rule: driver can receive offers only if DB has no live trip.
 * Auto-heals stale is_on_trip / current_order_id flags.
 */
const isDriverDispatchable = async (driverOrId) => {
    const driver = typeof driverOrId === 'string'
        ? await Driver.findById(driverOrId)
        : driverOrId;
    if (!driver) return false;
    if (!driver.is_active || driver.is_blocked) return false;
    if (!/approved/i.test(driver.kyc_status || '')) return false;

    const id = String(driver._id);
    const onLiveTrip = await driverHasLiveTrip(id);

    if (onLiveTrip) return false;

    if (driver.is_on_trip || driver.current_order_id) {
        await releaseStaleDriverTripState(id);
    }

    return true;
};

/** Background sweep: fix all online drivers stuck with trip flags. */
const reconcileAllStaleOnlineDrivers = async () => {
    const flagged = await Driver.find({
        is_active: true,
        is_on_trip: true,
    }).limit(100);

    let released = 0;
    for (const driver of flagged) {
        const changed = await releaseStaleDriverTripState(driver._id);
        if (changed) released += 1;
    }
    return released;
};

const setDriverTripState = async (driverId, { onTrip, orderId = null }) => {
    const driver = await Driver.findById(driverId);
    if (!driver) return null;

    driver.is_on_trip = !!onTrip;
    driver.current_order_id = onTrip && orderId ? String(orderId) : null;
    await driver.save();
    await syncDriverGeoIndex(driver);
    return driver;
};

module.exports = {
    syncDriverGeoIndex,
    releaseStaleDriverTripState,
    releaseStaleTripStateNearPickup,
    driverHasLiveTrip,
    isDriverDispatchable,
    reconcileAllStaleOnlineDrivers,
    setDriverTripState,
    ACTIVE_TRIP_STATUSES,
};
