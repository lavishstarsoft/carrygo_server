const Payment = require('../models/Payment');
const Order = require('../models/Order');
const { createRazorpayOrder, verifyPaymentSignature, refundPayment } = require('../services/razorpay');

/**
 * POST /api/payments/create-order
 * Create a Razorpay order for online payment
 */
const createPaymentOrder = async (req, res) => {
    const { order_id } = req.body;

    try {
        const order = await Order.findById(order_id);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        if (order.payment_method !== 'razorpay') {
            return res.status(400).json({ error: 'This order is not set for online payment' });
        }

        // Create Razorpay order
        const rpResult = await createRazorpayOrder(order.fare.total, order._id.toString());

        if (!rpResult.success) {
            return res.status(500).json({ error: rpResult.error });
        }

        // Create payment record
        const payment = await Payment.create({
            order_id: order._id,
            user_id: order.user_id,
            driver_id: order.driver_id,
            amount: order.fare.total,
            method: 'razorpay',
            status: 'pending',
            razorpay_order_id: rpResult.razorpay_order_id,
            platform_commission: order.fare.commission_amount,
            driver_earnings: order.fare.driver_earnings,
        });

        // Link payment to order
        order.payment_id = payment._id;
        await order.save();

        return res.status(200).json({
            razorpay_order_id: rpResult.razorpay_order_id,
            razorpay_key_id: process.env.RAZORPAY_KEY_ID,
            amount: rpResult.amount,
            currency: rpResult.currency,
            payment_id: payment._id,
        });
    } catch (error) {
        console.error('[Payment] Create Order Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

/**
 * POST /api/payments/verify
 * Verify Razorpay payment signature
 */
const verifyPayment = async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, payment_id } = req.body;

    try {
        // Verify signature
        const verification = verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);

        if (!verification.success) {
            // Update payment as failed
            await Payment.findByIdAndUpdate(payment_id, {
                status: 'failed',
                razorpay_payment_id,
                razorpay_signature,
            });

            return res.status(400).json({ error: 'Payment verification failed' });
        }

        // Update payment as completed
        const payment = await Payment.findByIdAndUpdate(payment_id, {
            status: 'completed',
            razorpay_payment_id,
            razorpay_signature,
        }, { new: true });

        // Update order payment status
        if (payment) {
            await Order.findByIdAndUpdate(payment.order_id, {
                payment_status: 'completed',
            });

            // Notify via socket
            const io = req.app.get('io');
            if (io) {
                const order = await Order.findById(payment.order_id);
                if (order) {
                    io.emit(`payment_update_${order.driver_id}`, {
                        order_id: order._id,
                        payment_status: 'completed',
                        amount: payment.amount,
                    });
                }
            }
        }

        return res.status(200).json({
            message: 'Payment verified successfully',
            payment,
        });
    } catch (error) {
        console.error('[Payment] Verify Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

/**
 * POST /api/payments/cash-collected
 * Mark cash payment as collected by driver
 */
const cashCollected = async (req, res) => {
    const { order_id } = req.body;

    try {
        const order = await Order.findById(order_id);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        if (order.payment_method !== 'cash') {
            return res.status(400).json({ error: 'This is not a cash order' });
        }

        // Create payment record for cash
        const payment = await Payment.create({
            order_id: order._id,
            user_id: order.user_id,
            driver_id: order.driver_id,
            amount: order.fare.total,
            method: 'cash',
            status: 'completed',
            platform_commission: order.fare.commission_amount,
            driver_earnings: order.fare.driver_earnings,
        });

        order.payment_status = 'completed';
        order.payment_id = payment._id;
        await order.save();

        return res.status(200).json({ message: 'Cash payment recorded', payment });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

/**
 * POST /api/payments/refund
 * Refund a payment (admin)
 */
const processRefund = async (req, res) => {
    const { payment_id, reason } = req.body;

    try {
        const payment = await Payment.findById(payment_id);
        if (!payment) return res.status(404).json({ error: 'Payment not found' });

        if (payment.status !== 'completed') {
            return res.status(400).json({ error: 'Can only refund completed payments' });
        }

        if (payment.method === 'razorpay' && payment.razorpay_payment_id) {
            const refResult = await refundPayment(payment.razorpay_payment_id, payment.amount);
            if (!refResult.success) {
                return res.status(500).json({ error: refResult.error });
            }
            payment.refund_id = refResult.refund.id;
        }

        payment.status = 'refunded';
        payment.refund_amount = payment.amount;
        payment.refund_reason = reason || 'Admin initiated refund';
        await payment.save();

        // Update order
        await Order.findByIdAndUpdate(payment.order_id, { payment_status: 'refunded' });

        return res.status(200).json({ message: 'Payment refunded', payment });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

/**
 * GET /api/payments/order/:orderId
 * Get payment for a specific order
 */
const getPaymentByOrder = async (req, res) => {
    try {
        const payment = await Payment.findOne({ order_id: req.params.orderId })
            .populate('user_id', 'name phone')
            .populate('driver_id', 'name phone');

        if (!payment) return res.status(404).json({ error: 'Payment not found' });
        return res.status(200).json(payment);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

module.exports = {
    createPaymentOrder,
    verifyPayment,
    cashCollected,
    processRefund,
    getPaymentByOrder,
};
