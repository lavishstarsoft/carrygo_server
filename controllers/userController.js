const User = require('../models/User');
const Order = require('../models/Order');
const Payment = require('../models/Payment');

const getAllUsers = async (req, res) => {
    try {
        const data = await User.find({ is_active: true });
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

const deleteUser = async (req, res) => {
    try {
        const { id } = req.params;

        const user = await User.findById(id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.is_active === false) {
            return res.status(404).json({ error: 'User not found' });
        }

        const [orderCount, paymentCount] = await Promise.all([
            Order.countDocuments({ user_id: id }),
            Payment.countDocuments({ user_id: id }),
        ]);

        const hasHistory = orderCount > 0 || paymentCount > 0;

        if (hasHistory) {
            // Soft delete: hide from admin/app, keep order/payment records intact
            await User.findByIdAndUpdate(
                id,
                {
                    is_active: false,
                    is_blocked: true,
                    block_reason: 'Account removed by admin',
                    name: 'Deleted User',
                    phone: `deleted_${id}`,
                    email: null,
                    saved_addresses: [],
                    fcm_token: '',
                    profile_image: '',
                },
                { new: true },
            );
            return res.status(200).json({
                message: 'Customer removed from system. Order history preserved.',
                soft_delete: true,
                order_count: orderCount,
                payment_count: paymentCount,
            });
        }

        await User.findByIdAndDelete(id);
        return res.status(200).json({ message: 'Customer deleted successfully', soft_delete: false });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

module.exports = {
    getAllUsers,
    createUser,
    toggleBlockStatus,
    deleteUser,
};
