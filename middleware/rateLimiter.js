const rateLimit = require('express-rate-limit');

const normalizePhoneKey = (phone) => String(phone || '').replace(/\D/g, '');

// Per-phone OTP cap (not per IP — mobile users often share carrier/NAT IPs)
const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8,
    keyGenerator: (req) => {
        const phone = normalizePhoneKey(req.body?.phone);
        return phone ? `otp:${phone}` : `ip:${req.ip}`;
    },
    message: {
        error: 'Too many OTP requests',
        message: 'Too many OTP attempts for this number. Please try again after 15 minutes.',
        code: 'RATE_LIMIT_EXCEEDED',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const generalLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 30,
    message: {
        error: 'Too many requests',
        message: 'Slow down! You are sending too many requests.',
        code: 'RATE_LIMIT_EXCEEDED',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = {
    otpLimiter,
    generalLimiter,
};
