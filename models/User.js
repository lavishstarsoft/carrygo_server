const mongoose = require('mongoose');

const savedAddressSchema = new mongoose.Schema({
    title: { type: String, default: '' },       // e.g., "Home", "Shop", "Other"
    address: { type: String, default: '' },
    lat: { type: Number },
    lng: { type: Number },
    house_details: { type: String, default: '' },
    sender_name: { type: String, default: '' },
    sender_phone: { type: String, default: '' },
}, { _id: true });

const userSchema = new mongoose.Schema(
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
            unique: true,
            sparse: true,
        },
        usage_type: {
            type: String,
            enum: ['Business Usages', 'Personal usages', 'House Shifting Usages'],
            default: 'Personal usages',
        },
        profile_image: {
            type: String,
            default: '',
        },
        saved_addresses: [savedAddressSchema],
        fcm_token: {
            type: String,
            default: '',
        },

        // Rating
        average_rating: {
            type: Number,
            default: 5.0,
        },
        total_ratings: {
            type: Number,
            default: 0,
        },
        total_rides: {
            type: Number,
            default: 0,
        },

        // Status
        is_active: {
            type: Boolean,
            default: true,
        },
        is_blocked: {
            type: Boolean,
            default: false,
        },
        block_reason: {
            type: String,
            default: '',
        },
    },
    {
        timestamps: true,
    }
);

const User = mongoose.model('User', userSchema);
module.exports = User;
