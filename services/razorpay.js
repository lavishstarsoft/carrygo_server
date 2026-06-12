const Razorpay = require('razorpay');
const crypto = require('crypto');

const razorpayInstance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * Create a Razorpay order
 */
const createRazorpayOrder = async (amount, orderId, notes = {}) => {
    try {
        const options = {
            amount: Math.round(amount * 100), // Razorpay accepts amount in paise
            currency: 'INR',
            receipt: `CG_${orderId}`,
            notes: {
                order_id: orderId,
                ...notes,
            },
        };

        const order = await razorpayInstance.orders.create(options);
        console.log('[Razorpay] Order created:', order.id);

        return {
            success: true,
            razorpay_order_id: order.id,
            amount: order.amount,
            currency: order.currency,
        };
    } catch (error) {
        console.error('[Razorpay] Create Order Error:', error.message);
        return { success: false, error: error.message };
    }
};

/**
 * Verify Razorpay payment signature
 */
const verifyPaymentSignature = (razorpay_order_id, razorpay_payment_id, razorpay_signature) => {
    try {
        const sign = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSign = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(sign)
            .digest('hex');

        const isValid = expectedSign === razorpay_signature;
        console.log(`[Razorpay] Signature verification: ${isValid ? 'VALID' : 'INVALID'}`);

        return { success: isValid };
    } catch (error) {
        console.error('[Razorpay] Verify Signature Error:', error.message);
        return { success: false, error: error.message };
    }
};

/**
 * Fetch payment details from Razorpay
 */
const fetchPayment = async (paymentId) => {
    try {
        const payment = await razorpayInstance.payments.fetch(paymentId);
        return { success: true, payment };
    } catch (error) {
        console.error('[Razorpay] Fetch Payment Error:', error.message);
        return { success: false, error: error.message };
    }
};

/**
 * Refund a payment
 */
const refundPayment = async (paymentId, amount, notes = {}) => {
    try {
        const refund = await razorpayInstance.payments.refund(paymentId, {
            amount: Math.round(amount * 100), // paise
            notes,
        });

        console.log('[Razorpay] Refund created:', refund.id);
        return { success: true, refund };
    } catch (error) {
        console.error('[Razorpay] Refund Error:', error.message);
        return { success: false, error: error.message };
    }
};

/**
 * Create a single-use UPI QR code for driver-side collection (Rapido-style).
 */
const createUPIQRCode = async (amount, orderId, notes = {}) => {
    try {
        const paymentAmount = Math.round(Number(amount) * 100);
        const qr = await razorpayInstance.qrCode.create({
            type: 'upi_qr',
            usage: 'single_use',
            fixed_amount: true,
            payment_amount: paymentAmount,
            description: `Carry Goo Trip ${String(orderId).slice(-8)}`,
            close_by: Math.floor(Date.now() / 1000) + 3600,
            notes: {
                order_id: String(orderId),
                ...notes,
            },
        });

        console.log('[Razorpay] UPI QR created:', qr.id);

        return {
            success: true,
            qr_id: qr.id,
            image_url: qr.image_url,
            image_content: qr.image_content,
            payment_amount: qr.payment_amount,
            status: qr.status,
        };
    } catch (error) {
        console.error('[Razorpay] Create QR Error:', error.message);
        return { success: false, error: error.message };
    }
};

const fetchQRCode = async (qrId) => {
    try {
        const qr = await razorpayInstance.qrCode.fetch(qrId);
        return { success: true, qr };
    } catch (error) {
        console.error('[Razorpay] Fetch QR Error:', error.message);
        return { success: false, error: error.message };
    }
};

const verifyWebhookSignature = (body, signature) => {
    try {
        const expected = crypto
            .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET)
            .update(body)
            .digest('hex');
        return expected === signature;
    } catch {
        return false;
    }
};

module.exports = {
    createRazorpayOrder,
    createUPIQRCode,
    fetchQRCode,
    verifyPaymentSignature,
    verifyWebhookSignature,
    fetchPayment,
    refundPayment,
    razorpayInstance,
};
