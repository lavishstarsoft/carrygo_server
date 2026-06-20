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

const LOCAL_RADIUS_KM = 45;
const AUTOCOMPLETE_CACHE_TTL_MS = 5 * 60 * 1000;
const NOMINATIM_MIN_INTERVAL_MS = 1100;

// When Google rejects requests (e.g. billing disabled), skip Google for a while
// so every search doesn't pay a ~400ms failed round-trip before the fallback.
const GOOGLE_DISABLED_BACKOFF_MS = 10 * 60 * 1000;
let googleDisabledUntil = 0;

const isGoogleUsable = () => Boolean(GOOGLE_MAPS_API_KEY) && Date.now() >= googleDisabledUntil;

const markGoogleRejected = (status) => {
    if (status === 'REQUEST_DENIED' || status === 'OVER_QUERY_LIMIT') {
        googleDisabledUntil = Date.now() + GOOGLE_DISABLED_BACKOFF_MS;
        console.warn(`[GoogleMaps] ${status} — skipping Google APIs for 10 minutes (fallback active)`);
    }
};

const autocompleteCache = new Map();
let lastNominatimRequestAt = 0;
let nominatimQueue = Promise.resolve();

const getAutocompleteCacheKey = (input, lat, lng, city) =>
    `${(input || '').trim().toLowerCase()}|${lat ?? ''}|${lng ?? ''}|${(city || '').toLowerCase()}`;

const readAutocompleteCache = (key) => {
    const hit = autocompleteCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > AUTOCOMPLETE_CACHE_TTL_MS) {
        autocompleteCache.delete(key);
        return null;
    }
    return hit.value;
};

const writeAutocompleteCache = (key, value) => {
    autocompleteCache.set(key, { at: Date.now(), value });
    if (autocompleteCache.size > 300) {
        const oldest = autocompleteCache.keys().next().value;
        autocompleteCache.delete(oldest);
    }
};

const runWithNominatimRateLimit = (task) => {
    nominatimQueue = nominatimQueue.then(async () => {
        const waitMs = Math.max(0, NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastNominatimRequestAt));
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        lastNominatimRequestAt = Date.now();
        return task();
    });
    return nominatimQueue;
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

const SEARCH_STOP_WORDS = new Set(['in', 'the', 'and', 'near', 'road', 'rd', 'st', 'at']);

const normalizeSearchInput = (input = '') => input
    .replace(/\bcollage\b/gi, 'college')
    .replace(/\bcollag\b/gi, 'college')
    .replace(/\s+/g, ' ')
    .trim();

const getQueryTokens = (query = '') => normalizeSearchInput(query)
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token));

const getSearchVariants = (input, city) => {
    const normalized = normalizeSearchInput(input);
    if (!normalized) return [];

    const variants = [normalized];
    const words = normalized.split(/\s+/).filter(Boolean);
    const acronyms = words.filter((word) => word.length <= 5 && /^[a-z0-9&'.-]+$/i.test(word));

    if (acronyms.length > 0) {
        variants.push(acronyms.join(' '));
        if (city) variants.push(`${acronyms[0]} ${city}`);
    }

    if (words.length > 2) {
        variants.push(words.slice(0, 2).join(' '));
    }

    return [...new Set(variants.map((v) => v.trim()).filter(Boolean))].slice(0, 3);
};

const buildLocalQuery = (input, city) => {
    const trimmed = normalizeSearchInput(input);
    if (!trimmed) return trimmed;
    if (!city) return trimmed;
    const cityLower = city.toLowerCase();
    if (trimmed.toLowerCase().includes(cityLower)) return trimmed;
    return `${trimmed}, ${city}, India`;
};

const dedupeSuggestions = (items) => {
    const seen = new Set();
    return items.filter((item) => {
        const key = item.place_id || item.description;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

const rankLocalSuggestions = (suggestions, { lat, lng, city, query = '' }) => {
    if (!suggestions.length) return [];

    const cityLower = city ? city.toLowerCase() : null;
    const tokens = getQueryTokens(query);

    const ranked = suggestions.map((s) => {
        let score = 0;
        const text = `${s.description || ''} ${s.secondary_text || ''}`.toLowerCase();
        const mainText = `${s.main_text || ''}`.toLowerCase();

        if (cityLower && text.includes(cityLower)) score += 100;

        tokens.forEach((token) => {
            if (mainText.includes(token)) score += 140;
            else if (text.includes(token)) score += 50;
            if (mainText.startsWith(token)) score += 80;
        });

        if (lat != null && lng != null && s.lat != null && s.lng != null) {
            const dist = haversineKm(lat, lng, s.lat, s.lng);
            s.distance_km = Math.round(dist * 10) / 10;
            if (dist <= LOCAL_RADIUS_KM) score += 80;
            score += Math.max(0, 50 - dist);
        } else {
            s.distance_km = null;
        }

        return { ...s, _score: score };
    });

    // Keep results that actually match the typed query, but DO NOT drop far-away
    // places. Distance/city only affect ranking (via _score above), so the user
    // sees every matching location — like Google Maps / Rapido / Uber search.
    const tokenMatched = ranked.filter((s) => {
        if (!tokens.length) return true;
        const mainText = `${s.main_text || ''}`.toLowerCase();
        const text = `${s.description || ''}`.toLowerCase();
        return tokens.some((token) => mainText.includes(token) || text.includes(token));
    });

    const pool = tokenMatched.length > 0 ? tokenMatched : ranked;
    return dedupeSuggestions(
        pool.sort((a, b) => b._score - a._score),
    )
        .slice(0, 8)
        .map(({ _score, ...rest }) => rest);
};

const mapPhotonResults = (features = [], query = '') => features.map((feature) => {
    const props = feature.properties || {};
    const [lon, lat] = feature.geometry?.coordinates || [];
    const parts = [props.name, props.street, props.city, props.state, props.country]
        .filter(Boolean);
    const description = parts.join(', ') || query;
    return {
        description,
        place_id: `photon-${props.osm_id || description}`,
        main_text: props.name || parts[0] || query,
        secondary_text: parts.slice(1).join(', '),
        lat: Number(lat),
        lng: Number(lon),
    };
}).filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng));

const photonSearch = async (query, { lat, lng, city } = {}) => {
    const searchQuery = buildLocalQuery(query, city);
    const params = {
        q: searchQuery,
        limit: 12,
        lang: 'en',
    };

    if (lat != null && lng != null) {
        params.lat = lat;
        params.lon = lng;
    }

    const response = await axios.get('https://photon.komoot.io/api/', {
        params,
        timeout: 8000,
    });

    return mapPhotonResults(response.data?.features, searchQuery);
};

const nominatimSearch = async (query, { lat, lng, city, strict = false } = {}) => {
    const searchQuery = buildLocalQuery(query, city);
    const params = {
        q: searchQuery,
        format: 'json',
        addressdetails: 1,
        limit: 10,
        countrycodes: 'in',
    };

    if (lat != null && lng != null) {
        const delta = strict ? 0.1 : 0.22;
        params.viewbox = `${lng - delta},${lat + delta},${lng + delta},${lat - delta}`;
        params.bounded = strict ? 1 : 0;
    }

    const response = await runWithNominatimRateLimit(() => axios.get('https://nominatim.openstreetmap.org/search', {
        params,
        headers: NOMINATIM_HEADERS,
        timeout: 8000,
        validateStatus: (status) => status < 500,
    }));

    if (response.status === 429) {
        const err = new Error('Nominatim rate limited');
        err.code = 'RATE_LIMITED';
        throw err;
    }

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
const decodePolyline = (encoded) => {
    const points = [];
    let index = 0;
    const len = encoded.length;
    let lat = 0;
    let lng = 0;

    while (index < len) {
        let shift = 0;
        let result = 0;
        let b;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
        lat += dlat;

        shift = 0;
        result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
        lng += dlng;

        points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
    }

    return points;
};

const mergeStepCoordinates = (route) => {
    const merged = [];
    const legs = route?.legs || [];

    legs.forEach((leg) => {
        (leg.steps || []).forEach((step) => {
            const encoded = step?.polyline?.points;
            if (!encoded) return;
            const segment = decodePolyline(encoded);
            segment.forEach((point) => {
                const prev = merged[merged.length - 1];
                if (
                    !prev
                    || Math.abs(prev.latitude - point.latitude) > 1e-6
                    || Math.abs(prev.longitude - point.longitude) > 1e-6
                ) {
                    merged.push(point);
                }
            });
        });
    });

    return merged;
};

const encodeSignedNumber = (num) => {
    let sgn = num << 1;
    if (num < 0) sgn = ~sgn;
    let output = '';
    while (sgn >= 0x20) {
        output += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
        sgn >>= 5;
    }
    output += String.fromCharCode(sgn + 63);
    return output;
};

const encodePolyline = (coordinates = []) => {
    let lastLat = 0;
    let lastLng = 0;
    let result = '';
    coordinates.forEach((point) => {
        const lat = Math.round(point.latitude * 1e5);
        const lng = Math.round(point.longitude * 1e5);
        result += encodeSignedNumber(lat - lastLat);
        result += encodeSignedNumber(lng - lastLng);
        lastLat = lat;
        lastLng = lng;
    });
    return result;
};

const OSRM_BASE_URL = (process.env.OSRM_BASE_URL || 'https://router.project-osrm.org').replace(/\/$/, '');

/** OpenStreetMap road routing via OSRM (free, follows real roads). */
const getOsrmDirections = async (originLat, originLng, destLat, destLng) => {
    try {
        const response = await axios.get(
            `${OSRM_BASE_URL}/route/v1/driving/${originLng},${originLat};${destLng},${destLat}`,
            {
                params: {
                    overview: 'full',
                    geometries: 'polyline',
                    steps: true,
                },
                timeout: 10000,
            },
        );

        const data = response.data;
        if (data.code !== 'Ok' || !data.routes?.[0]) {
            console.warn('[OSRM] Route unavailable:', data.code, data.message || '');
            return null;
        }

        const route = data.routes[0];
        const encoded = route.geometry || '';
        const coordinates = encoded ? decodePolyline(encoded) : [];
        if (coordinates.length < 2) return null;

        return {
            success: true,
            polyline: encoded,
            coordinates,
            distance_km: (route.distance || 0) / 1000,
            duration_min: (route.duration || 0) / 60,
            source: 'osrm',
        };
    } catch (error) {
        console.warn('[OSRM] Directions error:', error.message);
        return null;
    }
};

const resolveDirectionsFallback = async (originLat, originLng, destLat, destLng) => {
    const osrm = await getOsrmDirections(originLat, originLng, destLat, destLng);
    if (osrm) {
        console.log(`[Directions] OSRM road route: ${osrm.coordinates.length} points, ${osrm.distance_km.toFixed(2)} km`);
        return osrm;
    }
    console.warn('[Directions] OSRM unavailable — using straight-line estimate');
    return buildStraightLineRoute(originLat, originLng, destLat, destLng);
};

/** Straight-line densified route — last resort only. */
const buildStraightLineRoute = (originLat, originLng, destLat, destLng) => {
    const estimate = estimateDrivingDistance(originLat, originLng, destLat, destLng);
    const steps = Math.max(24, Math.min(100, Math.round(estimate.distance_km * 12)));
    const coordinates = [];
    for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        coordinates.push({
            latitude: originLat + (destLat - originLat) * t,
            longitude: originLng + (destLng - originLng) * t,
        });
    }
    return {
        success: true,
        polyline: encodePolyline(coordinates),
        coordinates,
        distance_km: estimate.distance_km,
        duration_min: estimate.duration_min,
        source: 'estimated',
    };
};

const getDirections = async (originLat, originLng, destLat, destLng) => {
    if (!GOOGLE_MAPS_API_KEY) {
        console.warn('[GoogleMaps] No API key — using OSRM road routing');
        return resolveDirectionsFallback(originLat, originLng, destLat, destLng);
    }

    try {
        const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
            params: {
                origin: `${originLat},${originLng}`,
                destination: `${destLat},${destLng}`,
                key: GOOGLE_MAPS_API_KEY,
                mode: 'driving',
                alternatives: false,
            },
        });

        const data = response.data;

        if (data.status !== 'OK' || !data.routes[0]) {
            console.warn('[GoogleMaps] Google failed, trying OSRM:', data.status, data.error_message || '');
            return resolveDirectionsFallback(originLat, originLng, destLat, destLng);
        }

        const route = data.routes[0];
        const leg = route.legs[0];
        const coordinates = mergeStepCoordinates(route);
        const fallbackCoordinates = route.overview_polyline?.points
            ? decodePolyline(route.overview_polyline.points)
            : [];

        return {
            success: true,
            polyline: route.overview_polyline.points,
            coordinates: coordinates.length > 1 ? coordinates : fallbackCoordinates,
            distance_km: leg.distance.value / 1000,
            duration_min: leg.duration.value / 60,
            start_address: leg.start_address,
            end_address: leg.end_address,
            source: 'google',
            steps: leg.steps.map(step => ({
                instruction: step.html_instructions?.replace(/<[^>]*>/g, '') || '',
                distance: step.distance.text,
                duration: step.duration.text,
            })),
        };
    } catch (error) {
        console.error('[GoogleMaps] Directions error, trying OSRM:', error.message);
        return resolveDirectionsFallback(originLat, originLng, destLat, destLng);
    }
};

/**
 * Resolve a Google place_id to exact coordinates (Place Details API).
 * Used when the user taps a Google autocomplete suggestion — more accurate
 * and faster than re-geocoding the address text.
 */
const getPlaceDetails = async (placeId) => {
    if (!isGoogleUsable()) {
        return { success: false, error: 'Google Places unavailable' };
    }
    try {
        const response = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
            params: {
                place_id: placeId,
                fields: 'geometry,formatted_address,name',
                key: GOOGLE_MAPS_API_KEY,
            },
            timeout: 5000,
        });
        const data = response.data;
        if (data.status === 'OK' && data.result?.geometry?.location) {
            return {
                success: true,
                lat: data.result.geometry.location.lat,
                lng: data.result.geometry.location.lng,
                formatted_address: data.result.formatted_address || data.result.name,
            };
        }
        markGoogleRejected(data.status);
        return { success: false, error: data.status };
    } catch (error) {
        console.warn('[GoogleMaps] Place Details Error:', error.message);
        return { success: false, error: error.message };
    }
};

/**
 * Geocode an address to lat/lng
 */
const geocodeAddress = async (address) => {
    if (isGoogleUsable()) {
        try {
            const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
                params: {
                    address,
                    key: GOOGLE_MAPS_API_KEY,
                    region: 'in',
                },
                timeout: 5000,
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
            markGoogleRejected(data.status);
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
 * Reverse geocode lat/lng to get a detailed formatted address (no locality restriction)
 */
const reverseGeocodeDetailed = async (lat, lng) => {
    if (GOOGLE_MAPS_API_KEY) {
        try {
            const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
                params: {
                    latlng: `${lat},${lng}`,
                    key: GOOGLE_MAPS_API_KEY,
                },
            });

            const data = response.data;
            if (data.status === 'OK' && data.results[0]) {
                const result = data.results[0];
                const components = result.address_components || [];
                
                // Try to find point of interest/landmark name
                const poiTypes = ['establishment', 'point_of_interest', 'premise', 'subpremise', 'landmark', 'park', 'airport', 'bus_station', 'train_station'];
                let title = null;
                for (const type of poiTypes) {
                    const comp = components.find(c => c.types.includes(type));
                    if (comp) {
                        title = comp.long_name;
                        break;
                    }
                }
                
                // If not found, try to find street/road name
                if (!title) {
                    const route = components.find(c => c.types.includes('route'));
                    if (route) title = route.long_name;
                }
                
                // If not found, try to find neighborhood name
                if (!title) {
                    const sublocality = components.find(c => c.types.includes('sublocality') || c.types.includes('sublocality_level_1'));
                    if (sublocality) title = sublocality.long_name;
                }

                // If still not found, fallback to first part of address
                if (!title) {
                    title = result.formatted_address.split(',')[0];
                }

                return {
                    success: true,
                    formatted_address: result.formatted_address,
                    title: title,
                };
            }
            markGoogleRejected(data.status);
        } catch (error) {
            console.warn('[GoogleMaps] Detailed reverse geocode error:', error.message);
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
        const title = address.amenity || address.shop || address.building || address.road || address.suburb || address.neighbourhood || address.city || '';

        return {
            success: true,
            formatted_address: response.data?.display_name || '',
            title: title || (response.data?.display_name || '').split(',')[0],
        };
    } catch (error) {
        console.error('[Nominatim] Detailed reverse geocode Error:', error.message);
        return { success: false, error: error.message };
    }
};

/**
 * Get address suggestions from Google Places Autocomplete API
 */
const getAutocompleteSuggestions = async (input, options = {}) => {
    let { lat, lng, city } = options;
    const cacheKey = getAutocompleteCacheKey(input, lat, lng, city);
    const cached = readAutocompleteCache(cacheKey);
    if (cached) return cached;

    if (lat != null && lng != null && !city) {
        const geo = await reverseGeocode(lat, lng);
        if (geo.success && geo.city) city = geo.city;
    }

    const finish = (suggestions, source) => {
        const payload = {
            success: true,
            suggestions,
            city: city || null,
            source,
        };
        writeAutocompleteCache(cacheKey, payload);
        return payload;
    };

    if (isGoogleUsable()) {
        try {
            // Use the raw user input (not city-appended) so Google returns ALL matching
            // places across India — like Google Maps / Rapido / Uber search.
            const params = {
                input: normalizeSearchInput(input) || input,
                key: GOOGLE_MAPS_API_KEY,
                components: 'country:in',
                language: 'en',
            };

            // Bias results toward the user's area WITHOUT hard-restricting them.
            // No strictbounds => nearby places rank first, but distant places still appear.
            if (lat != null && lng != null) {
                params.location = `${lat},${lng}`;
                params.radius = 50000;
            }

            const response = await axios.get('https://maps.googleapis.com/maps/api/place/autocomplete/json', {
                params,
                timeout: 5000,
            });
            const data = response.data;

            if (data.status === 'OK') {
                const suggestions = rankLocalSuggestions(
                    data.predictions.map(p => ({
                        description: p.description,
                        place_id: p.place_id,
                        main_text: p.structured_formatting.main_text,
                        secondary_text: p.structured_formatting.secondary_text,
                    })),
                    { lat, lng, city, query: input },
                );
                return finish(suggestions, 'google');
            }

            if (data.status === 'ZERO_RESULTS') {
                return finish([], 'google');
            }

            markGoogleRejected(data.status);
            console.warn('[GoogleMaps] Autocomplete fallback:', data.status);
        } catch (error) {
            console.warn('[GoogleMaps] Autocomplete fallback:', error.message);
        }
    }

    try {
        const variants = getSearchVariants(input, city);
        let photonSuggestions = [];
        for (const variant of variants) {
            const batch = await photonSearch(variant, { lat, lng, city });
            photonSuggestions = dedupeSuggestions([...photonSuggestions, ...batch]);
        }
        if (photonSuggestions.length > 0) {
            return finish(
                rankLocalSuggestions(photonSuggestions, { lat, lng, city, query: input }),
                'photon',
            );
        }
    } catch (error) {
        console.warn('[Photon] Autocomplete fallback:', error.message);
    }

    try {
        const suggestions = rankLocalSuggestions(
            await nominatimSearch(input, { lat, lng, city, strict: false }),
            { lat, lng, city, query: input },
        );
        return finish(suggestions, 'nominatim');
    } catch (error) {
        if (error.code === 'RATE_LIMITED') {
            console.warn('[Nominatim] Autocomplete rate limited, returning empty suggestions');
            return { success: true, suggestions: [], city: city || null, source: 'rate_limited' };
        }
        console.error('[Nominatim] Autocomplete Error:', error.message);
        return { success: false, error: error.message, suggestions: [] };
    }
};

module.exports = {
    getDistanceAndDuration,
    getDirections,
    geocodeAddress,
    getPlaceDetails,
    reverseGeocode,
    reverseGeocodeDetailed,
    getAutocompleteSuggestions,
};
