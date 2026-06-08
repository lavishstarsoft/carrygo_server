const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true
    },
    message: {
        type: String,
        required: true
    },
    type: {
        type: String,
        enum: ['driver_registered', 'order_placed', 'system_alert', 'kyc_approved', 'kyc_rejected', 'kyc_action_required', 'kyc_status_reset', 'driver_block_status'],
        default: 'system_alert'
    },
    relatedId: {
        type: mongoose.Schema.Types.ObjectId,
        refPath: 'onModel'
    },
    onModel: {
        type: String,
        enum: ['Driver', 'Order', 'User']
    },
    isRead: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Post-save hook to automatically trigger push notifications
notificationSchema.post('save', async function (doc) {
    if (doc.relatedId && (doc.onModel === 'Driver' || doc.onModel === 'User')) {
        try {
            // Lazy load the helper to avoid circular dependencies
            const { sendPushNotification } = require('../services/pushNotification');
            await sendPushNotification(
                doc.relatedId.toString(),
                doc.onModel,
                doc.title,
                doc.message,
                { type: doc.type, notificationId: doc._id.toString() }
            );
        } catch (err) {
            console.error('[NotificationHook] Error during post-save hook:', err);
        }
    }
});

module.exports = mongoose.model('Notification', notificationSchema);

