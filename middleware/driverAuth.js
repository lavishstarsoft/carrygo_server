const jwt = require('jsonwebtoken');
const Driver = require('../models/Driver');

// Middleware to protect driver routes
const driverAuth = async (req, res, next) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
        return res.status(401).json({ error: 'No token, authorization denied' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'super-secret-fallback');

        // Fetch driver from DB to check block status
        const driver = await Driver.findById(decoded.driver.id).select('is_blocked block_reason');

        if (!driver) {
            return res.status(404).json({ error: 'Driver not found' });
        }

        if (driver.is_blocked) {
            return res.status(403).json({
                error: 'Account Suspended',
                reason: driver.block_reason || 'Violation of terms'
            });
        }

        req.driver = decoded.driver;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Token is not valid' });
    }
};

module.exports = driverAuth;
