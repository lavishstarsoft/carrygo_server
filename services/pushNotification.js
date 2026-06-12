const axios = require('axios');

/**
 * Sends a push notification using OneSignal REST API.
 * Targets recipients by their external_id (which is their MongoDB ObjectId).
 * 
 * @param {string} recipientId - The ID of the recipient user or driver.
 * @param {string} recipientModel - Either 'Driver' or 'User'.
 * @param {string} title - The notification title.
 * @param {string} body - The notification message body.
 * @param {Object} [data] - Optional metadata attachment payload.
 */
const sendPushNotification = async (recipientId, recipientModel, title, body, data = {}) => {
    try {
        const onesignalAppId = process.env.ONESIGNAL_APP_ID;
        const onesignalApiKey = process.env.ONESIGNAL_REST_API_KEY;

        if (!onesignalAppId || !onesignalApiKey) {
            console.warn('[PushService] OneSignal credentials (ONESIGNAL_APP_ID/ONESIGNAL_REST_API_KEY) are not set in environment variables.');
            return;
        }

        console.log(`[PushService] Sending push to ${recipientModel} ${recipientId} via OneSignal external_id`);

        const payload = {
            app_id: onesignalAppId,
            include_aliases: {
                external_id: [recipientId.toString()]
            },
            target_channel: "push",
            headings: {
                en: title
            },
            contents: {
                en: body
            },
            data: {
                ...data,
                recipientId: recipientId.toString(),
                recipientModel
            }
        };

        const authHeader = onesignalApiKey.startsWith('Key ')
            ? onesignalApiKey
            : `Key ${onesignalApiKey}`;

        const response = await axios.post('https://api.onesignal.com/notifications', payload, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': authHeader,
            },
        });

        console.log('[PushService] OneSignal response:', response.data);
        return response.data;
    } catch (error) {
        console.error('[PushService] Error dispatching OneSignal push notification:', error.message);
        if (error.response) {
            console.error('[PushService] OneSignal API Error Response:', error.response.data);
        }
    }
};

module.exports = { sendPushNotification };
