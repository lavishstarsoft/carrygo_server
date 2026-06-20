const Coupon = require('../models/Coupon');

// @desc    Get all coupons (Admin)
// @route   GET /api/coupons
// @access  Public (should be protected in prod)
exports.getCoupons = async (req, res) => {
    try {
        const coupons = await Coupon.find().sort({ createdAt: -1 });
        res.status(200).json(coupons);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// @desc    Get active coupons (User App)
// @route   GET /api/coupons/active
// @access  Public
exports.getActiveCoupons = async (req, res) => {
    try {
        const now = new Date();
        const coupons = await Coupon.find({
            isActive: true,
            $or: [{ validUntil: { $exists: false } }, { validUntil: { $gte: now } }],
            $expr: {
                $or: [
                    { $eq: ["$usageLimit", 0] },
                    { $lt: ["$timesUsed", "$usageLimit"] }
                ]
            }
        }).sort({ createdAt: -1 });
        res.status(200).json(coupons);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// @desc    Create a new coupon (Admin)
// @route   POST /api/coupons
// @access  Public
exports.createCoupon = async (req, res) => {
    try {
        const { code } = req.body;
        // Check if exists
        const existing = await Coupon.findOne({ code: code.toUpperCase() });
        if (existing) {
            return res.status(400).json({ error: 'Coupon code already exists' });
        }

        const coupon = new Coupon(req.body);
        await coupon.save();
        res.status(201).json(coupon);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// @desc    Update a coupon (Admin)
// @route   PUT /api/coupons/:id
// @access  Public
exports.updateCoupon = async (req, res) => {
    try {
        const { id } = req.params;
        const coupon = await Coupon.findByIdAndUpdate(id, req.body, { new: true, runValidators: true });
        if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
        res.status(200).json(coupon);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// @desc    Delete a coupon (Admin)
// @route   DELETE /api/coupons/:id
// @access  Public
exports.deleteCoupon = async (req, res) => {
    try {
        const { id } = req.params;
        const coupon = await Coupon.findByIdAndDelete(id);
        if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
        res.status(200).json({ message: 'Coupon deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// @desc    Validate a coupon code and calculate discount
// @route   POST /api/coupons/validate
// @access  Public
exports.validateCoupon = async (req, res) => {
    try {
        const { code, fare } = req.body;
        if (!code || !fare) {
            return res.status(400).json({ error: 'Code and fare are required' });
        }

        const coupon = await Coupon.findOne({ code: code.toUpperCase() });

        if (!coupon) {
            return res.status(404).json({ error: 'Invalid coupon code' });
        }

        if (!coupon.isActive) {
            return res.status(400).json({ error: 'Coupon is no longer active' });
        }

        if (coupon.validUntil && new Date(coupon.validUntil) < new Date()) {
            return res.status(400).json({ error: 'Coupon has expired' });
        }

        if (coupon.validFrom && new Date(coupon.validFrom) > new Date()) {
            return res.status(400).json({ error: 'Coupon is not yet valid' });
        }

        if (coupon.usageLimit > 0 && coupon.timesUsed >= coupon.usageLimit) {
            return res.status(400).json({ error: 'Coupon usage limit reached' });
        }

        if (fare < coupon.minOrderValue) {
            return res.status(400).json({ error: `Minimum fare of ₹${coupon.minOrderValue} required` });
        }

        let discount = 0;
        if (coupon.discountType === 'flat') {
            discount = coupon.discountValue;
        } else if (coupon.discountType === 'percentage') {
            discount = (fare * coupon.discountValue) / 100;
            if (coupon.maxDiscount > 0 && discount > coupon.maxDiscount) {
                discount = coupon.maxDiscount;
            }
        }

        // Ensure discount doesn't exceed fare
        if (discount > fare) discount = fare;

        const newFare = fare - discount;

        res.status(200).json({
            valid: true,
            couponId: coupon._id,
            code: coupon.code,
            title: coupon.title,
            originalFare: fare,
            discountAmount: discount,
            newFare: newFare
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};
