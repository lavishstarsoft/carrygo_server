/** Shared fare math — keep user estimate, booking, and wallet in sync. */

const applySurge = (subtotal, pricing) => {
    let surge_multiplier = pricing.surge_multiplier || 1.0;
    let surge_amount = 0;

    if (pricing.surge_active && surge_multiplier > 1) {
        surge_amount = subtotal * (surge_multiplier - 1);
        subtotal *= surge_multiplier;
    } else if (pricing.peak_hours?.length > 0) {
        const now = new Date();
        const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const peakHour = pricing.peak_hours.find((ph) => currentTime >= ph.start && currentTime <= ph.end);
        if (peakHour) {
            surge_multiplier = peakHour.multiplier;
            surge_amount = subtotal * (surge_multiplier - 1);
            subtotal *= surge_multiplier;
        }
    }

    return { subtotal, surge_multiplier, surge_amount };
};

const computeTripFare = (pricing, { distance_km, duration_min }) => {
    const base_fare = pricing.base_fare;
    const billable_km = Math.max(0, distance_km - (pricing.base_km || 0));
    const distance_fare = billable_km * pricing.per_km_rate;
    const time_fare = duration_min * pricing.per_min_rate;
    const loading = pricing.loading_charges || 0;

    let subtotal = base_fare + distance_fare + time_fare + loading;
    const surge = applySurge(subtotal, pricing);
    subtotal = surge.subtotal;

    let total = Math.max(Math.round(subtotal), pricing.min_fare);
    if (pricing.max_fare > 0) total = Math.min(total, pricing.max_fare);
    total = Math.round(total);

    const commission_percent = pricing.platform_commission_percent || 15;
    const commission_amount = Math.round(total * commission_percent / 100);

    return {
        base_fare: Math.round(base_fare),
        base_km: pricing.base_km || 0,
        distance_fare: Math.round(distance_fare),
        time_fare: Math.round(time_fare),
        loading_charges: Math.round(loading),
        surge_multiplier: surge.surge_multiplier,
        surge_amount: Math.round(surge.surge_amount),
        subtotal: Math.round(subtotal),
        total,
        commission_percent,
        commission_amount,
        driver_earnings: total - commission_amount,
    };
};

/** Normalize commission split from total (fixes stale driver_earnings). */
const splitFareCommission = (total, commissionPercent = 15) => {
    const safeTotal = Math.round(Number(total) || 0);
    const pct = Number(commissionPercent) || 15;
    const commission_amount = Math.round(safeTotal * pct / 100);
    return {
        total: safeTotal,
        commission_percent: pct,
        commission_amount,
        driver_earnings: safeTotal - commission_amount,
    };
};

module.exports = {
    applySurge,
    computeTripFare,
    splitFareCommission,
};
