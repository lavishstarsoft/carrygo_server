const mongoose = require('mongoose');

// Timeline entry for tracking order status changes
const timelineSchema = new mongoose.Schema({
    status: { type: String },
    timestamp: { type: Date, default: Date.now },
    note: { type: String, default: '' },
}, { _id: false });

const orderSchema = new mongoose.Schema(
    {
        // Order identification
        order_number: {
            type: String,
            unique: true,
        },

        // Participants
        user_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        driver_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Driver',
        },

        // Locations
        pickup: {
            address: { type: String, required: true },
            lat: { type: Number, required: true },
            lng: { type: Number, required: true },
            contact_name: { type: String, default: '' },
            contact_phone: { type: String, default: '' },
            house_details: { type: String, default: '' },
            landmark: { type: String, default: '' },
        },
        dropoff: {
            address: { type: String, required: true },
            lat: { type: Number, required: true },
            lng: { type: Number, required: true },
            contact_name: { type: String, default: '' },
            contact_phone: { type: String, default: '' },
            house_details: { type: String, default: '' },
            landmark: { type: String, default: '' },
        },

        // Vehicle
        vehicle_type: {
            type: String,
            required: true,        // 'truck', '3w', '2w'
        },
        vehicle_body_type: {
            type: String,
            default: '',
        },

        // Trip info
        distance_km: {
            type: Number,
            default: 0,
        },
        duration_min: {
            type: Number,
            default: 0,
        },
        estimated_travel_mins: {
            type: Number,
            default: 0,
        },
        actual_wait_mins: {
            type: Number,
            default: 0,
        },
        route_polyline: {
            type: String,           // Encoded polyline for map display
            default: '',
        },

        // Fare breakdown
        fare: {
            base_fare: { type: Number, default: 0 },
            distance_fare: { type: Number, default: 0 },
            time_fare: { type: Number, default: 0 },
            loading_charges: { type: Number, default: 0 },
            surge_multiplier: { type: Number, default: 1.0 },
            surge_amount: { type: Number, default: 0 },
            subtotal: { type: Number, default: 0 },
            platform_fee: { type: Number, default: 0 },
            total: { type: Number, default: 0 },
            // Driver side
            commission_percent: { type: Number, default: 15 },
            commission_amount: { type: Number, default: 0 },
            driver_earnings: { type: Number, default: 0 },
        },

        // Status
        status: {
            type: String,
            enum: [
                'searching',          // Looking for driver
                'accepted',           // Driver accepted
                'driver_arrived',     // Driver at pickup
                'picked_up',          // Goods picked up
                'in_transit',         // On the way to drop
                'delivered',          // Successfully delivered
                'cancelled',          // Cancelled by user/driver/system
            ],
            default: 'searching',
        },

        // Payment
        payment_method: {
            type: String,
            enum: ['cash', 'razorpay', 'upi'],
            default: 'cash',
        },
        payment_status: {
            type: String,
            enum: ['pending', 'completed', 'failed', 'refunded'],
            default: 'pending',
        },
        payment_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Payment',
        },

        // OTP verification
        pickup_otp: {
            type: String,
            default: '',
        },
        delivery_otp: {
            type: String,
            default: '',
        },

        // Ratings
        user_rating: {
            stars: { type: Number, min: 1, max: 5 },
            comment: { type: String, default: '' },
            rated_at: { type: Date },
        },
        driver_rating: {
            stars: { type: Number, min: 1, max: 5 },
            comment: { type: String, default: '' },
            rated_at: { type: Date },
        },

        // Goods info
        goods_type: {
            type: String,
            default: '',            // e.g., "Furniture", "Electronics"
        },
        goods_description: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },

        // Cancellation
        cancelled_by: {
            type: String,
            enum: ['user', 'driver', 'system', ''],
            default: '',
        },
        cancellation_reason: {
            type: String,
            default: '',
        },
        cancelled_at: {
            type: Date,
        },

        // Drivers who rejected this order
        rejected_drivers: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Driver',
        }],

        // ─── Dispatch (Rapido-style one-by-one) ─────────────────────────
        dispatch_candidate_driver_ids: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Driver',
        }],
        dispatch_cursor: { type: Number, default: 0 },
        offered_driver_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
        offer_expires_at: { type: Date },
        offer_attempt: { type: Number, default: 0 },

        // Timeline
        timeline: [timelineSchema],

        // Scheduled delivery
        is_scheduled: {
            type: Boolean,
            default: false,
        },
        scheduled_at: {
            type: Date,
        },

        // Delivery proof
        delivery_photo: {
            type: String,
            default: '',
        },

        // City (for analytics & pricing)
        city: {
            type: String,
            default: '',
        },
    },
    {
        timestamps: true,
    }
);

// Indexes for performance
orderSchema.index({ user_id: 1, createdAt: -1 });
orderSchema.index({ driver_id: 1, createdAt: -1 });
orderSchema.index({ status: 1 });
orderSchema.index({ city: 1, status: 1 });

// Auto-generate order number before saving
orderSchema.pre('save', async function () {
    if (!this.order_number) {
        const count = await mongoose.model('Order').countDocuments();
        this.order_number = `CG-${String(count + 1001).padStart(6, '0')}`;
    }
});

const Order = mongoose.model('Order', orderSchema);
module.exports = Order;
