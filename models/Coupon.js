const { createModel } = require('../db/createModel');

const Coupon = createModel('coupons', {
    preSave: async (doc) => {
        if (doc.code) {
            doc.code = doc.code.toUpperCase().trim();
        }
    }
});

module.exports = Coupon;
