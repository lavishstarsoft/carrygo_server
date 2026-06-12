const Razorpay = require('razorpay');
const crypto = require('crypto');
const QRCode = require('qrcode');

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
            name: `Carry Goo ${String(orderId).slice(-8)}`,
            usage: 'single_use',
            fixed_amount: true,
            payment_amount: paymentAmount,
            description: `Carry Goo Trip ${String(orderId).slice(-8)}`,
            close_by: Math.floor(Date.now() / 1000) + 7200,
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

/**
 * Fallback when native QR Codes API is not enabled on the Razorpay account.
 * Creates a UPI Payment Link and renders it as a scannable QR image.
 */
const createPaymentLinkQR = async (amount, orderId, notes = {}) => {
    try {
        const paymentAmount = Math.round(Number(amount) * 100);
        const link = await razorpayInstance.paymentLink.create({
            amount: paymentAmount,
            currency: 'INR',
            upi_link: true,
            accept_partial: false,
            description: `Carry Goo Trip ${String(orderId).slice(-8)}`,
            customer: {
                name: 'Carry Goo Customer',
                contact: '9999999999',
            },
            notify: { sms: false, email: false },
            reminder_enable: false,
            notes: {
                order_id: String(orderId),
                ...notes,
            },
        });

        const dataUri = await QRCode.toDataURL(link.short_url, {
            width: 280,
            margin: 1,
            errorCorrectionLevel: 'M',
        });

        console.log('[Razorpay] Payment Link QR created:', link.id);

        return {
            success: true,
            method: 'payment_link',
            qr_id: link.id,
            short_url: link.short_url,
            image_url: null,
            image_content: dataUri.replace(/^data:image\/png;base64,/, ''),
            payment_amount: paymentAmount,
            status: link.status || 'created',
        };
    } catch (error) {
        console.error('[Razorpay] Payment Link QR Error:', error.message);
        return { success: false, error: error.message };
    }
};

const fetchPaymentLink = async (linkId) => {
    try {
        const link = await razorpayInstance.paymentLink.fetch(linkId);
        return { success: true, link };
    } catch (error) {
        console.error('[Razorpay] Fetch Payment Link Error:', error.message);
        return { success: false, error: error.message };
    }
};

const qrImageFromPaymentLink = async (shortUrl) => {
    const dataUri = await QRCode.toDataURL(shortUrl, {
        width: 280,
        margin: 1,
        errorCorrectionLevel: 'M',
    });
    return dataUri.replace(/^data:image\/png;base64,/, '');
};

/**
 * Try native UPI QR; fall back to Payment Link QR when QR API is not enabled.
 */
const createDriverCollectionQR = async (amount, orderId, notes = {}) => {
    const native = await createUPIQRCode(amount, orderId, notes);
    if (native.success) {
        return { ...native, method: 'upi_qr' };
    }

    console.warn('[Razorpay] Native QR failed, using Payment Link fallback:', native.error);
    const fallback = await createPaymentLinkQR(amount, orderId, notes);
    if (fallback.success) return fallback;

    return {
        success: false,
        error: fallback.error || native.error,
    };
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
    createPaymentLinkQR,
    createDriverCollectionQR,
    fetchQRCode,
    fetchPaymentLink,
    qrImageFromPaymentLink,
    verifyPaymentSignature,
    verifyWebhookSignature,
    fetchPayment,
    refundPayment,
    razorpayInstance,
};
