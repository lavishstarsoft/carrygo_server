const mongoose = require('mongoose');

const coordinateSchema = new mongoose.Schema({
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
}, { _id: false });

const deliveryZoneSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: { type: String, default: '' },
    type: { type: String, enum: ['polygon', 'circle'], default: 'polygon' },
    coordinates: { type: [coordinateSchema], default: [] },
    center: { type: coordinateSchema },
    radius: { type: Number },  // in meters
    color: { type: String, default: '#0891b2' }, // Cyan 600
    isActive: { type: Boolean, default: true },
    delivery_fee: { type: Number, default: 0 },
    min_order: { type: Number, default: 0 },
    free_delivery_above: { type: Number, default: 0 },
    est_delivery_time: { type: String, default: '2-3 days' },
}, { timestamps: true, collection: 'delivery_zones' });

deliveryZoneSchema.index({ isActive: 1 });

module.exports = mongoose.model('DeliveryZone', deliveryZoneSchema);
