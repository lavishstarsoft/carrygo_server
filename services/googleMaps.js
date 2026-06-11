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

    if (GOOGLE_MAPS_API_KEY) {
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

            const response = await axios.get('https://maps.googleapis.com/maps/api/place/autocomplete/json', { params });
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
    reverseGeocode,
    getAutocompleteSuggestions,
};
