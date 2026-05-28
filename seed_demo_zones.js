const mongoose = require('mongoose');
require('dotenv').config();

// Models
const DeliveryZone = require('./models/DeliveryZone');
const Pricing = require('./models/Pricing');

const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://manabazar:ashokca810A@cluster0.yvzhmgp.mongodb.net/carrygo?appName=Cluster0";

async function seedDemoData() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("Connected to MongoDB for seeding...");

        // 1. Clear existing demo data
        await DeliveryZone.deleteMany({ name: { $in: ["Vijayawada Core", "Guntur Central Hub"] } });
        
        // 2. Create Vijayawada Zone (Polygon around commercial areas)
        const vijayawada = await DeliveryZone.create({
            name: "Vijayawada Core",
            description: "Coverage including Benz Circle, Benz Garden, and MG Road area.",
            type: "polygon",
            coordinates: [
                { lat: 16.5126, lng: 80.6300 },
                { lat: 16.5250, lng: 80.6480 },
                { lat: 16.5050, lng: 80.6550 },
                { lat: 16.4950, lng: 80.6400 }
            ],
            color: "#0891b2", // Cyan
            isActive: true,
            delivery_fee: 50,
            min_order: 200,
            free_delivery_above: 500,
            est_delivery_time: "30-45 mins"
        });
        console.log("Seeded Vijayawada Polygon Zone");

        // 3. Create Guntur Zone (Circle demo)
        const guntur = await DeliveryZone.create({
            name: "Guntur Central Hub",
            description: "5km coverage from the municipal center.",
            type: "circle",
            center: { lat: 16.3067, lng: 80.4365 },
            radius: 5000,
            color: "#8b5cf6", // Violet
            isActive: true,
            delivery_fee: 40,
            min_order: 150,
            free_delivery_above: 400,
            est_delivery_time: "40-60 mins"
        });
        console.log("Seeded Guntur Circle Zone");

        // 4. Create Pricing Matrix for these zones
        const pricingRules = [
            {
                city: "Vijayawada",
                vehicle_type: "2w",
                vehicle_body_type: "all",
                delivery_zone: vijayawada._id,
                base_fare: 45,
                base_km: 2,
                per_km_rate: 15,
                per_min_rate: 1.5,
                min_fare: 60,
                platform_commission_percent: 15,
                active: true
            },
            {
                city: "Guntur",
                vehicle_type: "2w",
                vehicle_body_type: "all",
                delivery_zone: guntur._id,
                base_fare: 35,
                base_km: 3,
                per_km_rate: 12,
                per_min_rate: 1,
                min_fare: 50,
                platform_commission_percent: 12,
                active: true
            }
        ];

        for (const rule of pricingRules) {
            await Pricing.findOneAndUpdate(
                { city: rule.city, vehicle_type: rule.vehicle_type, delivery_zone: rule.delivery_zone },
                rule,
                { upsert: true, new: true }
            );
        }
        console.log("Seeded detailed Pricing Matrix rules.");

        console.log("Demo Seeding Successfully Completed!");
        process.exit(0);
    } catch (error) {
        console.error("Seeding failed:", error);
        process.exit(1);
    }
}

seedDemoData();
