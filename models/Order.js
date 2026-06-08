const { createModel } = require('../db/createModel');

const Order = createModel('orders', {
    preSave: async (doc) => {
        if (!doc.order_number) {
            const count = await Order.countDocuments();
            doc.order_number = `CG-${String(count + 1001).padStart(6, '0')}`;
        }
    },
});

module.exports = Order;
