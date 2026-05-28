const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const userAuth = require('../middleware/userAuth');
const driverAuth = require('../middleware/driverAuth');

// User routes
router.post('/create-order', userAuth, paymentController.createPaymentOrder);
router.post('/verify', userAuth, paymentController.verifyPayment);

// Driver routes
router.post('/cash-collected', driverAuth, paymentController.cashCollected);

// Admin routes
router.post('/refund', paymentController.processRefund);

// Shared
router.get('/order/:orderId', paymentController.getPaymentByOrder);

module.exports = router;
