const rateLimit = require('express-rate-limit');

// Limiter for OTP and SMS related activities
// Each IP can request only 3 OTPs every 10 minutes
const otpLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 3, // limit each IP to 3 requests per windowMs
    message: {
        error: "Too many requests",
        message: "You have exceeded the OTP request limit. Please try again after 10 minutes.",
        code: "RATE_LIMIT_EXCEEDED"
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// General purpose limiter to prevent DDoS on public routes
const generalLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30, // limit each IP to 30 requests per minute
    message: {
        error: "Too many requests",
        message: "Slow down! You are sending too many requests.",
        code: "RATE_LIMIT_EXCEEDED"
    },
    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = {
    otpLimiter,
    generalLimiter
};
