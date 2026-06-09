const Order = require('../models/Order');
const Driver = require('../models/Driver');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { getDistanceAndDuration, getDirections, reverseGeocode } = require('../services/googleMaps');
const Pricing = require('../models/Pricing');
const { redis } = require('../config/redis');

// ─── Dispatch Helpers (Rapido-style one-by-one) ──────────────────────────
const OFFER_TTL_MS = parseInt(process.env.DRIVER_OFFER_TTL_MS || '30000', 10); // 30s per driver

const offerExpiresMs = (value) => {
    if (!value) return 0;
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isNaN(ms) ? 0 : ms;
};

const emitOfferToDriver = async (io, driverId, payload) => {
    if (!io) return;
    io.to(`driver_${driverId}`).emit('new_order', payload);

    try {
        const { sendPushNotification } = require('../services/pushNotification');
        const pickupAddr = payload.pickup?.address || 'Nearby';
        const fare = payload.driver_earnings || payload.fare_total || 0;

        await sendPushNotification(
            driverId.toString(),
            'Driver',
            'New Delivery Request 🔔',
            `Pickup: ${pickupAddr}. Fare: ₹${fare}`,
            {
                type: 'new_order',
                orderId: payload.order_id?.toString()
            }
        );
    } catch (err) {
        console.error('[emitOfferToDriver] Error sending push notification:', err);
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
        if (!driver.is_active) continue;
        if (driver.is_on_trip || driver.current_order_id) continue;
        if (!/approved/i.test(driver.kyc_status || '')) continue;
        if (!new RegExp(`^${order.vehicle_type}$`, 'i').test(driver.vehicle_type || '')) continue;

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
            driver_earnings: order.fare?.driver_earnings,
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

    let pricing = await Pricing.findOne({
        city: { $regex: new RegExp(`^${city}$`, 'i') },
        vehicle_type,
        active: true,
    });

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
    const base_fare = pricing.base_fare;
    const distance_fare = distance_km * pricing.per_km_rate;
    const time_fare = duration_min * pricing.per_min_rate;
    const loading = pricing.loading_charges || 0;

    let subtotal = base_fare + distance_fare + time_fare + loading;
    let surge_multiplier = 1.0;
    let surge_amount = 0;

    if (pricing.surge_active && pricing.surge_multiplier > 1) {
        surge_multiplier = pricing.surge_multiplier;
        surge_amount = subtotal * (surge_multiplier - 1);
        subtotal *= surge_multiplier;
    }

    let total = Math.max(Math.round(subtotal), pricing.min_fare);
    if (pricing.max_fare > 0) total = Math.min(total, pricing.max_fare);

    const commission_percent = pricing.platform_commission_percent || 15;
    const commission_amount = Math.round(total * commission_percent / 100);

    return {
        distance_km: Math.round(distance_km * 10) / 10,
        duration_min: Math.round(duration_min),
        city,
        fare: {
            base_fare: Math.round(base_fare),
            distance_fare: Math.round(distance_fare),
            time_fare: Math.round(time_fare),
            loading_charges: Math.round(loading),
            surge_multiplier,
            surge_amount: Math.round(surge_amount),
            subtotal: Math.round(subtotal),
            platform_fee: 0,
            total,
            commission_percent,
            commission_amount,
            driver_earnings: total - commission_amount,
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
            duration_min: fareResult.duration_min,
            estimated_travel_mins: fareResult.travel_duration_min,
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
            // Find nearby available drivers
            const nearbyDrivers = await findNearbyDrivers(pickup.lat, pickup.lng, vehicle_type, 10);
            
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
                        io.emit(`order_update_${checkOrder.user_id}`, {
                            order_id: checkOrder._id,
                            status: 'cancelled',
                            reason: 'No drivers available',
                        });
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

// ─── FIND NEARBY DRIVERS ──────────────────────────────────────
const findNearbyDrivers = async (lat, lng, vehicle_type, radiusKm = 10) => {
    try {
        const statusFilter = {
            is_active: true,
            is_on_trip: { $ne: true },
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
            // Fetch full details from MongoDB for the candidates found in Redis
            drivers = await Driver.find({
                _id: { $in: nearbyDriverIds },
                ...statusFilter
            })
            .limit(10)
            .select('_id name phone vehicle_type vehicle_number location average_rating fcm_token');
        }

        // Priority 2: MongoDB Geospatial Fallback (If Redis returned no matches or is offline)
        if (drivers.length === 0) {
            console.log('⚠️ [findNearbyDrivers] Redis search yielding 0 results/failed. Falling back to MongoDB...');
            drivers = await Driver.find({
                ...statusFilter,
                location: {
                    $nearSphere: {
                        $geometry: {
                            type: 'Point',
                            coordinates: [parseFloat(lng), parseFloat(lat)],
                        },
                        $maxDistance: radiusKm * 1000, 
                    },
                },
            })
            .limit(10)
            .select('_id name phone vehicle_type vehicle_number location average_rating fcm_token');
        }

        // FALLBACK: If still no drivers found nearby, try finding any active matching driver in the whole system
        if (drivers.length === 0) {
            console.log('ℹ️ [findNearbyDrivers] No nearby drivers found. Checking system-wide matching...');
            const fallbackDrivers = await Driver.find(statusFilter)
                .limit(5)
                .select('_id name phone vehicle_type vehicle_number location average_rating fcm_token');
            
            return fallbackDrivers.map(d => ({ ...d.toObject(), is_fallback: true }));
        }

        return drivers.map(d => d.toObject());
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
        const driver = await Driver.findById(driver_id);
        if (!driver || !driver.location || !driver.location.coordinates) {
            return res.status(400).json({ error: 'Driver location missing' });
        }

        const [lng, lat] = driver.location.coordinates;
        const vehicle_type = driver.vehicle_type;

        // Rapido-style: driver should only see orders currently offered to them.
        const now = new Date();
        const possibleOrders = await Order.find({
            status: 'searching',
            offered_driver_id: driver_id,
            offer_expires_at: { $gt: now },
            vehicle_type: { $regex: new RegExp(`^${vehicle_type}$`, 'i') },
        }).sort({ createdAt: 1 });

        // Simple Haversine distance calc (optional safeguard) to filter those within 10km radius
        let selectedOrder = null;
        for (const o of possibleOrders) {
            if (o.pickup && o.pickup.lat && o.pickup.lng) {
                const pLat = o.pickup.lat;
                const pLng = o.pickup.lng;
                
                // Haversine formula
                const R = 6371; // km
                const dLat = (pLat - lat) * Math.PI / 180;
                const dLon = (pLng - lng) * Math.PI / 180;
                const a = 
                    Math.sin(dLat / 2) * Math.sin(dLat/2) +
                    Math.cos(lat * Math.PI / 180) * Math.cos(pLat * Math.PI / 180) * 
                    Math.sin(dLon/2) * Math.sin(dLon/2);
                const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                const distance = R * c;

                if (distance <= 10) {
                    selectedOrder = o;
                    break;
                }
            }
        }

        if (selectedOrder) {
            return res.status(200).json({ pending_order: selectedOrder });
        } else {
            return res.status(200).json({ pending_order: null });
        }
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

        // Driver must be available (not on another trip)
        const driverDoc = await Driver.findById(driver_id).select('is_on_trip current_order_id');
        if (!driverDoc) return res.status(404).json({ error: 'Driver not found' });
        if (driverDoc.is_on_trip || driverDoc.current_order_id) {
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

        // Update driver status
        await Driver.findByIdAndUpdate(driver_id, {
            is_on_trip: true,
            current_order_id: order._id,
        });

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

                    // Update commission and earnings
                    const commPercent = pricing.platform_commission_percent || 15;
                    order.fare.commission_amount = Math.round(order.fare.total * commPercent / 100);
                    order.fare.driver_earnings = order.fare.total - order.fare.commission_amount;
                    
                    order.markModified('fare');
                }
            }
        }

        // OTP verification for delivery
        if (status === 'delivered') {
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

        if (status === 'delivered') {
            order.payment_status = order.payment_method === 'cash' ? 'completed' : order.payment_status;
            if (delivery_photo) order.delivery_photo = delivery_photo;

            // Update driver stats
            await Driver.findByIdAndUpdate(order.driver_id, {
                is_on_trip: false,
                current_order_id: null,
                $inc: {
                    total_deliveries: 1,
                    total_earnings: order.fare.driver_earnings,
                },
            });

            // Update user stats
            await User.findByIdAndUpdate(order.user_id, {
                $inc: { total_rides: 1 },
            });
        }

        if (status === 'cancelled') {
            order.cancelled_by = 'driver';
            order.cancellation_reason = req.body.reason || 'Driver cancelled';
            order.cancelled_at = new Date();

            await Driver.findByIdAndUpdate(order.driver_id, {
                is_on_trip: false,
                current_order_id: null,
            });

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
            io.emit(`order_update_${order.user_id}`, {
                order_id: order._id,
                status: order.status,
                delivery_otp: status === 'in_transit' ? order.delivery_otp : undefined,
            });

            io.emit('order_status_change', {
                order_id: order._id,
                order_number: order.order_number,
                status: order.status,
            });

            // Kick re-dispatch after save if needed
            if (order.status === 'searching' && !order.driver_id) {
                emitUserSearchingAgain(io, order.user_id?._id || order.user_id, order._id);
                await dispatchNextDriver(order._id, io, 'Re-dispatch after driver cancel.');
            }
        }

        const populated = await Order.findById(id).populate('user_id').populate('driver_id');
        return res.status(200).json(populated);
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

        const offeredDriverId = order.offered_driver_id ? String(order.offered_driver_id) : null;
        const assignedDriverId = order.driver_id ? String(order.driver_id) : null;

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
            await Driver.findByIdAndUpdate(assignedDriverId, {
                is_on_trip: false,
                current_order_id: null,
            });
        }

        const io = req.app.get('io');
        const driversToNotify = [...new Set([offeredDriverId, assignedDriverId].filter(Boolean))];
        if (io && driversToNotify.length > 0) {
            for (const driverId of driversToNotify) {
                io.to(`driver_${driverId}`).emit(`order_cancelled_${driverId}`, {
                    order_id: order._id,
                    reason: order.cancellation_reason,
                });
            }
        }

        if (io) {
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

// GET driver earnings summary
const getDriverEarnings = async (req, res) => {
    try {
        const driver_id = req.driver.id;
        const { period } = req.query; // 'today', 'week', 'month'

        let dateFilter = {};
        const now = new Date();

        // Use updatedAt (delivery time) so completed trips count in the correct period
        if (period === 'today') {
            dateFilter = {
                updatedAt: {
                    $gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
                },
            };
        } else if (period === 'week') {
            const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            dateFilter = { updatedAt: { $gte: weekAgo } };
        } else if (period === 'month') {
            dateFilter = {
                updatedAt: {
                    $gte: new Date(now.getFullYear(), now.getMonth(), 1),
                },
            };
        }

        const completedOrders = await Order.find({
            driver_id,
            status: 'delivered',
            ...dateFilter,
        }).sort({ createdAt: -1 });

        const totalEarnings = completedOrders.reduce((sum, o) => sum + (o.fare.driver_earnings || 0), 0);
        const totalTrips = completedOrders.length;
        const totalDistance = completedOrders.reduce((sum, o) => sum + (o.distance_km || 0), 0);

        return res.status(200).json({
            total_earnings: totalEarnings,
            total_trips: totalTrips,
            total_distance_km: Math.round(totalDistance * 10) / 10,
            orders: completedOrders,
        });
    } catch (error) {
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
            distance_km: dirResult.distance_km,
            duration_min: dirResult.duration_min,
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
            await Driver.findByIdAndUpdate(order.driver_id, {
                is_on_trip: false,
                current_order_id: null,
            });
        }

        // Permanently delete order
        await Order.findByIdAndDelete(id);

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

module.exports = {
    createBooking,
    acceptOrder,
    rejectOrder,
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
    getNearbyDriversForMap,
    getPendingOrdersForDriver,
    getRoute,
    deleteOrder,
};
