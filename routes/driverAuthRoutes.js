const express = require('express');
const router = express.Router();
const { sendDriverOTP, verifyDriverOTP, getDriverProfile } = require('../controllers/driverAuthController');
const driverAuth = require('../middleware/driverAuth');
const { otpLimiter } = require('../middleware/rateLimiter');

// Public routes
router.post('/send-otp', otpLimiter, sendDriverOTP);
router.post('/verify-otp', verifyDriverOTP);

// Protected routes (requires JWT)
router.get('/me', driverAuth, getDriverProfile);

module.exports = router;
