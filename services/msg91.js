const axios = require('axios');

const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY;
const MSG91_TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID;
const MSG91_SENDER_ID = process.env.MSG91_SENDER_ID;
const MSG91_BASE_URL = 'https://control.msg91.com/api/v5';

/**
 * Clean phone number — remove non-digit chars and country code
 */
function cleanPhoneNumber(phone) {
    if (!phone) return '';
    phone = phone.replace(/\D/g, '');
    if (phone.startsWith('91') && phone.length > 10) {
        phone = phone.substring(2);
    }
    return phone;
}

/**
 * Format phone for MSG91 (add 91 country code)
 */
function formatPhoneForMSG91(phone) {
    phone = cleanPhoneNumber(phone);
    return `91${phone}`;
}

/**
 * Send OTP via MSG91 Flow API (same approach as server)
 * Generates OTP locally and sends via Flow API with 'var' mapping
 */
const sendOTP = async (phone, otp) => {
    try {
        const formattedMobile = formatPhoneForMSG91(phone);

        const payload = {
            template_id: MSG91_TEMPLATE_ID,
            sender: MSG91_SENDER_ID,
            short_url: '0',
            mobiles: formattedMobile,
            var: otp || '',
        };

        console.log('--- MSG91 Flow API Request ---');
        console.log('Payload:', JSON.stringify(payload));

        const response = await axios.post(
            `${MSG91_BASE_URL}/flow/`,
            payload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    authkey: MSG91_AUTH_KEY,
                },
            }
        );

        console.log('MSG91 Response:', JSON.stringify(response.data));
        return { success: true, data: response.data };
    } catch (error) {
        console.error('MSG91 Send OTP Error:', JSON.stringify(error?.response?.data) || error.message);
        return { success: false, error: error?.response?.data || error.message };
    }
};

/**
 * Verify OTP — now done locally against MongoDB (not MSG91 API)
 */
const verifyOTP = async (phone, otp) => {
    // This is now handled locally in the controller
    // Keeping this function for backward compatibility
    return { success: true };
};

module.exports = { sendOTP, verifyOTP };
