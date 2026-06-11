const Order = require('../models/Order');
const { reconcileAllStaleOnlineDrivers } = require('./driverAvailability');

const STALE_DRIVER_SWEEP_MS = parseInt(process.env.STALE_DRIVER_SWEEP_MS || String(2 * 60 * 1000), 10);
const SEARCHING_ORDER_SWEEP_MS = parseInt(process.env.SEARCHING_ORDER_SWEEP_MS || String(60 * 1000), 10);

let reconcileSearchingOrder = null;

/** Register order dispatch reconciler from orderController (avoids circular imports). */
const registerSearchingReconcile = (fn) => {
    reconcileSearchingOrder = fn;
};

const startProductionJobs = (io) => {
    if (!io) return;

    setInterval(() => {
        reconcileAllStaleOnlineDrivers()
            .then((count) => {
                if (count > 0) {
                    console.log(`🔄 [ProductionJobs] Released stale trip locks: ${count}`);
                }
            })
            .catch((err) => console.error('[ProductionJobs] Stale driver sweep failed:', err.message));
    }, STALE_DRIVER_SWEEP_MS);

    setInterval(async () => {
        if (!reconcileSearchingOrder) return;
        try {
            const stuckOrders = await Order.find({ status: 'searching' }).limit(30);
            for (const order of stuckOrders) {
                await reconcileSearchingOrder(order, io);
            }
        } catch (err) {
            console.error('[ProductionJobs] Searching order sweep failed:', err.message);
        }
    }, SEARCHING_ORDER_SWEEP_MS);

    console.log('✅ [ProductionJobs] Realtime reconciliation jobs started');
};

module.exports = {
    registerSearchingReconcile,
    startProductionJobs,
};
