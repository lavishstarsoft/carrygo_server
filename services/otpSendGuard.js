const Otp = require('../models/Otp');

const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const OTP_EXPIRY_MS = 10 * 60 * 1000;

/**
 * Prevent rapid OTP spam per phone while still allowing normal resend flow.
 */
const assertCanSendOtp = async (phone) => {
    const existing = await Otp.findOne({ phone });
    if (!existing?.updatedAt) return { ok: true };

    const elapsed = Date.now() - new Date(existing.updatedAt).getTime();
    if (elapsed < OTP_RESEND_COOLDOWN_MS) {
        const retry_after = Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000);
        return {
            ok: false,
            status: 429,
            error: `Please wait ${retry_after} seconds before requesting another OTP`,
            retry_after,
            code: 'OTP_COOLDOWN',
        };
    }

    return { ok: true };
};

module.exports = {
    OTP_EXPIRY_MS,
    assertCanSendOtp,
};
