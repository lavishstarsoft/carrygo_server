const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Middleware to protect user routes
const userAuth = async (req, res, next) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
        return res.status(401).json({ error: 'No token, authorization denied' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'super-secret-fallback');

        // Fetch user from DB to check block status
        const user = await User.findById(decoded.user.id).select('is_blocked block_reason is_active');

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (user.is_blocked) {
            return res.status(403).json({
                error: 'Account Suspended',
                reason: user.block_reason || 'Violation of terms'
            });
        }

        if (!user.is_active) {
            return res.status(403).json({ error: 'Account deactivated' });
        }

        req.user = decoded.user;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Token is not valid' });
    }
};

module.exports = userAuth;
