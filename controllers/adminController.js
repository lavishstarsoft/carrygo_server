const Admin = require('../models/Admin');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// POST /api/admin/login
const loginAdmin = async (req, res) => {
    const { email, password } = req.body;

    try {
        // Check if admin exists
        const admin = await Admin.findOne({ email });
        if (!admin) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Verify password
        const isMatch = await bcrypt.compare(password, admin.password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Generate JWT
        const payload = {
            admin: {
                id: admin._id,
                email: admin.email
            }
        };

        const secret = process.env.JWT_SECRET || 'super-secret-fallback';

        jwt.sign(
            payload,
            secret,
            { expiresIn: '1d' },
            (err, token) => {
                if (err) throw err;
                res.json({ token, message: 'Logged in successfully' });
            }
        );
    } catch (error) {
        res.status(500).json({ error: 'Server error during login' });
    }
};

// POST /api/admin/seed (One-time script to create the first admin)
const seedAdmin = async (req, res) => {
    const { email, password } = req.body;

    try {
        const existing = await Admin.findOne({ email });
        if (existing) {
            return res.status(400).json({ message: 'Admin already exists' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const admin = await Admin.create({
            email,
            password: hashedPassword
        });

        res.status(201).json({ message: 'Admin seeded successfully!', id: admin._id });
    } catch (error) {
        res.status(500).json({ error: 'Error seeding admin' });
    }
};

module.exports = {
    loginAdmin,
    seedAdmin
};
