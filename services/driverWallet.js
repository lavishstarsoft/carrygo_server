const Driver = require('../models/Driver');
const WalletTransaction = require('../models/WalletTransaction');

const parseFare = (fare) => {
    if (!fare) return {};
    if (typeof fare === 'string') {
        try { return JSON.parse(fare); } catch { return {}; }
    }
    return fare;
};

const roundMoney = (value) => Math.round(Number(value || 0) * 100) / 100;

/**
 * Rapido-style wallet settlement on delivery.
 * Cash: driver keeps physical fare; commission debited from wallet.
 * Online: net driver earnings credited to wallet.
 */
const settleDriverWalletOnDelivery = async (order) => {
    const driverId = String(order.driver_id?._id || order.driver_id || '');
    if (!driverId) return null;

    const existing = await WalletTransaction.findOne({ order_id: String(order._id || order.id) });
    if (existing) return existing;

    const fare = parseFare(order.fare);
    const totalFare = roundMoney(fare.total);
    const commissionAmount = roundMoney(fare.commission_amount);
    const driverEarnings = roundMoney(
        fare.driver_earnings != null ? fare.driver_earnings : totalFare - commissionAmount,
    );
    const commissionPercent = Number(fare.commission_percent) || 0;
    const paymentMethod = order.payment_method || 'cash';
    const isCash = paymentMethod === 'cash';

    const walletDelta = isCash ? -commissionAmount : driverEarnings;

    const driver = await Driver.findById(driverId);
    const balanceBefore = roundMoney(driver?.wallet_balance);
    const balanceAfter = roundMoney(balanceBefore + walletDelta);

    await Driver.findByIdAndUpdate(driverId, {
        $inc: { wallet_balance: walletDelta },
    });

    const tx = await WalletTransaction.create({
        driver_id: driverId,
        order_id: String(order._id || order.id),
        order_number: order.order_number || '',
        type: 'trip_earning',
        payment_method: paymentMethod,
        total_fare: totalFare,
        commission_amount: commissionAmount,
        commission_percent: commissionPercent,
        driver_earnings: driverEarnings,
        wallet_delta: walletDelta,
        balance_after: balanceAfter,
        note: isCash
            ? 'Cash collected from customer — platform commission deducted from wallet'
            : 'Online payment — net earnings credited to wallet',
    });

    return {
        transaction: tx,
        total_fare: totalFare,
        commission_amount: commissionAmount,
        commission_percent: commissionPercent,
        driver_earnings: driverEarnings,
        wallet_delta: walletDelta,
        wallet_balance: balanceAfter,
        payment_method: paymentMethod,
        cash_collected: isCash ? totalFare : 0,
    };
};

module.exports = {
    settleDriverWalletOnDelivery,
    roundMoney,
    parseFare,
};
