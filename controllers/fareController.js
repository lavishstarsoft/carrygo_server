const Pricing = require('../models/Pricing');
const DeliveryZone = require('../models/DeliveryZone');
const { getDistanceAndDuration, reverseGeocode, geocodeAddress, getPlaceDetails, getAutocompleteSuggestions } = require('../services/googleMaps');
const { computeTripFare } = require('../services/fareCalculation');

// ─── Geometry Helpers ────────────────────────────────────────────────────────

/**
 * Calculate distance between two points in meters (Haversine formula approximation)
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; 
}

/**
 * Check if a point is inside a polygon
 */
function isPointInPolygon(lat, lng, polygon) {
    let inside = false;
    const n = polygon.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = polygon[i].lng, yi = polygon[i].lat;
        const xj = polygon[j].lng, yj = polygon[j].lat;
        const intersect = ((yi > lat) !== (yj > lat)) &&
            (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

/**
 * Check if a point is in the specified zone (Polygon or Circle)
 */
function isPointInZone(lat, lng, zone) {
    if (zone.type === 'circle' && zone.center && zone.radius) {
        return calculateDistance(lat, lng, zone.center.lat, zone.center.lng) <= zone.radius;
    }
    if (zone.type === 'polygon' && zone.coordinates?.length >= 3) {
        return isPointInPolygon(lat, lng, zone.coordinates);
    }
    return false;
}

/**
 * Find the matching delivery zone for a coordinate
 */
const findZoneForPoint = async (lat, lng) => {
    try {
        const zones = await DeliveryZone.find({ isActive: true });
        for (const zone of zones) {
            if (isPointInZone(lat, lng, zone)) return zone;
        }
        return null;
    } catch (error) {
        console.error('[ZoneDetection] Error:', error.message);
        return null;
    }
};

const findPricingForTrip = async ({ zone, city, vehicle_type, vehicle_body_type }) => {
    const bodyType = vehicle_body_type || 'all';

    if (zone?._id) {
        const zonePricing = await Pricing.findOne({
            delivery_zone: zone._id,
            vehicle_type,
            vehicle_body_type: bodyType,
            active: true,
        });
        if (zonePricing) return zonePricing;
    }

    if (city) {
        const cityPricing = await Pricing.findOne({
            city: { $regex: new RegExp(`^${city}$`, 'i') },
            vehicle_type,
            vehicle_body_type: bodyType,
            active: true,
            delivery_zone: null,
        });
        if (cityPricing) return cityPricing;
    }

    const defaultPricing = await Pricing.findOne({
        city: { $regex: /^default$/i },
        vehicle_type,
        vehicle_body_type: bodyType,
        active: true,
        delivery_zone: null,
    });
    if (defaultPricing) return defaultPricing;

    // Last resort: use any active pricing for this vehicle type
    return Pricing.findOne({
        vehicle_type,
        vehicle_body_type: bodyType,
        active: true,
    });
};

/**
 * POST /api/fare/estimate
 * Calculate fare estimate for a trip (Uber/Ola Style)
 */
const estimateFare = async (req, res) => {
    const { pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, vehicle_type, vehicle_body_type } = req.body;

    if (!pickup_lat || !pickup_lng || !dropoff_lat || !dropoff_lng || !vehicle_type) {
        return res.status(400).json({ error: 'pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, vehicle_type are required' });
    }

    try {
        // Step 1: Get distance (Google Maps with Haversine fallback)
        const distResult = await getDistanceAndDuration(pickup_lat, pickup_lng, dropoff_lat, dropoff_lng);

        if (!distResult.success) {
            return res.status(400).json({ error: distResult.error || 'Failed to calculate distance' });
        }

        if (distResult.source === 'estimated') {
            console.warn('[Fare] Using estimated distance fallback (Google Maps unavailable)');
        }

        // Step 2: Detect Zone for pickup
        const zone = await findZoneForPoint(pickup_lat, pickup_lng);
        
        // Step 3: Get city from pickup location
        const geoResult = await reverseGeocode(pickup_lat, pickup_lng);
        const city = geoResult.success ? geoResult.city : 'default';

        // Step 4: Find pricing (zone → city → default → any active)
        const pricing = await findPricingForTrip({ zone, city, vehicle_type, vehicle_body_type });

        if (!pricing) {
            return res.status(404).json({ 
                success: false,
                code: 'OUT_OF_ZONE',
                message: "We aren't in your area yet. Our team is working hard to expand our reach—stay tuned, we're coming soon!" 
            });
        }

        const distance_km = distResult.distance_km;
        const travel_duration_min = distResult.duration_min;

        // Per User Request: Time fare applies only to LOADING TIME (Wait Time), not TRAVEL TIME.
        // For estimation, we use a default of 15 minutes of loading time.
        const ESTIMATED_LOADING_MINS = 15;
        const duration_min = ESTIMATED_LOADING_MINS; 

        // Step 5: Distance Limit Check (Service Boundary)
        if (pricing.max_distance_km > 0 && distance_km > pricing.max_distance_km) {
            return res.status(400).json({ 
                success: false,
                code: 'DISTANCE_LIMIT',
                message: `Distance Limit Reached. We're sorry, but this trip exceeds our maximum service distance of ${pricing.max_distance_km} km. We hope to support longer routes soon!` 
            });
        }

        const fare = computeTripFare(pricing, { distance_km, duration_min });
        const billable_km = Math.max(0, distance_km - (pricing.base_km || 0));

        const fareEstimate = {
            distance_km: Math.round(distance_km * 10) / 10,
            billable_km: Math.round(billable_km * 10) / 10,
            distance_text: distResult.distance_text,
            duration_min: Math.round(duration_min),
            duration_text: distResult.duration_text,
            estimated_travel_mins: Math.round(travel_duration_min),
            city,
            zone: zone ? zone.name : 'Default City Zone',
            vehicle_type,
            fare,
            surge_active: fare.surge_multiplier > 1,
            surge_reason: pricing.surge_reason || (fare.surge_multiplier > 1 ? 'High Demand' : ''),
        };

        return res.status(200).json(fareEstimate);
    } catch (error) {
        console.error('[Fare] Estimate Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

/**
 * GET /api/fare/pricing
 * Get all pricing configurations (admin)
 */
const getAllPricing = async (req, res) => {
    try {
        const { city, vehicle_type, zone_id } = req.query;
        const filter = {};
        if (city) filter.city = { $regex: new RegExp(city, 'i') };
        if (vehicle_type) filter.vehicle_type = vehicle_type;
        if (zone_id) filter.delivery_zone = zone_id;

        const pricing = await Pricing.find(filter)
            .populate('delivery_zone', 'name')
            .sort({ city: 1, vehicle_type: 1 });
        return res.status(200).json(pricing);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

/**
 * POST /api/fare/pricing
 * Create or update pricing (admin)
 */
const upsertPricing = async (req, res) => {
    const {
        city, vehicle_type, vehicle_body_type, delivery_zone,
        base_fare, base_km, per_km_rate, per_min_rate, min_fare, max_fare, max_distance_km,
        loading_charges, unloading_charges,
        surge_multiplier, surge_active, surge_reason,
        peak_hours, platform_commission_percent, active
    } = req.body;

    if (!city || !vehicle_type) {
        return res.status(400).json({ error: 'city and vehicle_type are required' });
    }

    try {
        const filter = {
            city: { $regex: new RegExp(`^${city}$`, 'i') },
            vehicle_type,
            vehicle_body_type: vehicle_body_type || 'all',
            delivery_zone: delivery_zone || null,
        };

        const update = {
            city, vehicle_type,
            vehicle_body_type: vehicle_body_type || 'all',
            delivery_zone: delivery_zone || null,
        };

        if (base_fare !== undefined) update.base_fare = base_fare;
        if (base_km !== undefined) update.base_km = base_km;
        if (per_km_rate !== undefined) update.per_km_rate = per_km_rate;
        if (per_min_rate !== undefined) update.per_min_rate = per_min_rate;
        if (min_fare !== undefined) update.min_fare = min_fare;
        if (max_fare !== undefined) update.max_fare = max_fare;
        if (max_distance_km !== undefined) update.max_distance_km = max_distance_km;
        if (loading_charges !== undefined) update.loading_charges = loading_charges;
        if (unloading_charges !== undefined) update.unloading_charges = unloading_charges;
        if (surge_multiplier !== undefined) update.surge_multiplier = surge_multiplier;
        if (surge_active !== undefined) update.surge_active = surge_active;
        if (surge_reason !== undefined) update.surge_reason = surge_reason;
        if (peak_hours !== undefined) update.peak_hours = peak_hours;
        if (platform_commission_percent !== undefined) update.platform_commission_percent = platform_commission_percent;
        if (active !== undefined) update.active = active;

        const pricing = await Pricing.findOneAndUpdate(filter, update, { upsert: true, new: true });
        return res.status(200).json(pricing);
    } catch (error) {
        console.error('[Fare] Upsert Pricing Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

/**
 * PUT /api/fare/surge
 * Toggle surge pricing for a city + vehicle type (admin)
 */
const toggleSurge = async (req, res) => {
    const { city, vehicle_type, surge_active, surge_multiplier, surge_reason } = req.body;

    if (!city || !vehicle_type) {
        return res.status(400).json({ error: 'city and vehicle_type are required' });
    }

    try {
        const result = await Pricing.updateMany(
            {
                city: { $regex: new RegExp(`^${city}$`, 'i') },
                vehicle_type,
            },
            {
                surge_active: surge_active !== undefined ? surge_active : true,
                surge_multiplier: surge_multiplier || 1.5,
                surge_reason: surge_reason || 'High Demand',
            }
        );

        return res.status(200).json({ message: 'Surge updated', modified: result.modifiedCount });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

/**
 * DELETE /api/fare/pricing/:id
 * Delete a pricing entry (admin)
 */
const deletePricing = async (req, res) => {
    try {
        const pricing = await Pricing.findByIdAndDelete(req.params.id);
        if (!pricing) return res.status(404).json({ error: 'Pricing not found' });
        return res.status(200).json({ message: 'Pricing deleted' });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

/**
 * GET /api/fare/geocode
 * Proxy to Google Geocoding API to prevent native iOS/Android Geocoder failures
 */
const geocode = async (req, res) => {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'Address is required' });

    try {
        const result = await geocodeAddress(address);
        if (!result.success) return res.status(400).json({ error: result.error });
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

/**
 * GET /api/fare/place-details
 * Resolve a Google place_id to exact lat/lng (after suggestion tap)
 */
const placeDetails = async (req, res) => {
    const { place_id } = req.query;
    if (!place_id) return res.status(400).json({ error: 'place_id is required' });

    try {
        const result = await getPlaceDetails(place_id);
        if (!result.success) return res.status(400).json({ error: result.error });
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

/**
 * GET /api/fare/autocomplete
 * Get address suggestions from Google Places
 */
const autocomplete = async (req, res) => {
    const { input, lat, lng, city } = req.query;
    if (!input) return res.status(400).json({ error: 'Input query is required' });

    try {
        const result = await getAutocompleteSuggestions(input, {
            lat: lat != null ? Number(lat) : undefined,
            lng: lng != null ? Number(lng) : undefined,
            city: typeof city === 'string' ? city.trim() : undefined,
        });
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

/**
 * Delivery Zone Management
 */
const getZones = async (req, res) => {
    try {
        const zones = await DeliveryZone.find().sort({ createdAt: -1 });
        res.status(200).json(zones);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const upsertZone = async (req, res) => {
    const { id, _id, name, type, coordinates, center, radius, color, isActive, delivery_fee, min_order, free_delivery_above, est_delivery_time } = req.body;
    try {
        let zone;
        const targetId = id || _id;
        const updateData = { name, type, coordinates, center, radius, color, isActive, delivery_fee, min_order, free_delivery_above, est_delivery_time };
        
        if (targetId) {
            zone = await DeliveryZone.findByIdAndUpdate(targetId, updateData, { new: true });
        } else {
            zone = await DeliveryZone.create(updateData);
        }
        res.status(200).json(zone);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const deleteZone = async (req, res) => {
    try {
        await DeliveryZone.findByIdAndDelete(req.params.id);
        // Also delete associated pricing to keep DB clean
        await Pricing.deleteMany({ delivery_zone: req.params.id });
        res.status(200).json({ message: 'Zone and associated pricing deleted' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    estimateFare,
    findZoneForPoint,
    findPricingForTrip,
    getAllPricing,
    upsertPricing,
    toggleSurge,
    deletePricing,
    geocode,
    placeDetails,
    autocomplete,
    getZones,
    upsertZone,
    deleteZone,
};
