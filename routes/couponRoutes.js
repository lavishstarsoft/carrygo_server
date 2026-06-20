const express = require('express');
const router = express.Router();
const {
    getCoupons,
    getActiveCoupons,
    createCoupon,
    updateCoupon,
    deleteCoupon,
    validateCoupon
} = require('../controllers/couponController');

// Admin routes (Currently public for demo, should add authentication middleware in prod)
router.route('/')
    .get(getCoupons)
    .post(createCoupon);

router.route('/:id')
    .put(updateCoupon)
    .delete(deleteCoupon);

// User routes
router.get('/active/all', getActiveCoupons); // /active conflicts with /:id, so use /active/all
router.post('/validate', validateCoupon);

module.exports = router;
