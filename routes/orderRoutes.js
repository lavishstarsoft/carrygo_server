const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const userAuth = require('../middleware/userAuth');
const driverAuth = require('../middleware/driverAuth');

// ─── User Routes ──────────────────────────────────────────────
router.post('/book', userAuth, orderController.createBooking);
router.get('/my-orders', userAuth, orderController.getUserOrders);
router.get('/active', userAuth, orderController.getUserActiveOrder);
router.put('/:id/cancel', userAuth, orderController.cancelOrder);
router.put('/:id/rate', orderController.rateOrder);
router.get('/nearby-drivers', orderController.getNearbyDriversForMap);
router.get('/route', orderController.getRoute);
// ─── Driver Routes ────────────────────────────────────────────
router.post('/accept', driverAuth, orderController.acceptOrder);
router.post('/reject', driverAuth, orderController.rejectOrder);
router.put('/:id/status', driverAuth, orderController.updateOrderStatus);
router.get('/driver-orders', driverAuth, orderController.getDriverOrders);
router.get('/driver-active', driverAuth, orderController.getActiveOrder);
router.get('/pending-for-driver', driverAuth, orderController.getPendingOrdersForDriver);
router.get('/driver-earnings', driverAuth, orderController.getDriverEarnings);

// ─── Admin / Shared Routes ───────────────────────────────────
router.get('/', orderController.getAllOrders);
router.get('/:id', orderController.getOrderById);
router.delete('/:id', orderController.deleteOrder);

module.exports = router;
