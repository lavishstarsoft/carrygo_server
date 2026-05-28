const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
    {
        order_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Order',
            required: true,
        },
        user_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        driver_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Driver',
        },
        amount: {
            type: Number,
            required: true,
        },
        method: {
            type: String,
            enum: ['cash', 'razorpay', 'upi'],
            default: 'cash',
        },
        status: {
            type: String,
            enum: ['pending', 'completed', 'failed', 'refunded'],
            default: 'pending',
        },

        // Razorpay fields
        razorpay_order_id: { type: String, default: '' },
        razorpay_payment_id: { type: String, default: '' },
        razorpay_signature: { type: String, default: '' },

        // Commission breakdown
        platform_commission: { type: Number, default: 0 },
        driver_earnings: { type: Number, default: 0 },

        // Refund info
        refund_amount: { type: Number, default: 0 },
        refund_reason: { type: String, default: '' },
        refund_id: { type: String, default: '' },
    },
    {
        timestamps: true,
    }
);

paymentSchema.index({ order_id: 1 });
paymentSchema.index({ user_id: 1 });
paymentSchema.index({ driver_id: 1 });

const Payment = mongoose.model('Payment', paymentSchema);
module.exports = Payment;
