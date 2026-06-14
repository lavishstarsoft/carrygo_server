const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const MARKER_COLORS = {
    idle: 'green',
    on_trip: 'blue',
    alert: 'orange',
    offline: 'gray',
    blocked: 'red',
};

/**
 * GET /api/maps/fleet-static
 * Server-side Static Maps proxy — works with the same key used for Directions API.
 */
const getFleetStaticMap = async (req, res) => {
    try {
        if (!GOOGLE_MAPS_API_KEY) {
            return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY not configured' });
        }

        let points = [];
        try {
            points = JSON.parse(req.query.points || '[]');
        } catch {
            return res.status(400).json({ error: 'Invalid points JSON' });
        }

        const valid = (Array.isArray(points) ? points : [])
            .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
            .slice(0, 40);

        const size = String(req.query.size || '800x400').replace(/[^0-9x]/g, '');
        const zoom = Math.min(18, Math.max(3, Number(req.query.zoom) || 12));

        const params = new URLSearchParams({
            size,
            zoom: String(zoom),
            maptype: 'roadmap',
            key: GOOGLE_MAPS_API_KEY,
        });

        if (valid.length > 0) {
            const centerLat = valid.reduce((s, p) => s + p.lat, 0) / valid.length;
            const centerLng = valid.reduce((s, p) => s + p.lng, 0) / valid.length;
            params.set('center', `${centerLat},${centerLng}`);
            for (const point of valid) {
                const color = MARKER_COLORS[point.ops_status] || 'gray';
                params.append('markers', `color:${color}|${point.lat},${point.lng}`);
            }
        } else {
            params.set('center', '16.5062,80.6480');
        }

        const mapUrl = `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
        const upstream = await fetch(mapUrl);

        if (!upstream.ok) {
            const text = await upstream.text().catch(() => '');
            return res.status(502).json({
                error: 'Static map request failed',
                detail: text.slice(0, 200),
            });
        }

        const contentType = upstream.headers.get('content-type') || 'image/png';
        const buffer = Buffer.from(await upstream.arrayBuffer());
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'no-store');
        return res.send(buffer);
    } catch (error) {
        console.error('[Maps] getFleetStaticMap Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

module.exports = { getFleetStaticMap };
