const User = require('../models/User');
const Otp = require('../models/Otp');
const jwt = require('jsonwebtoken');
const { sendOTP } = require('../services/msg91');
const { OTP_EXPIRY_MS, assertCanSendOtp } = require('../services/otpSendGuard');

// POST /api/user-auth/send-otp
const sendUserOTP = async (req, res) => {
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

        console.log(`[User] Generated OTP for ${phone}: ${otp}`);

        const result = await sendOTP(phone, otp);

        if (result.success) {
            res.json({ message: 'OTP sent successfully' });
        } else {
            res.status(500).json({ error: 'Failed to send OTP', details: result.error });
        }
    } catch (error) {
        console.error('[User] Send OTP Error:', error);
        res.status(500).json({ error: 'Server error sending OTP' });
    }
};

// POST /api/user-auth/verify-otp
const verifyUserOTP = async (req, res) => {
    const { phone, otp, name } = req.body;

    if (!phone || !otp) {
        return res.status(400).json({ error: 'Phone and OTP are required' });
    }

    try {
        const storedOtp = await Otp.findOne({ phone });

        if (!storedOtp) {
            return res.status(401).json({ error: 'OTP expired or not found. Please request a new OTP.' });
        }

        if (storedOtp.otp !== otp) {
            return res.status(401).json({ error: 'Invalid OTP' });
        }

        // Check if OTP has expired
        if (storedOtp.expiresAt && new Date() > storedOtp.expiresAt) {
            await Otp.deleteOne({ _id: storedOtp._id });
            return res.status(401).json({ error: 'OTP expired. Please request a new OTP.' });
        }

        // Delete OTP after successful verification
        await Otp.deleteOne({ _id: storedOtp._id });

        // Find or create user
        let user = await User.findOne({ phone });
        let isNewUser = false;

        if (!user) {
            user = await User.create({
                phone,
                name: name || '',
            });
            isNewUser = true;
        }

        // Check if user is blocked
        if (user.is_blocked) {
            return res.status(403).json({
                error: 'Account Suspended',
                reason: user.block_reason || 'Violation of terms'
            });
        }

        // Generate JWT
        const token = jwt.sign(
            { user: { id: user._id, phone: user.phone } },
            process.env.JWT_SECRET || 'super-secret-fallback',
            { expiresIn: '30d' }
        );

        res.json({
            message: 'OTP verified successfully',
            token,
            isNewUser,
            user: user.toObject ? user.toObject() : user,
        });
    } catch (error) {
        console.error('[User] Verify OTP Error:', error);
        res.status(500).json({ error: 'Server error verifying OTP' });
    }
};

// GET /api/user-auth/me
const getUserProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-__v');
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
};

// PUT /api/user-auth/profile
const updateUserProfile = async (req, res) => {
    const { name, email, fcm_token, usage_type } = req.body;
    try {
        const updates = {};
        if (name !== undefined) updates.name = name;
        if (email !== undefined) updates.email = email;
        if (fcm_token !== undefined) updates.fcm_token = fcm_token;
        if (usage_type !== undefined) updates.usage_type = usage_type;

        const user = await User.findByIdAndUpdate(
            req.user.id,
            updates,
            { new: true }
        ).select('-__v');

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json(user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// POST /api/user-auth/saved-address
const addSavedAddress = async (req, res) => {
    const { title, address, lat, lng, house_details, sender_name, sender_phone } = req.body;
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Check if same title already exists and update it
        const existingIndex = user.saved_addresses.findIndex(a => a.title === title);
        if (existingIndex >= 0) {
            // Remove old one and push updated — Mongoose tracks array mutations this way
            user.saved_addresses.splice(existingIndex, 1);
        }
        user.saved_addresses.push({ title, address, lat, lng, house_details, sender_name, sender_phone });
        user.markModified('saved_addresses');
        await user.save();

        res.json(user.saved_addresses);
    } catch (error) {
        console.error('[User] Save Address Error:', error.message);
        res.status(500).json({ error: error.message });
    }
};

// DELETE /api/user-auth/saved-address/:addressId
const deleteSavedAddress = async (req, res) => {
    const { addressId } = req.params;
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        user.saved_addresses = user.saved_addresses.filter(
            addr => addr._id.toString() !== addressId
        );
        await user.save();

        res.json(user.saved_addresses);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    sendUserOTP,
    verifyUserOTP,
    getUserProfile,
    updateUserProfile,
    addSavedAddress,
    deleteSavedAddress,
};
