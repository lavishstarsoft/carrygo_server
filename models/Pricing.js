const mongoose = require('mongoose');

const pricingSchema = new mongoose.Schema(
    {
        city: {
            type: String,
            required: true,
        },
        vehicle_type: {
            type: String,
            required: true,     // e.g., 'truck', '3w', '2w'
        },
        vehicle_body_type: {
            type: String,
            default: 'all',     // e.g., 'open', 'closed', 'auto', 'all'
        },
        delivery_zone: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'DeliveryZone',
            default: null, // null means global/city default
        },
        base_fare: {
            type: Number,
            required: true,
            default: 50,        // Base fare in ₹
        },
        base_km: {
            type: Number,
            default: 2,         // First 2km included in base fare
        },
        per_km_rate: {
            type: Number,
            required: true,
            default: 15,        // ₹ per km after base_km
        },
        per_min_rate: {
            type: Number,
            required: true,
            default: 2,         // ₹ per minute (travel time)
        },
        waiting_charge_per_min: {
            type: Number,
            default: 0,
        },
        min_fare: {
            type: Number,
            required: true,
            default: 80,        // Minimum fare in ₹
        },
        max_fare: {
            type: Number,
            default: 0,         // 0 means no max limit
        },
        max_distance_km: {
            type: Number,
            default: 0,         // 0 means no limit
        },
        loading_charges: {
            type: Number,
            default: 0,         // Extra loading charges
        },
        unloading_charges: {
            type: Number,
            default: 0,
        },

        // Surge pricing
        surge_multiplier: {
            type: Number,
            default: 1.0,       // 1.0 = no surge, 1.5 = 50% extra
        },
        surge_active: {
            type: Boolean,
            default: false,
        },
        surge_reason: {
            type: String,
            default: '',        // e.g., "High Demand", "Peak Hours"
        },

        // Scheduling
        peak_hours: [{
            start: { type: String },  // "08:00"
            end: { type: String },    // "10:00"
            multiplier: { type: Number, default: 1.3 },
        }],

        // Commission
        platform_commission_percent: {
            type: Number,
            default: 15,        // Platform takes 15% commission
        },

        active: {
            type: Boolean,
            default: true,
        },
    },
    {
        timestamps: true,
    }
);

// Compound index: unique pricing per city + vehicle_type + body_type + zone
pricingSchema.index({ city: 1, vehicle_type: 1, vehicle_body_type: 1, delivery_zone: 1 }, { unique: true });

const Pricing = mongoose.model('Pricing', pricingSchema);
module.exports = Pricing;
