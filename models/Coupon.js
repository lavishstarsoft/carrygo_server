const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
    code: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true
    },
    title: {
        type: String,
        required: true
    },
    description: {
        type: String,
        required: true
    },
    discountType: {
        type: String,
        enum: ['percentage', 'flat'],
        required: true
    },
    discountValue: {
        type: Number,
        required: true,
        min: 0
    },
    maxDiscount: {
        type: Number,
        default: 0 // 0 means no limit for flat, but usually required for percentage
    },
    minOrderValue: {
        type: Number,
        default: 0
    },
    validFrom: {
        type: Date,
        default: Date.now
    },
    validUntil: {
        type: Date
    },
    isActive: {
        type: Boolean,
        default: true
    },
    usageLimit: {
        type: Number,
        default: 0 // 0 means unlimited
    },
    timesUsed: {
        type: Number,
        default: 0
    }
}, { timestamps: true });

module.exports = mongoose.model('Coupon', couponSchema);
