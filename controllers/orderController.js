const Order = require('../models/Order');
const Driver = require('../models/Driver');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Notification = require('../models/Notification');
const { getDistanceAndDuration, getDirections, reverseGeocode } = require('../services/googleMaps');
const Pricing = require('../models/Pricing');
const { redis } = require('../config/redis');
const {
    releaseStaleDriverTripState,
    releaseStaleTripStateNearPickup,
    isDriverDispatchable,
    setDriverTripState,
} = require('../services/driverAvailability');
const { registerSearchingReconcile } = require('../services/productionJobs');
const WalletTransaction = require('../models/WalletTransaction');
const { settleDriverWalletOnDelivery } = require('../services/driverWallet');
const { preloadDriverCollectionQR } = require('../services/driverQrService');
const { computeTripFare, splitFareCommission } = require('../services/fareCalculation');
const { findZoneForPoint, findPricingForTrip } = require('./fareController');

// ─── Dispatch Helpers (Rapido-style one-by-one) ──────────────────────────
const OFFER_TTL_MS = parseInt(process.env.DRIVER_OFFER_TTL_MS || '30000', 10); // 30s per driver
const DISPATCH_RETRY_COOLDOWN_MS = 30000;
const DISPATCH_RADIUS_KM = parseInt(process.env.DISPATCH_RADIUS_KM || '15', 10);
const lastDispatchRetryRef = new Map();
const lastDriverWakeRef = new Map();
const DRIVER_WAKE_COOLDOWN_MS = 60000;

const offerExpiresMs = (value) => {
    if (!value) return 0;
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isNaN(ms) ? 0 : ms;
};

const haversineKm = (lat1, lng1, lat2, lng2) => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const getDriverLatLng = (driver) => {
    const coords = driver?.location?.coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
        return { lat: Number(coords[1]), lng: Number(coords[0]) };
    }
    if (driver?.latitude != null && driver?.longitude != null) {
        return { lat: Number(driver.latitude), lng: Number(driver.longitude) };
    }
    return null;
};

const rankDriversByDistance = (drivers, originLat, originLng) => {
    return drivers
        .map((driver) => {
            const pos = getDriverLatLng(driver);
            if (!pos || isNaN(pos.lat) || isNaN(pos.lng)) return null;
            return {
                driver,
                distanceKm: haversineKm(originLat, originLng, pos.lat, pos.lng),
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .map((entry) => entry.driver);
};

const emitOfferToDriver = async (io, driverId, payload) => {
    if (!io) return;
    const id = String(driverId);
    const enriched = {
        ...payload,
        order_id: String(payload.order_id),
    };

    io.to(`driver_${id}`).emit('new_order', enriched);
    io.emit(`new_order_${id}`, enriched);
    console.log(`📡 [Dispatch] Offer sent to driver ${id} for order ${enriched.order_id}`);

    try {
        const { sendPushNotification } = require('../services/pushNotification');
        const pickupAddr = payload.pickup?.address || 'Nearby';
        const fare = payload.driver_earnings || payload.fare_total || 0;

        await sendPushNotification(
            id,
            'Driver',
            'New Delivery Request 🔔',
            `Pickup: ${pickupAddr}. Fare: ₹${fare}`,
            {
                type: 'new_order',
                orderId: enriched.order_id,
            }
        );
    } catch (err) {
        console.error('[emitOfferToDriver] Error sending push notification:', err);
    }
};


const resolveDriverId = (value) => {
    if (!value) return null;
    if (typeof value === 'object') {
        return String(value._id || value.id || '');
    }
    return String(value);
};

const notifyDriverOrderCancelled = async (io, driverId, payload) => {
    if (!driverId) return;
    const id = String(driverId);
    const eventName = `order_cancelled_${id}`;
    const data = {
        order_id: String(payload.order_id),
        reason: payload.reason || 'Trip cancelled',
        cancelled_by: payload.cancelled_by || 'user',
    };

    if (io) {
        io.to(`driver_${id}`).emit(eventName, data);
        io.emit(eventName, data);
    }

    try {
        const { sendPushNotification } = require('../services/pushNotification');
        await sendPushNotification(
            id,
            'Driver',
            'Trip Cancelled',
            data.reason,
            { type: 'order_cancelled', orderId: data.order_id },
        );
    } catch (err) {
        console.error('[notifyDriverOrderCancelled] Push failed:', err.message);
    }
};

const emitUserSearchingAgain = (io, userId, orderId) => {
    if (!io) return;
    io.to(`user_${userId}`).emit('order_update', {
        order_id: orderId,
        status: 'searching',
        message: 'Finding another driver...',
    });
};

const dispatchNextDriver = async (orderId, io, reasonNote = '') => {
    const order = await Order.findById(orderId);
    if (!order) return;

    // Only dispatch when order is still searching
    if (order.status !== 'searching') return;

    const candidates = order.dispatch_candidate_driver_ids || [];
    let cursor = order.dispatch_cursor || 0;

    // Skip drivers who are rejected or already busy
    while (cursor < candidates.length) {
        const candidateId = String(candidates[cursor]);
        cursor += 1;

        if (order.rejected_drivers?.map(String).includes(candidateId)) continue;

        const driver = await Driver.findById(candidateId).select('_id is_active is_on_trip current_order_id kyc_status vehicle_type vehicle_number location average_rating name phone');
        if (!driver) continue;
        if (!new RegExp(`^${order.vehicle_type}$`, 'i').test(driver.vehicle_type || '')) continue;
        const canDispatch = await isDriverDispatchable(driver);
        if (!canDispatch) continue;

        // Offer to this driver
        const attempt = (order.offer_attempt || 0) + 1;
        order.dispatch_cursor = cursor;
        order.offered_driver_id = driver._id;
        order.offer_attempt = attempt;
        order.offer_expires_at = new Date(Date.now() + OFFER_TTL_MS);
        order.timeline.push({
            status: 'searching',
            timestamp: new Date(),
            note: reasonNote ? `Offer sent to driver (${candidateId}). ${reasonNote}` : `Offer sent to driver (${candidateId})`,
        });
        await order.save();

        await emitOfferToDriver(io, candidateId, {
            order_id: order._id,
            order_number: order.order_number,
            pickup: order.pickup,
            dropoff: order.dropoff,
            distance_km: order.distance_km,
            duration_min: order.duration_min,
            fare_total: order.fare?.total,
            commission_amount: order.fare?.commission_amount,
            commission_percent: order.fare?.commission_percent,
            driver_earnings: order.fare?.driver_earnings,
            payment_method: order.payment_method,
            vehicle_type: order.vehicle_type,
            goods_type: order.goods_type,
            goods_description: order.goods_description,
            city: order.city,
            offer_expires_at: order.offer_expires_at,
        });

        // Timeout handler: if not accepted in time, reject and move to next
        setTimeout(async () => {
            try {
                const fresh = await Order.findById(orderId);
                if (!fresh) return;
                if (fresh.status !== 'searching') return;
                if (!fresh.offered_driver_id) return;
                if (String(fresh.offered_driver_id) !== candidateId) return;
                if (fresh.offer_attempt !== attempt) return;
                if (offerExpiresMs(fresh.offer_expires_at) > Date.now()) return;

                if (!fresh.rejected_drivers?.map(String).includes(candidateId)) {
                    fresh.rejected_drivers.push(candidateId);
                }
                fresh.offered_driver_id = undefined;
                fresh.offer_expires_at = undefined;
                fresh.timeline.push({
                    status: 'searching',
                    timestamp: new Date(),
                    note: `Driver offer timed out (${candidateId}). Trying next driver.`,
                });
                await fresh.save();
                await dispatchNextDriver(orderId, io, 'Previous driver timed out.');
            } catch (err) {
                console.error('[dispatchNextDriver] Offer timeout handler error:', err.message);
            }
        }, OFFER_TTL_MS + 500);

        return;
    }

    // No candidates left: keep searching (auto-cancel timer may handle), inform user
    emitUserSearchingAgain(io, order.user_id?._id || order.user_id, order._id);
};

// Helper: generate 4-digit OTP
const generateOTP = () => Math.floor(1000 + Math.random() * 9000).toString();

// Helper: calculate fare (same logic as fareController but inline)
const calculateFare = async (pickup, dropoff, vehicle_type, vehicle_body_type) => {
    const distResult = await getDistanceAndDuration(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);
    if (!distResult.success) throw new Error('Failed to calculate distance');

    const geoResult = await reverseGeocode(pickup.lat, pickup.lng);
    const city = geoResult.success ? geoResult.city : 'default';

    // Same zone-aware lookup as the fare estimate endpoint:
    // zone pricing → city pricing → default pricing → any active pricing.
    const zone = await findZoneForPoint(pickup.lat, pickup.lng);
    const pricing = await findPricingForTrip({ zone, city, vehicle_type, vehicle_body_type });

    if (!pricing) {
        const error = new Error("We aren't in your area yet. Our team is working hard to expand our reach—stay tuned, we're coming soon!");
        error.code = 'OUT_OF_ZONE';
        error.status = 404;
        throw error;
    }

    const distance_km = distResult.distance_km;
    const travel_duration_min = distResult.duration_min;
    
    // Per User Request: Time fare applies only to LOADING TIME (Wait Time), not TRAVEL TIME.
    // For estimation, we use a default of 15 minutes of loading time.
    const ESTIMATED_LOADING_MINS = 15;
    const duration_min = ESTIMATED_LOADING_MINS; 

    if (pricing.max_distance_km > 0 && distance_km > pricing.max_distance_km) {
        const error = new Error(`Distance Limit Reached. We're sorry, but this trip exceeds our maximum service distance of ${pricing.max_distance_km} km. We hope to support longer routes soon!`);
        error.code = 'DISTANCE_LIMIT';
        error.status = 400;
        throw error;
    }
    const fare = computeTripFare(pricing, { distance_km, duration_min });

    return {
        distance_km: Math.round(distance_km * 10) / 10,
        duration_min: Math.round(duration_min),
        travel_duration_min: Math.round(travel_duration_min),
        city,
        fare: {
            ...fare,
            platform_fee: 0,
        },
    };
};

// ─── CREATE BOOKING (User) ────────────────────────────────────
const createBooking = async (req, res) => {
    const {
        pickup, dropoff, vehicle_type, vehicle_body_type,
        payment_method, goods_type, goods_description,
        is_scheduled, scheduled_at,
    } = req.body;

    if (!pickup?.address || !pickup?.lat || !pickup?.lng) {
        return res.status(400).json({ error: 'Pickup location is required' });
    }
    if (!dropoff?.address || !dropoff?.lat || !dropoff?.lng) {
        return res.status(400).json({ error: 'Dropoff location is required' });
    }
    if (!vehicle_type) {
        return res.status(400).json({ error: 'Vehicle type is required' });
    }

    try {
        // Calculate fare
        const fareResult = await calculateFare(pickup, dropoff, vehicle_type, vehicle_body_type);

        // Get route polyline
        const dirResult = await getDirections(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);

        // Generate OTPs
        const pickup_otp = generateOTP();
        const delivery_otp = generateOTP();

        const order = new Order({
            user_id: req.user.id,
            pickup,
            dropoff,
            vehicle_type,
            vehicle_body_type: vehicle_body_type || '',
            distance_km: fareResult.distance_km,
            duration_min: Math.round(Number(fareResult.duration_min) || 0),
            estimated_travel_mins: Math.round(Number(fareResult.travel_duration_min) || 0),
            route_polyline: dirResult.success ? dirResult.polyline : '',
            fare: fareResult.fare,
            payment_method: payment_method ? payment_method.toLowerCase() : 'cash',
            payment_status: 'pending',
            pickup_otp,
            delivery_otp,
            goods_type: goods_type || '',
            goods_description: goods_description || {},
            city: fareResult.city,
            status: 'searching',
            is_scheduled: is_scheduled || false,
            scheduled_at: scheduled_at || null,
            timeline: [{ status: 'searching', timestamp: new Date(), note: 'Looking for nearby drivers' }],
        });

        await order.save();

        // Emit event to find nearby drivers (Rapido-style one-by-one dispatch)
        const io = req.app.get('io');
        if (io) {
            // Unlock drivers stuck with is_on_trip=true but no active order (common after cancel/crash).
            await releaseStaleTripStateNearPickup(pickup.lat, pickup.lng, 15);

            // Find nearby available drivers
            const nearbyDrivers = await findNearbyDrivers(pickup.lat, pickup.lng, vehicle_type, DISPATCH_RADIUS_KM);
            
            // Store candidates (nearest-first) and start sequential offers
            console.log(`📡 [Booking] Dispatch candidates: ${nearbyDrivers.length} drivers (sequential)...`);
            if (nearbyDrivers.length === 0) {
                console.log('⚠️ [Booking] No drivers found matching filters (is_active, kyc_status, vehicle_type)');
            }

            order.dispatch_candidate_driver_ids = nearbyDrivers.map(d => d._id);
            order.dispatch_cursor = 0;
            order.offered_driver_id = undefined;
            order.offer_expires_at = undefined;
            order.offer_attempt = 0;
            await order.save();

            // Kick off the offer loop
            await dispatchNextDriver(order._id, io, 'Initial dispatch.');

            // Also emit to a general channel for monitoring
            io.emit('new_booking', {
                order_id: order._id,
                order_number: order.order_number,
                status: order.status,
                drivers_notified: 1,
            });
        }

        // Auto-cancel if no driver accepts within 3 minutes
        setTimeout(async () => {
            try {
                const checkOrder = await Order.findById(order._id);
                if (checkOrder && checkOrder.status === 'searching') {
                    checkOrder.status = 'cancelled';
                    checkOrder.cancelled_by = 'system';
                    checkOrder.cancellation_reason = 'No drivers available';
                    checkOrder.cancelled_at = new Date();
                    checkOrder.timeline.push({
                        status: 'cancelled',
                        timestamp: new Date(),
                        note: 'Auto-cancelled: No driver accepted',
                    });
                    await checkOrder.save();

                    if (io) {
                        const userId = checkOrder.user_id?._id || checkOrder.user_id;
                        if (userId) {
                            io.to(`user_${userId}`).emit('order_update', {
                                order_id: checkOrder._id,
                                status: 'cancelled',
                                cancelled_by: 'system',
                                cancellation_reason: 'No drivers available',
                            });
                        }
                    }
                }
            } catch (err) {
                console.error('[Order] Auto-cancel error:', err.message);
            }
        }, 3 * 60 * 1000); // 3 minutes

        return res.status(201).json({
            order,
            message: 'Booking created, searching for drivers...',
        });
    } catch (error) {
        console.error('[Order] Create Booking Error:', error.message);
        return res.status(error.status || 500).json({ 
            error: error.message,
            message: error.message,
            code: error.code || 'INTERNAL_ERROR' 
        });
    }
};

const reconcileSearchingOrderDispatch = async (order, io, options = {}) => {
    const { force = false } = options;
    if (!order || order.status !== 'searching' || !io || !order.pickup?.lat || !order.pickup?.lng) {
        return order;
    }

    const hasLiveOffer = order.offered_driver_id
        && order.offer_expires_at
        && offerExpiresMs(order.offer_expires_at) > Date.now();
    if (hasLiveOffer) return order;

    const key = String(order._id);
    if (!force) {
        const lastRetry = lastDispatchRetryRef.get(key) || 0;
        if (Date.now() - lastRetry < DISPATCH_RETRY_COOLDOWN_MS) return order;
    }
    lastDispatchRetryRef.set(key, Date.now());

    // Clear expired offer so dispatch can continue
    if (order.offered_driver_id) {
        order.offered_driver_id = undefined;
        order.offer_expires_at = undefined;
    }

    const candidates = order.dispatch_candidate_driver_ids || [];
    const cursor = order.dispatch_cursor || 0;
    const exhausted = candidates.length === 0 || cursor >= candidates.length;

    if (exhausted) {
        await releaseStaleTripStateNearPickup(order.pickup.lat, order.pickup.lng, DISPATCH_RADIUS_KM);
        const nearbyDrivers = await findNearbyDrivers(
            order.pickup.lat,
            order.pickup.lng,
            order.vehicle_type,
            DISPATCH_RADIUS_KM,
        );

        if (nearbyDrivers.length === 0) {
            console.log(`⚠️ [reconcileDispatch] No drivers for order ${key}`);
            await order.save();
            return order;
        }

        order.dispatch_candidate_driver_ids = nearbyDrivers.map((d) => d._id);
        order.dispatch_cursor = 0;
        order.offer_attempt = 0;
        order.timeline.push({
            status: 'searching',
            timestamp: new Date(),
            note: 'Re-dispatching after refreshing nearby drivers.',
        });
        await order.save();
    }

    await dispatchNextDriver(
        order._id,
        io,
        exhausted ? 'Re-dispatch retry.' : 'Continuing candidate queue.',
    );

    return Order.findById(order._id)
        .populate('user_id', 'name phone average_rating')
        .populate('driver_id', 'name phone vehicle_type vehicle_number average_rating location');
};

/** When a driver goes online, immediately try to match searching orders near them. */
const wakeSearchingOrdersNearDriver = async (driver, io, options = {}) => {
    const { force = false } = options;
    if (!driver?.is_active || !io) return;
    if (!(await isDriverDispatchable(driver))) return;

    const pos = getDriverLatLng(driver);
    if (!pos) return;

    const driverKey = String(driver._id);
    if (!force) {
        const lastWake = lastDriverWakeRef.get(driverKey) || 0;
        if (Date.now() - lastWake < DRIVER_WAKE_COOLDOWN_MS) return;
    }
    lastDriverWakeRef.set(driverKey, Date.now());

    try {
        const searchingOrders = await Order.find({ status: 'searching' }).limit(25);
        for (const order of searchingOrders) {
            if (!order.pickup?.lat || !order.pickup?.lng) continue;
            const dist = haversineKm(
                pos.lat,
                pos.lng,
                Number(order.pickup.lat),
                Number(order.pickup.lng),
            );
            if (dist > DISPATCH_RADIUS_KM) continue;
            if (order.vehicle_type && driver.vehicle_type
                && !new RegExp(`^${order.vehicle_type}$`, 'i').test(String(driver.vehicle_type))) {
                continue;
            }
            await reconcileSearchingOrderDispatch(order, io, { force: true });
        }
    } catch (err) {
        console.error('[wakeSearchingOrdersNearDriver] Error:', err.message);
    }
};

const filterDispatchableDrivers = async (drivers) => {
    const dispatchable = [];
    for (const driver of drivers) {
        if (await isDriverDispatchable(driver)) dispatchable.push(driver);
    }
    return dispatchable;
};

const mapDispatchableDrivers = async (drivers, mapper) => {
    const dispatchable = await filterDispatchableDrivers(drivers);
    return mapper(dispatchable);
};

// ─── FIND NEARBY DRIVERS ──────────────────────────────────────
const findNearbyDrivers = async (lat, lng, vehicle_type, radiusKm = 10) => {
    try {
        const statusFilter = {
            is_active: true,
            is_blocked: { $ne: true },
            kyc_status: { $regex: /approved/i },
        };
        if (vehicle_type) {
            statusFilter.vehicle_type = { $regex: new RegExp(`^${vehicle_type}$`, 'i') };
        }

        console.log(`📍 [findNearbyDrivers] Searching Redis for Origin: ${lat}, ${lng} (Radius: ${radiusKm}km)`);

        let nearbyDriverIds = [];
        try {
            // Priority 1: Redis Geospatial Search (Ultra Fast)
            nearbyDriverIds = await redis.georadius('drivers_locations', lng, lat, radiusKm, 'km');
        } catch (redisErr) {
            console.error('❌ [Redis GEORADIUS Error]:', redisErr.message);
        }

        let drivers = [];

        if (nearbyDriverIds.length > 0) {
            console.log(`✅ [findNearbyDrivers] Redis found ${nearbyDriverIds.length} candidate IDs.`);
            const redisDrivers = await Driver.find({
                _id: { $in: nearbyDriverIds.map(String) },
                ...statusFilter,
            })
                .limit(20)
                .select('_id name phone vehicle_type vehicle_number location latitude longitude average_rating fcm_token is_active kyc_status');

            const orderMap = new Map(redisDrivers.map((d) => [String(d._id), d]));
            drivers = nearbyDriverIds
                .map((id) => orderMap.get(String(id)))
                .filter(Boolean);

            if (drivers.length === 0) {
                console.log(`⚠️ [findNearbyDrivers] ${nearbyDriverIds.length} Redis candidates did not pass filters (online/KYC/vehicle_type).`);
            }
        }

        // Priority 2: DB fallback — rank all eligible online drivers by distance
        if (drivers.length === 0) {
            console.log('⚠️ [findNearbyDrivers] Falling back to distance-ranked driver search...');
            const eligible = await Driver.find(statusFilter)
                .limit(50)
                .select('_id name phone vehicle_type vehicle_number location latitude longitude average_rating fcm_token is_active kyc_status');

            drivers = rankDriversByDistance(eligible, parseFloat(lat), parseFloat(lng))
                .filter((driver) => {
                    const pos = getDriverLatLng(driver);
                    if (!pos) return false;
                    return haversineKm(parseFloat(lat), parseFloat(lng), pos.lat, pos.lng) <= radiusKm;
                });
        }

        // Priority 3: any matching online driver (testing / sparse areas)
        if (drivers.length === 0) {
            console.log('ℹ️ [findNearbyDrivers] No nearby drivers found. Using system-wide matching...');
            const fallbackDrivers = await Driver.find(statusFilter)
                .limit(20)
                .select('_id name phone vehicle_type vehicle_number location latitude longitude average_rating fcm_token');

            const ranked = rankDriversByDistance(fallbackDrivers, parseFloat(lat), parseFloat(lng));
            return mapDispatchableDrivers(ranked.slice(0, 5), (list) =>
                list.map((d) => ({ ...d.toObject(), is_fallback: true }))
            );
        }

        return mapDispatchableDrivers(drivers.slice(0, 10), (list) => list.map((d) => d.toObject()));
    } catch (error) {
        console.error('❌ [findNearbyDrivers] Fatal error:', error.message);
        return [];
    }
};

const getNearbyDriversForMap = async (req, res) => {
    try {
        const { lat, lng, vehicle_type, radius = 3 } = req.query;
        if (!lat || !lng) {
            return res.status(400).json({ error: 'Location (lat, lng) is required' });
        }

        const drivers = await findNearbyDrivers(
            parseFloat(lat), 
            parseFloat(lng), 
            vehicle_type, 
            parseFloat(radius)
        );

        res.status(200).json({ success: true, drivers });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

// ─── GET PENDING ORDERS (Driver Go Online Pull) ───────────────
const getPendingOrdersForDriver = async (req, res) => {
    const driver_id = req.driver.id;

    try {
        await releaseStaleDriverTripState(driver_id);

        const driver = await Driver.findById(driver_id);
        if (!driver) {
            return res.status(404).json({ error: 'Driver not found' });
        }

        const vehicle_type = driver.vehicle_type;

        // Rapido-style: driver should only see orders currently offered to them.
        const pendingFilter = {
            status: 'searching',
            offered_driver_id: String(driver_id),
        };
        if (vehicle_type) {
            pendingFilter.vehicle_type = { $regex: new RegExp(`^${vehicle_type}$`, 'i') };
        }
        const possibleOrders = await Order.find(pendingFilter).sort({ createdAt: 1 });

        const selectedOrder = possibleOrders.find(
            (o) => o.offer_expires_at && offerExpiresMs(o.offer_expires_at) > Date.now(),
        ) || null;

        return res.status(200).json({ pending_order: selectedOrder });
    } catch (error) {
        console.error('[Order] getPendingOrdersForDriver Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

// ─── ACCEPT ORDER (Driver) ────────────────────────────────────
const acceptOrder = async (req, res) => {
    const { order_id } = req.body;
    const driver_id = req.driver.id;

    try {
        const order = await Order.findById(order_id);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        if (order.status !== 'searching') {
            return res.status(400).json({ error: 'Order already accepted or cancelled' });
        }

        // Must be the currently offered driver (Rapido-style)
        if (!order.offered_driver_id || String(order.offered_driver_id) !== String(driver_id)) {
            return res.status(400).json({ error: 'This order is not offered to you' });
        }
        if (!order.offer_expires_at || offerExpiresMs(order.offer_expires_at) <= Date.now()) {
            return res.status(400).json({ error: 'Offer expired' });
        }

        const driverDoc = await Driver.findById(driver_id);
        if (!driverDoc) return res.status(404).json({ error: 'Driver not found' });
        if (!(await isDriverDispatchable(driverDoc))) {
            return res.status(400).json({ error: 'Driver already on another trip' });
        }

        // Check if driver was rejected
        if (order.rejected_drivers.includes(driver_id)) {
            return res.status(400).json({ error: 'You already rejected this order' });
        }

        // Assign driver
        order.driver_id = driver_id;
        order.status = 'accepted';
        // Clear dispatch fields
        order.offered_driver_id = undefined;
        order.offer_expires_at = undefined;
        order.timeline.push({
            status: 'accepted',
            timestamp: new Date(),
            note: 'Driver accepted the order',
        });
        await order.save();

        await setDriverTripState(driver_id, { onTrip: true, orderId: order._id });

        // Pre-generate payment QR so it is ready instantly at delivery (non-blocking)
        preloadDriverCollectionQR(order._id);

        // Get driver details for user notification
        const driver = await Driver.findById(driver_id).select('name phone vehicle_type vehicle_number average_rating location');

        const io = req.app.get('io');
        if (io) {
            // Notify user that driver accepted
            io.to(`user_${order.user_id._id || order.user_id}`).emit('order_update', {
                order_id: order._id,
                status: 'accepted',
                driver: {
                    _id: driver._id,
                    name: driver.name,
                    phone: driver.phone,
                    vehicle_type: driver.vehicle_type,
                    vehicle_number: driver.vehicle_number,
                    rating: driver.average_rating,
                    location: driver.location,
                },
                pickup_otp: order.pickup_otp,
            });

            // Notify admin
            io.emit('order_status_change', {
                order_id: order._id,
                order_number: order.order_number,
                status: 'accepted',
                driver_name: driver.name,
            });
        }

        return res.status(200).json({ order, driver });
    } catch (error) {
        console.error('[Order] Accept Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

// ─── REJECT ORDER (Driver) ───────────────────────────────────
const rejectOrder = async (req, res) => {
    const { order_id } = req.body;
    const driver_id = req.driver.id;

    try {
        const order = await Order.findById(order_id);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        // If this driver is currently offered, clear offer and move to next
        const wasOffered = order.offered_driver_id && String(order.offered_driver_id) === String(driver_id);

        if (!order.rejected_drivers.includes(driver_id)) {
            order.rejected_drivers.push(driver_id);
        }
        if (wasOffered) {
            order.offered_driver_id = undefined;
            order.offer_expires_at = undefined;
            order.timeline.push({
                status: 'searching',
                timestamp: new Date(),
                note: `Driver rejected offer (${driver_id}). Trying next driver.`,
            });
        }
        await order.save();

        const io = req.app.get('io');
        if (wasOffered && io) {
            await dispatchNextDriver(order._id, io, 'Previous driver rejected.');
        }

        return res.status(200).json({ message: 'Order rejected' });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// ─── VERIFY DELIVERY OTP (Driver — before payment collection) ─
const verifyDeliveryOtp = async (req, res) => {
    const { id } = req.params;
    const { otp } = req.body;

    try {
        const order = await Order.findById(id);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        if (String(order.driver_id?._id || order.driver_id) !== String(req.driver.id)) {
            return res.status(403).json({ error: 'Not your order' });
        }

        if (order.status !== 'in_transit') {
            return res.status(400).json({ error: 'OTP verification only during delivery' });
        }

        if (!otp || otp !== order.delivery_otp) {
            return res.status(400).json({ error: 'Invalid delivery OTP' });
        }

        return res.status(200).json({ verified: true });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// ─── UPDATE ORDER STATUS (Driver) ────────────────────────────
const updateOrderStatus = async (req, res) => {
    const { id } = req.params;
    const { status, otp, delivery_photo } = req.body;

    const validTransitions = {
        'accepted': ['driver_arrived', 'cancelled'],
        'driver_arrived': ['picked_up', 'cancelled'],
        'picked_up': ['in_transit'],
        'in_transit': ['delivered'],
    };

    try {
        const order = await Order.findById(id);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        // Validate status transition
        const allowed = validTransitions[order.status];
        if (!allowed || !allowed.includes(status)) {
            return res.status(400).json({
                error: `Cannot change from '${order.status}' to '${status}'`,
            });
        }

        // OTP verification for pickup
        if (status === 'picked_up') {
            if (!otp || otp !== order.pickup_otp) {
                return res.status(400).json({ error: 'Invalid pickup OTP' });
            }

            // --- RE-CALCULATE FINAL TIME FARE BASED ON ACTUAL LOADING TIME ---
            // Find "driver_arrived" timestamp in timeline
            const arrivedEntry = order.timeline.find(t => t.status === 'driver_arrived');
            const now = new Date();
            
            if (arrivedEntry) {
                const waitTimeMs = now - new Date(arrivedEntry.timestamp);
                const actualWaitMins = Math.max(1, Math.round(waitTimeMs / 60000));
                
                // Get Pricing for re-calc
                let pricing = await Pricing.findOne({
                    city: { $regex: new RegExp(`^${order.city}$`, 'i') },
                    vehicle_type: order.vehicle_type,
                    active: true,
                });

                if (pricing) {
                    const actualTimeFare = Math.round(actualWaitMins * (pricing.per_min_rate || 0));
                    
                    // Update order wait time stats
                    order.actual_wait_mins = actualWaitMins;

                    // Update order fare
                    order.fare.time_fare = actualTimeFare;
                    order.fare.subtotal = order.fare.base_fare + order.fare.distance_fare + actualTimeFare + (order.fare.loading_charges || 0);
                    
                    if (pricing.surge_active && pricing.surge_multiplier > 1) {
                        const surgeMul = pricing.surge_multiplier;
                        const surgeAmt = order.fare.subtotal * (surgeMul - 1);
                        order.fare.surge_amount = Math.round(surgeAmt);
                        order.fare.subtotal = Math.round(order.fare.subtotal * surgeMul);
                    }

                    order.fare.total = Math.max(Math.round(order.fare.subtotal), pricing.min_fare);
                    if (pricing.max_fare > 0) order.fare.total = Math.min(order.fare.total, pricing.max_fare);

                    const split = splitFareCommission(
                        order.fare.total,
                        pricing.platform_commission_percent || 15,
                    );
                    order.fare.commission_percent = split.commission_percent;
                    order.fare.commission_amount = split.commission_amount;
                    order.fare.driver_earnings = split.driver_earnings;

                    order.markModified('fare');
                }
            }
        }

        // OTP + payment verification for delivery
        if (status === 'delivered') {
            if (order.payment_status !== 'completed') {
                return res.status(400).json({ error: 'Collect payment before marking delivered' });
            }
            if (!otp || otp !== order.delivery_otp) {
                return res.status(400).json({ error: 'Invalid delivery OTP' });
            }
        }

        // Update order
        order.status = status;
        order.timeline.push({
            status,
            timestamp: new Date(),
            note: getStatusNote(status),
        });

        let walletSettlement = null;

        if (status === 'delivered') {
            if (delivery_photo) order.delivery_photo = delivery_photo;

            await setDriverTripState(order.driver_id, { onTrip: false });
            await Driver.findByIdAndUpdate(order.driver_id, {
                $inc: {
                    total_deliveries: 1,
                    total_earnings: order.fare.driver_earnings,
                },
            });

            walletSettlement = await settleDriverWalletOnDelivery(order);

            // Update user stats
            await User.findByIdAndUpdate(order.user_id, {
                $inc: { total_rides: 1 },
            });
        }

        if (status === 'cancelled') {
            order.cancelled_by = 'driver';
            order.cancellation_reason = req.body.reason || 'Driver cancelled';
            order.cancelled_at = new Date();

            await setDriverTripState(order.driver_id, { onTrip: false });

            // Rapido-style: if driver cancels before pickup, re-dispatch to next drivers
            if (['accepted', 'driver_arrived'].includes(order.status)) {
                const cancelledDriverId = order.driver_id;
                if (cancelledDriverId && !order.rejected_drivers.map(String).includes(String(cancelledDriverId))) {
                    order.rejected_drivers.push(cancelledDriverId);
                }
                order.driver_id = undefined;
                order.status = 'searching';
                order.cancelled_by = '';
                order.cancellation_reason = '';
                order.cancelled_at = undefined;
                order.offered_driver_id = undefined;
                order.offer_expires_at = undefined;
                order.timeline.push({
                    status: 'searching',
                    timestamp: new Date(),
                    note: 'Driver cancelled. Searching for another driver.',
                });
            }
        }

        await order.save();

        // Real-time notification
        const io = req.app.get('io');
        if (io) {
            const userId = order.user_id?._id || order.user_id;
            const driverCancelledBeforePickup = status === 'cancelled'
                && order.status === 'searching';

            if (userId) {
                io.to(`user_${userId}`).emit('order_update', {
                    order_id: order._id,
                    status: order.status,
                    cancelled_by: driverCancelledBeforePickup ? 'driver' : undefined,
                    cancellation_reason: driverCancelledBeforePickup
                        ? (req.body.reason || 'Driver cancelled')
                        : undefined,
                    message: driverCancelledBeforePickup
                        ? 'Your driver cancelled. Finding another driver...'
                        : undefined,
                    delivery_otp: status === 'in_transit' ? order.delivery_otp : undefined,
                });
            }

            io.emit('order_status_change', {
                order_id: order._id,
                order_number: order.order_number,
                status: order.status,
            });

            // Kick re-dispatch after save if needed
            if (order.status === 'searching' && !order.driver_id) {
                emitUserSearchingAgain(io, userId, order._id);
                await dispatchNextDriver(order._id, io, 'Re-dispatch after driver cancel.');
            }
        }

        const populated = await Order.findById(id).populate('user_id').populate('driver_id');
        const response = populated?.toObject ? populated.toObject() : populated;
        if (walletSettlement) {
            response.wallet_settlement = walletSettlement;
        }
        return res.status(200).json(response);
    } catch (error) {
        console.error('[Order] Update Status Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

// ─── CANCEL ORDER (User) ─────────────────────────────────────
const cancelOrder = async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    try {
        const order = await Order.findById(id);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        if (['delivered', 'cancelled'].includes(order.status)) {
            return res.status(400).json({ error: 'Cannot cancel this order' });
        }

        const offeredDriverId = resolveDriverId(order.offered_driver_id);
        const assignedDriverId = resolveDriverId(order.driver_id);

        order.status = 'cancelled';
        order.cancelled_by = 'user';
        order.cancellation_reason = reason || 'Cancelled by user';
        order.cancelled_at = new Date();
        order.offered_driver_id = undefined;
        order.offer_expires_at = undefined;
        order.timeline.push({
            status: 'cancelled',
            timestamp: new Date(),
            note: `User cancelled: ${reason || 'No reason specified'}`,
        });
        await order.save();

        // Free up assigned driver (after accept)
        if (assignedDriverId) {
            await setDriverTripState(assignedDriverId, { onTrip: false });
        }

        const io = req.app.get('io');
        const driversToNotify = [...new Set([offeredDriverId, assignedDriverId].filter(Boolean))];
        for (const driverId of driversToNotify) {
            await notifyDriverOrderCancelled(io, driverId, {
                order_id: order._id,
                reason: order.cancellation_reason || 'The customer cancelled this trip.',
                cancelled_by: 'user',
            });
        }

        if (io) {
            const userId = order.user_id?._id || order.user_id;
            if (userId) {
                io.to(`user_${userId}`).emit('order_update', {
                    order_id: order._id,
                    status: 'cancelled',
                    cancelled_by: 'user',
                    cancellation_reason: order.cancellation_reason,
                });
            }
            io.emit('order_status_change', {
                order_id: order._id,
                order_number: order.order_number,
                status: 'cancelled',
            });
        }

        return res.status(200).json(order);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// ─── RATE ORDER ───────────────────────────────────────────────
const rateOrder = async (req, res) => {
    const { id } = req.params;
    const { stars, comment, rated_by } = req.body; // rated_by: 'user' or 'driver'

    if (!stars || stars < 1 || stars > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    try {
        const order = await Order.findById(id);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        if (order.status !== 'delivered') {
            return res.status(400).json({ error: 'Can only rate delivered orders' });
        }

        if (rated_by === 'user') {
            order.user_rating = { stars, comment: comment || '', rated_at: new Date() };

            // Update driver's average rating
            if (order.driver_id) {
                const driver = await Driver.findById(order.driver_id);
                if (driver) {
                    const newTotal = driver.total_ratings + 1;
                    const newAvg = ((driver.average_rating * driver.total_ratings) + stars) / newTotal;
                    driver.average_rating = Math.round(newAvg * 10) / 10;
                    driver.total_ratings = newTotal;
                    await driver.save();
                }
            }
        } else if (rated_by === 'driver') {
            order.driver_rating = { stars, comment: comment || '', rated_at: new Date() };

            // Update user's average rating
            const user = await User.findById(order.user_id);
            if (user) {
                const newTotal = user.total_ratings + 1;
                const newAvg = ((user.average_rating * user.total_ratings) + stars) / newTotal;
                user.average_rating = Math.round(newAvg * 10) / 10;
                user.total_ratings = newTotal;
                await user.save();
            }
        }

        await order.save();
        return res.status(200).json(order);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// ─── GET ORDERS (various filters) ────────────────────────────
const getAllOrders = async (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const filter = {};
        if (status) filter.status = status;

        const orders = await Order.find(filter)
            .populate('user_id', 'name phone')
            .populate('driver_id', 'name phone vehicle_number')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit));

        const total = await Order.countDocuments(filter);

        return res.status(200).json({ orders, total, page: parseInt(page), totalPages: Math.ceil(total / limit) });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// GET user's orders
const getUserOrders = async (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const filter = { user_id: req.user.id };
        if (status) filter.status = status;

        const orders = await Order.find(filter)
            .populate('driver_id', 'name phone vehicle_type vehicle_number average_rating')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit));

        return res.status(200).json(orders);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// GET driver's orders
const getDriverOrders = async (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const filter = { driver_id: req.driver.id };
        if (status) filter.status = status;

        const orders = await Order.find(filter)
            .populate('user_id', 'name phone')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit));

        return res.status(200).json(orders);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// GET single order by ID
const getOrderById = async (req, res) => {
    try {
        const order = await Order.findById(req.params.id)
            .populate('user_id', 'name phone average_rating')
            .populate('driver_id', 'name phone vehicle_type vehicle_number average_rating location');

        if (!order) return res.status(404).json({ error: 'Order not found' });

        const io = req.app.get('io');
        if (order.status === 'searching' && io) {
            const refreshed = await reconcileSearchingOrderDispatch(order, io);
            if (refreshed) return res.status(200).json(refreshed);
        }

        return res.status(200).json(order);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// GET driver's active order
const getActiveOrder = async (req, res) => {
    try {
        const order = await Order.findOne({
            driver_id: req.driver.id,
            status: { $in: ['accepted', 'driver_arrived', 'picked_up', 'in_transit'] },
        })
            .populate('user_id', 'name phone')
            .sort({ createdAt: -1 });

        if (!order) {
            await releaseStaleDriverTripState(req.driver.id);
        }

        return res.status(200).json(order);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// GET user's active order
const getUserActiveOrder = async (req, res) => {
    try {
        const order = await Order.findOne({
            user_id: req.user.id,
            status: { $in: ['searching', 'accepted', 'driver_arrived', 'picked_up', 'in_transit'] },
        })
            .populate('driver_id', 'name phone vehicle_type vehicle_number average_rating location')
            .sort({ createdAt: -1 });

        return res.status(200).json(order);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// ─── Driver earnings helpers ───────────────────────────────────────────────
const IST_TZ = 'Asia/Kolkata';

const toPlainOrder = (order) => (order?.toObject ? order.toObject() : order);

const parseFare = (fare) => {
    if (!fare) return {};
    if (typeof fare === 'string') {
        try { return JSON.parse(fare); } catch { return {}; }
    }
    return fare;
};

const getOrderDriverEarnings = (order) => {
    const plain = toPlainOrder(order);
    const fare = parseFare(plain?.fare);
    const amount = fare.driver_earnings ?? fare.total ?? 0;
    return Math.round(Number(amount) * 100) / 100 || 0;
};

const getISTDateParts = (date = new Date()) => {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: IST_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value || '0';
    return {
        year: Number(get('year')),
        month: Number(get('month')),
        day: Number(get('day')),
    };
};

const isOrderInPeriod = (order, period) => {
    if (!period) return true;
    const plain = toPlainOrder(order);
    const deliveredAt = new Date(plain.updatedAt || plain.createdAt);
    if (Number.isNaN(deliveredAt.getTime())) return false;

    const delivered = getISTDateParts(deliveredAt);
    const now = getISTDateParts(new Date());

    if (period === 'today') {
        return delivered.year === now.year
            && delivered.month === now.month
            && delivered.day === now.day;
    }
    if (period === 'week') {
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        return deliveredAt >= weekAgo;
    }
    if (period === 'month') {
        return delivered.year === now.year && delivered.month === now.month;
    }
    return true;
};

// GET driver earnings summary
const getDriverEarnings = async (req, res) => {
    try {
        const driver_id = String(req.driver.id);
        const { period } = req.query; // 'today', 'week', 'month'

        const allDelivered = await Order.find({
            driver_id,
            status: 'delivered',
        }).sort({ updatedAt: -1 });

        const orders = (Array.isArray(allDelivered) ? allDelivered : [])
            .filter((o) => isOrderInPeriod(o, period));

        const totalEarnings = orders.reduce((sum, o) => sum + getOrderDriverEarnings(o), 0);
        const totalTrips = orders.length;
        const totalDistance = orders.reduce((sum, o) => {
            const plain = toPlainOrder(o);
            return sum + (Number(plain.distance_km) || 0);
        }, 0);

        const driver = await Driver.findById(driver_id).select('total_earnings wallet_balance total_deliveries average_rating');

        return res.status(200).json({
            total_earnings: Math.round(totalEarnings * 100) / 100,
            total_trips: totalTrips,
            total_distance_km: Math.round(totalDistance * 10) / 10,
            lifetime_earnings: Number(driver?.total_earnings) || 0,
            wallet_balance: Number(driver?.wallet_balance) || 0,
            lifetime_trips: Number(driver?.total_deliveries) || 0,
            average_rating: driver?.average_rating ?? 5,
            orders: orders.map(toPlainOrder),
        });
    } catch (error) {
        console.error('[getDriverEarnings] Error:', error);
        return res.status(500).json({ error: error.message });
    }
};

// GET driver wallet + passbook (Rapido-style)
const getDriverWallet = async (req, res) => {
    try {
        const driver_id = String(req.driver.id);
        const { period, limit = 50 } = req.query;

        const driver = await Driver.findById(driver_id).select('wallet_balance total_earnings total_deliveries');
        if (!driver) return res.status(404).json({ error: 'Driver not found' });

        let txQuery = WalletTransaction.find({ driver_id }).sort({ createdAt: -1 });
        if (limit) txQuery = txQuery.limit(Math.min(parseInt(limit, 10) || 50, 100));

        const allTx = await txQuery;
        const transactions = (Array.isArray(allTx) ? allTx : []).map((tx) => {
            const plain = tx?.toObject ? tx.toObject() : tx;
            return plain;
        });

        const filterTxByPeriod = (txList) => {
            if (!period) return txList;
            const now = new Date();
            return txList.filter((tx) => {
                const at = new Date(tx.createdAt || tx.created_at);
                if (Number.isNaN(at.getTime())) return false;
                if (period === 'today') return isOrderInPeriod({ updatedAt: at }, 'today');
                if (period === 'week') {
                    const weekAgo = new Date();
                    weekAgo.setDate(weekAgo.getDate() - 7);
                    return at >= weekAgo;
                }
                if (period === 'month') {
                    const parts = getISTDateParts(at);
                    const nowParts = getISTDateParts(now);
                    return parts.year === nowParts.year && parts.month === nowParts.month;
                }
                return true;
            });
        };

        const periodTx = filterTxByPeriod(transactions);
        const periodEarnings = periodTx.reduce((sum, tx) => sum + (Number(tx.driver_earnings) || 0), 0);
        const periodCommission = periodTx.reduce((sum, tx) => sum + (Number(tx.commission_amount) || 0), 0);

        return res.status(200).json({
            wallet_balance: Number(driver.wallet_balance) || 0,
            lifetime_earnings: Number(driver.total_earnings) || 0,
            lifetime_trips: Number(driver.total_deliveries) || 0,
            period: period || 'all',
            period_earnings: Math.round(periodEarnings * 100) / 100,
            period_commission: Math.round(periodCommission * 100) / 100,
            period_trips: periodTx.length,
            transactions: period ? periodTx : transactions,
        });
    } catch (error) {
        console.error('[getDriverWallet] Error:', error);
        return res.status(500).json({ error: error.message });
    }
};

// Helper
function getStatusNote(status) {
    const notes = {
        'driver_arrived': 'Driver arrived at pickup location',
        'picked_up': 'Goods picked up',
        'in_transit': 'On the way to delivery location',
        'delivered': 'Successfully delivered',
        'cancelled': 'Order cancelled',
    };
    return notes[status] || status;
}

// ─── GET ROUTE (Road Directions Polyline) ─────────────────────
const getRoute = async (req, res) => {
    try {
        const { origin_lat, origin_lng, dest_lat, dest_lng } = req.query;
        if (!origin_lat || !origin_lng || !dest_lat || !dest_lng) {
            return res.status(400).json({ error: 'origin_lat, origin_lng, dest_lat, dest_lng are required' });
        }

        const dirResult = await getDirections(
            parseFloat(origin_lat), parseFloat(origin_lng),
            parseFloat(dest_lat), parseFloat(dest_lng)
        );

        if (!dirResult.success) {
            return res.status(404).json({ success: false, error: dirResult.error || 'No route found' });
        }

        return res.status(200).json({
            success: true,
            polyline: dirResult.polyline,
            coordinates: dirResult.coordinates || [],
            distance_km: dirResult.distance_km,
            duration_min: Math.round(Number(dirResult.duration_min) || 0),
        });
    } catch (error) {
        console.error('[Order] getRoute Error:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
};

// ─── DELETE ORDER (Admin Only, Password Protected) ────────────
const deleteOrder = async (req, res) => {
    try {
        const { id } = req.params;
        const password = req.body.password || req.headers['x-delete-password'] || req.query.password;

        const correctPassword = process.env.DELETE_ORDER_PASSWORD;
        if (!correctPassword) {
            return res.status(500).json({ error: 'Database delete authorization password is not configured on the server.' });
        }

        if (password !== correctPassword) {
            return res.status(401).json({ error: 'Unauthorized: Invalid delete password' });
        }

        const order = await Order.findById(id);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        // Free up driver if they were assigned and the trip was active
        if (order.driver_id && ['accepted', 'driver_arrived', 'picked_up', 'in_transit'].includes(order.status)) {
            await setDriverTripState(order.driver_id, { onTrip: false });
        }

        // Clear any driver pointer to this order
        await Driver.updateMany({ current_order_id: String(id) }, { current_order_id: null });

        // Delete linked payments first (payments.order_id FK blocks order delete)
        await Payment.deleteMany({ order_id: String(id) });

        const deleted = await Order.findByIdAndDelete(id);
        if (!deleted) {
            return res.status(500).json({ error: 'Failed to delete order from database' });
        }

        // Real-time update to update any active admin UI
        const io = req.app.get('io');
        if (io) {
            io.emit('order_status_change', {
                order_id: id,
                status: 'deleted',
            });
        }

        return res.status(200).json({ success: true, message: 'Order permanently deleted' });
    } catch (error) {
        console.error('[Order] Delete Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

registerSearchingReconcile(reconcileSearchingOrderDispatch);

module.exports = {
    createBooking,
    acceptOrder,
    rejectOrder,
    verifyDeliveryOtp,
    updateOrderStatus,
    cancelOrder,
    rateOrder,
    getAllOrders,
    getUserOrders,
    getDriverOrders,
    getOrderById,
    getActiveOrder,
    getUserActiveOrder,
    getDriverEarnings,
    getDriverWallet,
    getNearbyDriversForMap,
    getPendingOrdersForDriver,
    wakeSearchingOrdersNearDriver,
    getRoute,
    deleteOrder,
};
