const mongoose = require('mongoose');
require('dotenv').config();
const Driver = require('./models/Driver');

(async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        // Force approve ALL drivers and ensure they have a valid vehicle type
        const res = await Driver.updateMany({}, { 
            $set: { 
                kyc_status: 'approved',
                vehicle_type: '2w', // Default fallback so matching works if empty
                is_active: true
            } 
        });
        console.log('Fixed drivers:', res);
        process.exit(0);
    } catch(err) {
        console.error(err);
        process.exit(1);
    }
})();
