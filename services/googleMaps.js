const axios = require('axios');

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const NOMINATIM_HEADERS = { 'User-Agent': 'CarryGoo-Delivery-App/1.0 (support@carrygoo.in)' };

const haversineKm = (lat1, lon1, lat2, lon2) => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const estimateDrivingDistance = (originLat, originLng, destLat, destLng) => {
    const straightKm = haversineKm(originLat, originLng, destLat, destLng);
    const distanceKm = Math.max(0.5, straightKm * 1.35);
    const durationMin = Math.max(5, (distanceKm / 25) * 60);
    return {
        success: true,
        distance_km: distanceKm,
        distance_text: `${distanceKm.toFixed(1)} km`,
        duration_min: durationMin,
        duration_text: `${Math.round(durationMin)} mins`,
        source: 'estimated',
    };
};

const mapNominatimResults = (results = []) => results.map((r) => {
    const parts = (r.display_name || '').split(',').map((p) => p.trim()).filter(Boolean);
    return {
        description: r.display_name,
        place_id: String(r.place_id),
        main_text: r.name || parts[0] || r.display_name,
        secondary_text: parts.slice(1).join(', '),
        lat: Number(r.lat),
        lng: Number(r.lon),
    };
});

const nominatimSearch = async (query, { lat, lng } = {}) => {
    const params = {
        q: query,
        format: 'json',
        addressdetails: 1,
        limit: 6,
        countrycodes: 'in',
    };

    if (lat != null && lng != null) {
        const delta = 0.35;
        params.viewbox = `${lng - delta},${lat + delta},${lng + delta},${lat - delta}`;
        params.bounded = 0;
    }

    const response = await axios.get('https://nominatim.openstreetmap.org/search', {
        params,
        headers: NOMINATIM_HEADERS,
        timeout: 8000,
    });

    return mapNominatimResults(response.data);
};

/**
 * Get distance and duration between two points using Google Maps Distance Matrix API
 */
const getDistanceAndDuration = async (originLat, originLng, destLat, destLng) => {
    if (!GOOGLE_MAPS_API_KEY) {
        return estimateDrivingDistance(originLat, originLng, destLat, destLng);
    }

    try {
        const response = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
            params: {
                origins: `${originLat},${originLng}`,
                destinations: `${destLat},${destLng}`,
                key: GOOGLE_MAPS_API_KEY,
                units: 'metric',
                mode: 'driving',
            },
        });

        const data = response.data;

        if (data.status !== 'OK' || !data.rows[0]?.elements[0]) {
            console.warn('[GoogleMaps] Distance Matrix fallback:', data.status);
            return estimateDrivingDistance(originLat, originLng, destLat, destLng);
        }

        const element = data.rows[0].elements[0];

        if (element.status !== 'OK') {
            console.warn('[GoogleMaps] Element fallback:', element.status);
            return estimateDrivingDistance(originLat, originLng, destLat, destLng);
        }

        return {
            success: true,
            distance_km: element.distance.value / 1000,
            distance_text: element.distance.text,
            duration_min: element.duration.value / 60,
            duration_text: element.duration.text,
            source: 'google',
        };
    } catch (error) {
        console.error('[GoogleMaps] Distance Matrix Error:', error.message);
        return estimateDrivingDistance(originLat, originLng, destLat, destLng);
    }
};

/**
 * Get directions (route polyline) between two points
 */
const getDirections = async (originLat, originLng, destLat, destLng) => {
    if (!GOOGLE_MAPS_API_KEY) {
        return { success: false, error: 'Directions unavailable' };
    }

    try {
        const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
            params: {
                origin: `${originLat},${originLng}`,
                destination: `${destLat},${destLng}`,
                key: GOOGLE_MAPS_API_KEY,
                mode: 'driving',
            },
        });

        const data = response.data;

        if (data.status !== 'OK' || !data.routes[0]) {
            return { success: false, error: 'No route found' };
        }

        const route = data.routes[0];
        const leg = route.legs[0];

        return {
            success: true,
            polyline: route.overview_polyline.points,
            distance_km: leg.distance.value / 1000,
            duration_min: leg.duration.value / 60,
            start_address: leg.start_address,
            end_address: leg.end_address,
            steps: leg.steps.map(step => ({
                instruction: step.html_instructions?.replace(/<[^>]*>/g, '') || '',
                distance: step.distance.text,
                duration: step.duration.text,
            })),
        };
    } catch (error) {
        console.error('[GoogleMaps] Directions Error:', error.message);
        return { success: false, error: error.message };
    }
};

/**
 * Geocode an address to lat/lng
 */
const geocodeAddress = async (address) => {
    if (GOOGLE_MAPS_API_KEY) {
        try {
            const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
                params: {
                    address,
                    key: GOOGLE_MAPS_API_KEY,
                    region: 'in',
                },
            });

            const data = response.data;
            if (data.status === 'OK' && data.results[0]) {
                const result = data.results[0];
                return {
                    success: true,
                    lat: result.geometry.location.lat,
                    lng: result.geometry.location.lng,
                    formatted_address: result.formatted_address,
                };
            }
        } catch (error) {
            console.warn('[GoogleMaps] Geocode fallback:', error.message);
        }
    }

    try {
        const suggestions = await nominatimSearch(address);
        if (!suggestions.length) {
            return { success: false, error: 'Address not found' };
        }
        const best = suggestions[0];
        return {
            success: true,
            lat: best.lat,
            lng: best.lng,
            formatted_address: best.description,
        };
    } catch (error) {
        console.error('[Nominatim] Geocode Error:', error.message);
        return { success: false, error: error.message };
    }
};

/**
 * Reverse geocode lat/lng to get city name
 */
const reverseGeocode = async (lat, lng) => {
    if (GOOGLE_MAPS_API_KEY) {
        try {
            const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
                params: {
                    latlng: `${lat},${lng}`,
                    key: GOOGLE_MAPS_API_KEY,
                    result_type: 'locality',
                },
            });

            const data = response.data;
            if (data.status === 'OK' && data.results[0]) {
                const cityComponent = data.results[0].address_components.find(
                    c => c.types.includes('locality')
                );

                return {
                    success: true,
                    city: cityComponent?.long_name || '',
                    formatted_address: data.results[0].formatted_address,
                };
            }
        } catch (error) {
            console.warn('[GoogleMaps] Reverse geocode fallback:', error.message);
        }
    }

    try {
        const response = await axios.get('https://nominatim.openstreetmap.org/reverse', {
            params: {
                lat,
                lon: lng,
                format: 'json',
                addressdetails: 1,
            },
            headers: NOMINATIM_HEADERS,
            timeout: 8000,
        });

        const address = response.data?.address || {};
        const city = address.city || address.town || address.village || address.state_district || address.state || 'default';

        return {
            success: true,
            city,
            formatted_address: response.data?.display_name || '',
        };
    } catch (error) {
        console.error('[Nominatim] Reverse Geocode Error:', error.message);
        return { success: false, error: error.message };
    }
};

/**
 * Get address suggestions from Google Places Autocomplete API
 */
const getAutocompleteSuggestions = async (input, options = {}) => {
    const { lat, lng } = options;

    if (GOOGLE_MAPS_API_KEY) {
        try {
            const params = {
                input,
                key: GOOGLE_MAPS_API_KEY,
                components: 'country:in',
                language: 'en',
            };

            if (lat != null && lng != null) {
                params.location = `${lat},${lng}`;
                params.radius = 50000;
                params.strictbounds = false;
            }

            const response = await axios.get('https://maps.googleapis.com/maps/api/place/autocomplete/json', { params });
            const data = response.data;

            if (data.status === 'OK') {
                return {
                    success: true,
                    suggestions: data.predictions.map(p => ({
                        description: p.description,
                        place_id: p.place_id,
                        main_text: p.structured_formatting.main_text,
                        secondary_text: p.structured_formatting.secondary_text,
                    })),
                };
            }

            if (data.status === 'ZERO_RESULTS') {
                return { success: true, suggestions: [] };
            }

            console.warn('[GoogleMaps] Autocomplete fallback:', data.status);
        } catch (error) {
            console.warn('[GoogleMaps] Autocomplete fallback:', error.message);
        }
    }

    try {
        const suggestions = await nominatimSearch(input, { lat, lng });
        return { success: true, suggestions };
    } catch (error) {
        console.error('[Nominatim] Autocomplete Error:', error.message);
        return { success: false, error: error.message, suggestions: [] };
    }
};

module.exports = {
    getDistanceAndDuration,
    getDirections,
    geocodeAddress,
    reverseGeocode,
    getAutocompleteSuggestions,
};
