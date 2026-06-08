const { createModel } = require('../db/createModel');

const Notification = createModel('notifications', {
    postSave: async (doc) => {
        if (doc.relatedId && (doc.onModel === 'Driver' || doc.onModel === 'User')) {
            try {
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
    },
});

module.exports = Notification;
