const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
    phone: {
        type: String,
        required: true,
        index: true
    },
    otp: {
        type: String,
        required: true
    },
    expiresAt: {
        type: Date,
        default: Date.now,
        index: { expires: 300 } // Auto-delete after 300 seconds (5 minutes)
    }
});

module.exports = mongoose.model('Otp', otpSchema);
