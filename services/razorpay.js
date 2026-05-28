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

module.exports = {
    createRazorpayOrder,
    verifyPaymentSignature,
    fetchPayment,
    refundPayment,
    razorpayInstance,
};
