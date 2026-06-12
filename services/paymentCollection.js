const Payment = require('../models/Payment');
const Order = require('../models/Order');
const { splitFareCommission } = require('./fareCalculation');

const parseFare = (fare) => {
    if (!fare) return {};
    if (typeof fare === 'string') {
        try { return JSON.parse(fare); } catch { return {}; }
    }
    return fare;
};

const emitPaymentUpdate = (io, order, payment) => {
    if (!io || !order?.driver_id) return;
    const driverId = String(order.driver_id?._id || order.driver_id);
    const payload = {
        order_id: String(order._id || order.id),
        payment_status: 'completed',
        method: payment.method,
        amount: payment.amount,
    };
    io.to(`driver_${driverId}`).emit(`payment_update_${driverId}`, payload);
    io.emit(`payment_update_${driverId}`, payload);
};

/**
 * Mark order payment complete and upsert payment record.
 */
const completeOrderPayment = async (order, method, extra = {}, io = null) => {
    const fare = parseFare(order.fare);
    const split = splitFareCommission(fare.total, fare.commission_percent || 15);

    let payment = await Payment.findOne({ order_id: String(order._id || order.id) });

    if (payment?.status === 'completed') {
        return { alreadyCompleted: true, payment, order };
    }

    const paymentData = {
        order_id: order._id,
        user_id: order.user_id?._id || order.user_id,
        driver_id: order.driver_id?._id || order.driver_id,
        amount: split.total,
        method,
        status: 'completed',
        platform_commission: split.commission_amount,
        driver_earnings: split.driver_earnings,
        ...extra,
    };

    if (payment) {
        payment.amount = paymentData.amount;
        payment.method = paymentData.method;
        payment.status = paymentData.status;
        payment.platform_commission = paymentData.platform_commission;
        payment.driver_earnings = paymentData.driver_earnings;
        if (extra.razorpay_order_id) payment.razorpay_order_id = extra.razorpay_order_id;
        if (extra.razorpay_payment_id) payment.razorpay_payment_id = extra.razorpay_payment_id;
        if (extra.razorpay_signature) payment.razorpay_signature = extra.razorpay_signature;
        await payment.save();
    } else {
        payment = await Payment.create(paymentData);
    }

    order.payment_status = 'completed';
    order.payment_method = method;
    order.payment_id = payment._id;
    await order.save();

    emitPaymentUpdate(io, order, payment);

    return { payment, order, split };
};

module.exports = {
    parseFare,
    completeOrderPayment,
    emitPaymentUpdate,
};
