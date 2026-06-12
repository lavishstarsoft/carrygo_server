const Payment = require('../models/Payment');
const Order = require('../models/Order');
const {
    createRazorpayOrder,
    createDriverCollectionQR,
    fetchQRCode,
    fetchPaymentLink,
    qrImageFromPaymentLink,
    verifyPaymentSignature,
    verifyWebhookSignature,
    refundPayment,
} = require('../services/razorpay');

const DRIVER_QR_METHODS = ['upi_qr', 'payment_link'];
const { completeOrderPayment, parseFare } = require('../services/paymentCollection');
const { splitFareCommission } = require('../services/fareCalculation');

const resolveDriverId = (order, reqDriverId) => {
    const assigned = String(order.driver_id?._id || order.driver_id || '');
    const requester = String(reqDriverId || '');
    return assigned && requester && assigned === requester;
};

/**
 * POST /api/payments/create-order
 * Create a Razorpay order for online payment (user checkout)
 */
const createPaymentOrder = async (req, res) => {
    const { order_id } = req.body;

    try {
        const order = await Order.findById(order_id);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        if (order.payment_method !== 'razorpay') {
            return res.status(400).json({ error: 'This order is not set for online payment' });
        }

        const rpResult = await createRazorpayOrder(order.fare.total, order._id.toString());
        if (!rpResult.success) {
            return res.status(500).json({ error: rpResult.error });
        }

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
 */
const verifyPayment = async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, payment_id } = req.body;

    try {
        const verification = verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);

        if (!verification.success) {
            await Payment.findByIdAndUpdate(payment_id, {
                status: 'failed',
                razorpay_payment_id,
                razorpay_signature,
            });
            return res.status(400).json({ error: 'Payment verification failed' });
        }

        const payment = await Payment.findById(payment_id);
        if (!payment) return res.status(404).json({ error: 'Payment not found' });

        const order = await Order.findById(payment.order_id);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        const io = req.app.get('io');
        const result = await completeOrderPayment(order, payment.method || 'razorpay', {
            razorpay_payment_id,
            razorpay_signature,
        }, io);

        return res.status(200).json({ message: 'Payment verified successfully', payment: result.payment });
    } catch (error) {
        console.error('[Payment] Verify Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

/**
 * POST /api/payments/driver-qr/:orderId
 * Generate Razorpay UPI QR for driver to show customer (Rapido-style).
 */
const createDriverQR = async (req, res) => {
    const { orderId } = req.params;

    try {
        const order = await Order.findById(orderId);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        if (!resolveDriverId(order, req.driver.id)) {
            return res.status(403).json({ error: 'Not your order' });
        }

        if (!['in_transit', 'picked_up'].includes(order.status)) {
            return res.status(400).json({ error: 'QR available only during drop-off phase' });
        }

        if (order.payment_status === 'completed') {
            return res.status(200).json({
                already_paid: true,
                payment_status: 'completed',
                amount: order.fare?.total,
            });
        }

        const fare = parseFare(order.fare);
        const split = splitFareCommission(fare.total, fare.commission_percent || 15);
        const amount = split.total;

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid fare amount' });
        }

        let payment = await Payment.findOne({ order_id: String(order._id) });

        if (payment?.status === 'pending' && payment.razorpay_order_id && DRIVER_QR_METHODS.includes(payment.method)) {
            if (payment.method === 'upi_qr') {
                const existingQr = await fetchQRCode(payment.razorpay_order_id);
                if (existingQr.success && existingQr.qr?.status === 'active') {
                    return res.status(200).json({
                        qr_id: existingQr.qr.id,
                        image_url: existingQr.qr.image_url,
                        image_content: existingQr.qr.image_content,
                        method: 'upi_qr',
                        amount,
                        commission_amount: split.commission_amount,
                        driver_earnings: split.driver_earnings,
                        payment_status: 'pending',
                        payment_id: payment._id,
                    });
                }
            } else if (payment.method === 'payment_link') {
                const existingLink = await fetchPaymentLink(payment.razorpay_order_id);
                if (existingLink.success && existingLink.link?.status !== 'paid') {
                    const imageContent = await qrImageFromPaymentLink(existingLink.link.short_url);
                    return res.status(200).json({
                        qr_id: existingLink.link.id,
                        short_url: existingLink.link.short_url,
                        image_url: null,
                        image_content: imageContent,
                        method: 'payment_link',
                        amount,
                        commission_amount: split.commission_amount,
                        driver_earnings: split.driver_earnings,
                        payment_status: 'pending',
                        payment_id: payment._id,
                    });
                }
            }
        }

        const qrResult = await createDriverCollectionQR(amount, order._id, {
            order_number: order.order_number,
        });

        if (!qrResult.success) {
            const msg = qrResult.error || 'Failed to create payment QR';
            const hint = /authentication|key|secret/i.test(msg)
                ? 'Check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET on server'
                : null;
            return res.status(500).json({
                error: hint ? `${msg}. ${hint}` : msg,
            });
        }

        const collectionMethod = qrResult.method || 'upi_qr';

        if (payment) {
            payment.amount = amount;
            payment.method = collectionMethod;
            payment.status = 'pending';
            payment.razorpay_order_id = qrResult.qr_id;
            payment.platform_commission = split.commission_amount;
            payment.driver_earnings = split.driver_earnings;
            await payment.save();
        } else {
            payment = await Payment.create({
                order_id: order._id,
                user_id: order.user_id,
                driver_id: order.driver_id,
                amount,
                method: collectionMethod,
                status: 'pending',
                razorpay_order_id: qrResult.qr_id,
                platform_commission: split.commission_amount,
                driver_earnings: split.driver_earnings,
            });
        }

        order.payment_id = payment._id;
        await order.save();

        return res.status(200).json({
            qr_id: qrResult.qr_id,
            short_url: qrResult.short_url || null,
            image_url: qrResult.image_url,
            image_content: qrResult.image_content,
            method: collectionMethod,
            amount,
            commission_amount: split.commission_amount,
            driver_earnings: split.driver_earnings,
            commission_percent: split.commission_percent,
            payment_status: 'pending',
            payment_id: payment._id,
        });
    } catch (error) {
        console.error('[Payment] createDriverQR Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

/**
 * GET /api/payments/driver-qr/:orderId/status
 * Poll QR payment status from Razorpay.
 */
const getDriverQRStatus = async (req, res) => {
    const { orderId } = req.params;

    try {
        const order = await Order.findById(orderId);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        if (!resolveDriverId(order, req.driver.id)) {
            return res.status(403).json({ error: 'Not your order' });
        }

        if (order.payment_status === 'completed') {
            const payment = await Payment.findOne({ order_id: String(order._id) });
            return res.status(200).json({
                payment_status: 'completed',
                method: payment?.method || order.payment_method,
                amount: payment?.amount || order.fare?.total,
            });
        }

        const payment = await Payment.findOne({
            order_id: String(order._id),
            method: { $in: DRIVER_QR_METHODS },
        });
        if (!payment?.razorpay_order_id) {
            return res.status(200).json({ payment_status: 'pending', qr_active: false });
        }

        let isPaid = false;
        let pollMeta = { qr_active: false };

        if (payment.method === 'payment_link') {
            const linkResult = await fetchPaymentLink(payment.razorpay_order_id);
            if (!linkResult.success) {
                return res.status(200).json({ payment_status: 'pending', qr_active: false });
            }
            const link = linkResult.link;
            isPaid = link.status === 'paid';
            pollMeta = {
                qr_active: ['created', 'partially_paid'].includes(link.status),
                amount_expected: payment.amount,
            };
        } else {
            const qrResult = await fetchQRCode(payment.razorpay_order_id);
            if (!qrResult.success) {
                return res.status(200).json({ payment_status: 'pending', qr_active: false });
            }
            const qr = qrResult.qr;
            const expectedPaise = Math.round(Number(payment.amount) * 100);
            const received = Number(qr.payments_amount_received) || 0;
            isPaid = received >= expectedPaise || qr.status === 'closed';
            pollMeta = {
                qr_active: qr.status === 'active',
                amount_received: received / 100,
                amount_expected: payment.amount,
            };
        }

        if (isPaid && payment.status !== 'completed') {
            const io = req.app.get('io');
            const result = await completeOrderPayment(order, payment.method, {
                razorpay_order_id: payment.razorpay_order_id,
            }, io);
            return res.status(200).json({
                payment_status: 'completed',
                method: payment.method,
                amount: result.payment?.amount,
                driver_earnings: result.split?.driver_earnings,
                commission_amount: result.split?.commission_amount,
            });
        }

        return res.status(200).json({
            payment_status: 'pending',
            ...pollMeta,
        });
    } catch (error) {
        console.error('[Payment] getDriverQRStatus Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

/**
 * POST /api/payments/cash-collected
 * Driver confirms cash received from customer.
 */
const cashCollected = async (req, res) => {
    const { order_id } = req.body;

    try {
        const order = await Order.findById(order_id);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        if (!resolveDriverId(order, req.driver.id)) {
            return res.status(403).json({ error: 'Not your order' });
        }

        if (!['in_transit', 'picked_up'].includes(order.status)) {
            return res.status(400).json({ error: 'Collect payment during drop-off only' });
        }

        if (order.payment_status === 'completed') {
            return res.status(200).json({ message: 'Payment already recorded', already_paid: true });
        }

        const io = req.app.get('io');
        const result = await completeOrderPayment(order, 'cash', {}, io);
        const split = result.split || splitFareCommission(order.fare?.total, order.fare?.commission_percent);

        return res.status(200).json({
            message: 'Cash payment recorded',
            payment: result.payment,
            amount: split.total,
            commission_amount: split.commission_amount,
            driver_earnings: split.driver_earnings,
            payment_status: 'completed',
        });
    } catch (error) {
        console.error('[Payment] cashCollected Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

/**
 * GET /api/payments/order/:orderId/status
 */
const getOrderPaymentStatus = async (req, res) => {
    try {
        const order = await Order.findById(req.params.orderId);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        const payment = await Payment.findOne({ order_id: String(order._id) });
        const fare = parseFare(order.fare);
        const split = splitFareCommission(fare.total, fare.commission_percent || 15);

        return res.status(200).json({
            order_id: order._id,
            payment_status: order.payment_status || 'pending',
            payment_method: order.payment_method,
            amount: split.total,
            commission_amount: split.commission_amount,
            driver_earnings: split.driver_earnings,
            method: payment?.method || null,
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

/**
 * POST /api/payments/webhook
 * Razorpay webhook for QR payment capture.
 */
const razorpayWebhook = async (req, res) => {
    try {
        const signature = req.headers['x-razorpay-signature'];
        const rawBody = req.rawBody || JSON.stringify(req.body);

        if (signature && !verifyWebhookSignature(rawBody, signature)) {
            return res.status(400).json({ error: 'Invalid webhook signature' });
        }

        const event = req.body?.event;
        const payload = req.body?.payload;

        if (event === 'qr_code.credited' || event === 'payment.captured') {
            const qrEntity = payload?.qr_code?.entity || payload?.payment?.entity;
            const orderIdNote = qrEntity?.notes?.order_id
                || payload?.payment?.entity?.notes?.order_id;

            if (orderIdNote) {
                const order = await Order.findById(orderIdNote);
                if (order && order.payment_status !== 'completed') {
                    const io = req.app.get('io');
                    await completeOrderPayment(order, 'upi_qr', {
                        razorpay_payment_id: payload?.payment?.entity?.id || '',
                    }, io);
                }
            }
        }

        if (event === 'payment_link.paid') {
            const linkEntity = payload?.payment_link?.entity;
            const orderIdNote = linkEntity?.notes?.order_id;
            if (orderIdNote) {
                const order = await Order.findById(orderIdNote);
                if (order && order.payment_status !== 'completed') {
                    const io = req.app.get('io');
                    await completeOrderPayment(order, 'payment_link', {
                        razorpay_order_id: linkEntity?.id || '',
                        razorpay_payment_id: payload?.payment?.entity?.id || '',
                    }, io);
                }
            }
        }

        return res.status(200).json({ received: true });
    } catch (error) {
        console.error('[Payment] Webhook Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

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

        await Order.findByIdAndUpdate(payment.order_id, { payment_status: 'refunded' });

        return res.status(200).json({ message: 'Payment refunded', payment });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

const getPaymentByOrder = async (req, res) => {
    try {
        const payment = await Payment.findOne({ order_id: req.params.orderId });

        if (!payment) return res.status(404).json({ error: 'Payment not found' });
        return res.status(200).json(payment);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

module.exports = {
    createPaymentOrder,
    verifyPayment,
    createDriverQR,
    getDriverQRStatus,
    cashCollected,
    getOrderPaymentStatus,
    razorpayWebhook,
    processRefund,
    getPaymentByOrder,
};
