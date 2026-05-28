const express = require('express');
const router = express.Router();
const userAuthController = require('../controllers/userAuthController');
const userAuth = require('../middleware/userAuth');
const { otpLimiter } = require('../middleware/rateLimiter');

// Public routes
router.post('/send-otp', otpLimiter, userAuthController.sendUserOTP);
router.post('/verify-otp', userAuthController.verifyUserOTP);

// Protected routes
router.get('/me', userAuth, userAuthController.getUserProfile);
router.put('/profile', userAuth, userAuthController.updateUserProfile);
router.post('/saved-address', userAuth, userAuthController.addSavedAddress);
router.delete('/saved-address/:addressId', userAuth, userAuthController.deleteSavedAddress);

module.exports = router;
