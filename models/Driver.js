const mongoose = require('mongoose');

const driverSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            default: '',
        },
        phone: {
            type: String,
            required: true,
            unique: true,
        },
        email: {
            type: String,
            default: '',
        },
        city: {
            type: String,
            default: '',
        },
        vehicle_type: {
            type: String, // e.g., 'trust', '3w', '2w'
            default: '',
        },
        vehicle_body_type: { type: String, default: '' },
        vehicle_fuel_type: { type: String, default: '' },
        vehicle_advanced_info: {
            type: mongoose.Schema.Types.Mixed,
            default: {}
        },
        vehicle_number: {
            type: String,
            default: '',
        },
        latitude: {
            type: Number,
        },
        longitude: {
            type: Number,
        },
        is_active: {
            type: Boolean,
            default: false,
        },

        // KYC Fields
        terms_accepted: {
            type: Boolean,
            default: false,
        },
        kyc_status: {
            type: String,
            enum: ['not_started', 'pending', 'approved', 'rejected', 'action_required'],
            default: 'not_started',
        },
        kyc_rejection_reason: {
            type: String,
            default: '',
        },
        kyc_issue_document: {
            type: String, // kept for backward compat, holds first issue doc
            default: '',
        },
        kyc_issue_reason: {
            type: String,
            default: '',
        },
        kyc_issues: [{
            document: { type: String },
            reason: { type: String },
        }],

        // Document URLs (stored as file paths on server)
        aadhaar_front: { type: String, default: '' },
        aadhaar_back: { type: String, default: '' },
        pan_front: { type: String, default: '' },
        pan_back: { type: String, default: '' },
        license_front: { type: String, default: '' },
        license_back: { type: String, default: '' },
        rc_front: { type: String, default: '' },
        rc_back: { type: String, default: '' },
        insurance: { type: String, default: '' },
        selfie: { type: String, default: '' },

        // Driver details (Step 3)
        driver_is_self: { type: Boolean, default: true },
        driver_name: { type: String, default: '' },
        driver_phone: { type: String, default: '' },

        // GeoJSON Location (for proximity-based driver matching)
        location: {
            type: {
                type: String,
                enum: ['Point'],
                default: 'Point',
            },
            coordinates: {
                type: [Number],     // [longitude, latitude]
                default: [0, 0],
            },
        },

        // Trip status
        is_on_trip: { type: Boolean, default: false },
        current_order_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Order',
        },

        // Earnings
        total_earnings: { type: Number, default: 0 },
        total_deliveries: { type: Number, default: 0 },
        average_rating: { type: Number, default: 5.0 },
        total_ratings: { type: Number, default: 0 },

        // FCM Token for push notifications
        fcm_token: { type: String, default: '' },

        // Blocking Fields
        is_blocked: { type: Boolean, default: false },
        block_reason: { type: String, default: '' },

        // Multi-Vehicle Support
        vehicles: [{
            vehicle_type: { type: String, default: '' },
            vehicle_number: { type: String, default: '' },
            vehicle_body_type: { type: String, default: '' },
            vehicle_fuel_type: { type: String, default: '' },
            vehicle_advanced_info: { type: mongoose.Schema.Types.Mixed, default: {} },
            rc_front: { type: String, default: '' },
            rc_back: { type: String, default: '' },
            insurance: { type: String, default: '' },
            kyc_status: {
                type: String,
                enum: ['pending', 'approved', 'rejected', 'action_required', 'not_started'],
                default: 'pending',
            },
            kyc_issues: [{
                document: { type: String },
                reason: { type: String },
            }],
            createdAt: { type: Date, default: Date.now }
        }],
    },
    {
        timestamps: true,
    }
);

// GeoJSON 2dsphere index for proximity-based driver matching
driverSchema.index({ location: '2dsphere' });
// Index for finding active online drivers quickly
driverSchema.index({ is_active: 1, is_on_trip: 1, kyc_status: 1 });

const Driver = mongoose.model('Driver', driverSchema);
module.exports = Driver;
