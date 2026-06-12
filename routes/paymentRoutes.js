const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const userAuth = require('../middleware/userAuth');
const driverAuth = require('../middleware/driverAuth');

// User routes
router.post('/create-order', userAuth, paymentController.createPaymentOrder);
router.post('/verify', userAuth, paymentController.verifyPayment);

// Driver routes — Rapido-style payment collection at drop-off
router.post('/driver-qr/:orderId', driverAuth, paymentController.createDriverQR);
router.get('/driver-qr/:orderId/status', driverAuth, paymentController.getDriverQRStatus);
router.post('/cash-collected', driverAuth, paymentController.cashCollected);

// Webhook (no auth — Razorpay calls this)
router.post('/webhook', paymentController.razorpayWebhook);

// Admin routes
router.post('/refund', paymentController.processRefund);

// Shared
router.get('/order/:orderId/status', paymentController.getOrderPaymentStatus);
router.get('/order/:orderId', paymentController.getPaymentByOrder);

module.exports = router;
