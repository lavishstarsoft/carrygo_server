const axios = require('axios');

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

/**
 * Get distance and duration between two points using Google Maps Distance Matrix API
 */
const getDistanceAndDuration = async (originLat, originLng, destLat, destLng) => {
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
            console.error('[GoogleMaps] API Error:', data.status);
            return { success: false, error: 'Failed to calculate distance' };
        }

        const element = data.rows[0].elements[0];

        if (element.status !== 'OK') {
            console.error('[GoogleMaps] Element Error:', element.status);
            return { success: false, error: 'Route not found' };
        }

        return {
            success: true,
            distance_km: element.distance.value / 1000,      // Convert meters to km
            distance_text: element.distance.text,
            duration_min: element.duration.value / 60,        // Convert seconds to minutes
            duration_text: element.duration.text,
        };
    } catch (error) {
        console.error('[GoogleMaps] Distance Matrix Error:', error.message);
        return { success: false, error: error.message };
    }
};

/**
 * Get directions (route polyline) between two points
 */
const getDirections = async (originLat, originLng, destLat, destLng) => {
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
    try {
        const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
            params: {
                address,
                key: GOOGLE_MAPS_API_KEY,
                region: 'in',
            },
        });

        const data = response.data;
        if (data.status !== 'OK' || !data.results[0]) {
            return { success: false, error: 'Address not found' };
        }

        const result = data.results[0];
        return {
            success: true,
            lat: result.geometry.location.lat,
            lng: result.geometry.location.lng,
            formatted_address: result.formatted_address,
        };
    } catch (error) {
        console.error('[GoogleMaps] Geocode Error:', error.message);
        return { success: false, error: error.message };
    }
};

/**
 * Reverse geocode lat/lng to get city name
 */
const reverseGeocode = async (lat, lng) => {
    try {
        const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
            params: {
                latlng: `${lat},${lng}`,
                key: GOOGLE_MAPS_API_KEY,
                result_type: 'locality',
            },
        });

        const data = response.data;
        if (data.status !== 'OK' || !data.results[0]) {
            return { success: false, error: 'Location not found' };
        }

        const cityComponent = data.results[0].address_components.find(
            c => c.types.includes('locality')
        );

        return {
            success: true,
            city: cityComponent?.long_name || '',
            formatted_address: data.results[0].formatted_address,
        };
    } catch (error) {
        console.error('[GoogleMaps] Reverse Geocode Error:', error.message);
        return { success: false, error: error.message };
    }
};

/**
 * Get address suggestions from Google Places Autocomplete API
 */
const getAutocompleteSuggestions = async (input) => {
    try {
        const response = await axios.get('https://maps.googleapis.com/maps/api/place/autocomplete/json', {
            params: {
                input,
                key: GOOGLE_MAPS_API_KEY,
                components: 'country:in',
                language: 'en',
            },
        });

        const data = response.data;
        if (data.status !== 'OK') {
            return { success: false, error: data.status, suggestions: [] };
        }

        return {
            success: true,
            suggestions: data.predictions.map(p => ({
                description: p.description,
                place_id: p.place_id,
                main_text: p.structured_formatting.main_text,
                secondary_text: p.structured_formatting.secondary_text,
            })),
        };
    } catch (error) {
        console.error('[GoogleMaps] Autocomplete Error:', error.message);
        return { success: false, error: error.message };
    }
};

module.exports = {
    getDistanceAndDuration,
    getDirections,
    geocodeAddress,
    reverseGeocode,
    getAutocompleteSuggestions,
};
