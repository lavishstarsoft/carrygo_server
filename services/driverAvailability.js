const Driver = require('../models/Driver');
const Order = require('../models/Order');
const { redis } = require('../config/redis');

const ACTIVE_TRIP_STATUSES = ['accepted', 'driver_arrived', 'picked_up', 'in_transit'];

const syncDriverGeoIndex = async (driver) => {
    if (!driver?._id) return;
    const id = String(driver._id);
    const coords = driver.location?.coordinates;
    const latitude = coords?.[1] ?? driver.latitude;
    const longitude = coords?.[0] ?? driver.longitude;

    const canIndex = driver.is_active
        && !driver.is_on_trip
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

const releaseStaleTripStateNearPickup = async (lat, lng, radiusKm = 15) => {
    try {
        const ids = await redis.georadius('drivers_locations', lng, lat, radiusKm, 'km');
        for (const driverId of ids) {
            await releaseStaleDriverTripState(driverId);
        }
    } catch (err) {
        console.error('[DriverAvailability] Near-pickup stale release error:', err.message);
    }
};

module.exports = {
    syncDriverGeoIndex,
    releaseStaleDriverTripState,
    releaseStaleTripStateNearPickup,
    ACTIVE_TRIP_STATUSES,
};
