const Driver = require('../models/Driver');
const Otp = require('../models/Otp');
const jwt = require('jsonwebtoken');
const { sendOTP } = require('../services/msg91');
const { OTP_EXPIRY_MS, assertCanSendOtp } = require('../services/otpSendGuard');

// POST /api/driver-auth/send-otp
const sendDriverOTP = async (req, res) => {
    const { phone } = req.body;

    if (!phone) {
        return res.status(400).json({ error: 'Phone number is required' });
    }

    try {
        const guard = await assertCanSendOtp(phone);
        if (!guard.ok) {
            return res.status(guard.status).json({
                error: guard.error,
                retry_after: guard.retry_after,
                code: guard.code,
            });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        await Otp.findOneAndUpdate(
            { phone },
            {
                phone,
                otp,
                expiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
            },
            { upsert: true, new: true }
        );

        console.log(`Generated OTP for ${phone}: ${otp}`);

        // Send OTP via MSG91 Flow API
        const result = await sendOTP(phone, otp);

        if (result.success) {
            res.json({ message: 'OTP sent successfully' });
        } else {
            res.status(500).json({ error: 'Failed to send OTP', details: result.error });
        }
    } catch (error) {
        console.error('Send OTP Error:', error);
        res.status(500).json({ error: 'Server error sending OTP' });
    }
};

// POST /api/driver-auth/verify-otp
const verifyDriverOTP = async (req, res) => {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
        return res.status(400).json({ error: 'Phone and OTP are required' });
    }

    try {
        // Verify OTP locally from MongoDB
        const storedOtp = await Otp.findOne({ phone });

        if (!storedOtp) {
            return res.status(401).json({ error: 'OTP expired or not found. Please request a new OTP.' });
        }

        if (storedOtp.otp !== otp) {
            return res.status(401).json({ error: 'Invalid OTP' });
        }

        // Delete OTP after successful verification (prevent replay attacks)
        await Otp.deleteOne({ _id: storedOtp._id });

        // Check if driver already exists
        let driver = await Driver.findOne({ phone });

        // Block users who have been blocked by admin
        if (driver && driver.is_blocked) {
            return res.status(403).json({ error: `Your account has been suspended. Reason: ${driver.block_reason || 'Violation of terms'}` });
        }

        let isNewDriver = false;

        if (!driver) {
            driver = await Driver.create({ phone });
            isNewDriver = true;
        }

        // Generate JWT token
        const token = jwt.sign(
            { driver: { id: driver._id, phone: driver.phone } },
            process.env.JWT_SECRET || 'super-secret-fallback',
            { expiresIn: '30d' }
        );

        res.json({
            message: 'OTP verified successfully',
            token,
            isNewDriver,
            driver: driver.toObject ? driver.toObject() : driver,
        });
    } catch (error) {
        console.error('Verify OTP Error:', error);
        res.status(500).json({ error: 'Server error verifying OTP' });
    }
};

// GET /api/driver-auth/me
const getDriverProfile = async (req, res) => {
    try {
        const driver = await Driver.findById(req.driver.id).select('-__v');
        if (!driver) {
            return res.status(404).json({ error: 'Driver not found' });
        }
        res.json(driver);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
};

module.exports = { sendDriverOTP, verifyDriverOTP, getDriverProfile };
