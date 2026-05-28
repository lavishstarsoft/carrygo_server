require('dotenv').config();
const mongoose = require('mongoose');
const Driver = require('./models/Driver');

(async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const lat = 17.385; // roughly hyderabad
        const lng = 78.486; 

        // Let's print ALL drivers first to see their exact status
        const allDrivers = await Driver.find({}).lean();
        console.log("ALL DRIVERS:", JSON.stringify(allDrivers.map(d => ({
            id: d._id, name: d.name, active: d.is_active, kyc: d.kyc_status, 
            vehicle: d.vehicle_type, location: d.location
        })), null, 2));

        const drivers = await Driver.find({
            is_active: true,
            is_on_trip: false,
            is_blocked: false,
            kyc_status: 'approved',
            // Try without location filter first
        }).lean();
        
        console.log("MATCH STATUS ONLY:", drivers.length);

        const geoDrivers = await Driver.find({
            location: {
                $near: {
                    $geometry: {
                        type: 'Point',
                        coordinates: [lng, lat]
                    },
                    $maxDistance: 100000 // 100km just to test
                }
            }
        }).lean();
        console.log("MATCH GEO ONLY:", geoDrivers.length);

        const exactDrivers = await Driver.find({
             is_active: true,
            is_on_trip: false,
            is_blocked: false,
            kyc_status: 'approved',
            // vehicle_type: '2w',
            location: {
                $near: {
                    $geometry: {
                        type: 'Point',
                        coordinates: [lng, lat],
                    },
                    $maxDistance: 10000, 
                },
            },
        });
        console.log("EXACT MATCH DRIVERS:", exactDrivers.length);
        
        process.exit(0);
    } catch(err) {
        console.error(err);
        process.exit(1);
    }
})();
