'use strict';
/**
 * What a signed-in person may be sent about their own account and school.
 *
 * The session answer (sign-in, /auth/me) and the profile read used to send the
 * whole School row — its SMTP password and payment-gateway secret keys
 * included — and the profile read sent the caller's own password hash. No
 * screen reads any of them; they are credentials the school office stored,
 * and with the admission portal any member of the public can open an
 * (applicant) session. They are stripped here, in one place.
 */

const PRIVATE_USER_FIELDS = ['password', 'otp', 'otpExpiry', 'resetToken', 'resetTokenExpiry', 'loginToken', 'loginTokenExpiry'];

/** A school without the credentials its office configured. */
function publicSchool(school) {
    if (!school || typeof school !== 'object') return school;
    const plain = typeof school.toObject === 'function' ? school.toObject() : school;
    const { smtp, paymentGateway, ...rest } = plain;
    const out = { ...rest };
    if (smtp && typeof smtp === 'object') {
        out.smtp = { enabled: !!smtp.enabled, fromName: smtp.fromName || '', fromEmail: smtp.fromEmail || '' };
    }
    if (paymentGateway && typeof paymentGateway === 'object') {
        const { razorpayKeySecret, stripeSecretKey, ...gateway } = paymentGateway;
        out.paymentGateway = gateway;
    }
    return out;
}

/** A user row without its credentials, and with its school made public. */
function publicUser(user) {
    if (!user || typeof user !== 'object') return user;
    const plain = typeof user.toObject === 'function' ? user.toObject() : { ...user };
    for (const k of PRIVATE_USER_FIELDS) delete plain[k];
    if (plain.school && typeof plain.school === 'object') plain.school = publicSchool(plain.school);
    return plain;
}

module.exports = { publicSchool, publicUser, PRIVATE_USER_FIELDS };
