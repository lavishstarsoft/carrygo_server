const Payment = require('../models/Payment');
const Order = require('../models/Order');
const {
    createDriverCollectionQR,
    fetchQRCode,
    fetchPaymentLink,
    qrImageFromPaymentLink,
} = require('./razorpay');
const { parseFare } = require('./paymentCollection');
const { splitFareCommission } = require('./fareCalculation');

const DRIVER_QR_METHODS = ['upi_qr', 'payment_link'];

/** QR can be prepared as soon as driver accepts — ready before delivery OTP */
const DRIVER_QR_PREPARE_STATUSES = ['accepted', 'driver_arrived', 'picked_up', 'in_transit'];

/**
 * Create or return existing Razorpay collection QR for a driver order.
 * Idempotent — safe to call on accept and again at payment screen.
 */
const ensureDriverCollectionQR = async (orderId) => {
    const order = await Order.findById(orderId);
    if (!order) return { success: false, error: 'Order not found' };

    if (!order.driver_id) {
        return { success: false, error: 'No driver assigned' };
    }

    if (!DRIVER_QR_PREPARE_STATUSES.includes(order.status)) {
        return { success: false, error: 'Order not ready for QR' };
    }

    if (order.payment_status === 'completed') {
        return {
            success: true,
            already_paid: true,
            payment_status: 'completed',
            amount: order.fare?.total,
        };
    }

    const fare = parseFare(order.fare);
    const split = splitFareCommission(fare.total, fare.commission_percent || 15);
    const amount = split.total;

    if (!amount || amount <= 0) {
        return { success: false, error: 'Invalid fare amount' };
    }

    let payment = await Payment.findOne({ order_id: String(order._id) });

    if (payment?.status === 'pending' && payment.razorpay_order_id && DRIVER_QR_METHODS.includes(payment.method)) {
        if (payment.method === 'upi_qr') {
            const existingQr = await fetchQRCode(payment.razorpay_order_id);
            if (existingQr.success && existingQr.qr?.status === 'active') {
                return {
                    success: true,
                    qr_id: existingQr.qr.id,
                    image_url: existingQr.qr.image_url,
                    image_content: existingQr.qr.image_content,
                    method: 'upi_qr',
                    amount,
                    commission_amount: split.commission_amount,
                    driver_earnings: split.driver_earnings,
                    payment_status: 'pending',
                    payment_id: payment._id,
                };
            }
        } else if (payment.method === 'payment_link') {
            const existingLink = await fetchPaymentLink(payment.razorpay_order_id);
            if (existingLink.success && existingLink.link?.status !== 'paid') {
                const imageContent = await qrImageFromPaymentLink(existingLink.link.short_url);
                return {
                    success: true,
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
                };
            }
        }
    }

    const qrResult = await createDriverCollectionQR(amount, order._id, {
        order_number: order.order_number,
    });

    if (!qrResult.success) {
        return { success: false, error: qrResult.error || 'Failed to create payment QR' };
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

    return {
        success: true,
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
    };
};

/** Fire-and-forget preload after driver accepts — does not block HTTP response */
const preloadDriverCollectionQR = (orderId) => {
    return ensureDriverCollectionQR(orderId).catch((err) => {
        console.error('[Payment] preloadDriverCollectionQR:', err.message);
        return { success: false, error: err.message };
    });
};

module.exports = {
    DRIVER_QR_PREPARE_STATUSES,
    ensureDriverCollectionQR,
    preloadDriverCollectionQR,
};
