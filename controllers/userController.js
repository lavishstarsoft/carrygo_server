const User = require('../models/User');

const getAllUsers = async (req, res) => {
    try {
        const data = await User.find({});
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

const createUser = async (req, res) => {
    const { name, phone, email } = req.body;
    try {
        const data = await User.create({ name, phone, email });
        return res.status(201).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

const toggleBlockStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { is_blocked, block_reason } = req.body;

        const user = await User.findByIdAndUpdate(
            id,
            {
                is_blocked,
                block_reason: is_blocked ? (block_reason || 'Blocked by Admin') : '',
            },
            { new: true }
        );

        if (!user) return res.status(404).json({ error: 'User not found' });
        return res.status(200).json(user);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

module.exports = {
    getAllUsers,
    createUser,
    toggleBlockStatus,
};
