// api/send-otp.js
// Emails a six-digit verification code to an applicant.

import crypto from 'crypto';
import { redis, withRetry } from './_lib/redis.js';
import { sendRaw } from './_lib/email.js';
import {
  applyCors,
  handlePreflight,
  rateLimit,
  tooManyRequests,
  clientIp,
  str,
  isEmail,
  esc,
  withErrorHandling,
} from './_lib/http.js';

const OTP_TTL_SECONDS = 600;

const otpEmail = (code) => `
<div style="font-family:Arial,sans-serif;text-align:center;padding:40px;background:#F1F5F9;">
  <div style="max-width:400px;margin:0 auto;background:#FFF;border-radius:12px;padding:32px;border:1px solid #E2E8F0;">
    <h2 style="color:#0F2C59;margin-bottom:8px;">BCCI Membership Verification</h2>
    <p style="color:#64748B;font-size:14px;margin-bottom:24px;">Enter this code to verify your email address</p>
    <div style="font-size:36px;font-weight:bold;letter-spacing:12px;color:#0F2C59;background:#F8FAFC;padding:16px;border-radius:8px;border:2px dashed #D4AF37;">${esc(code)}</div>
    <p style="color:#94A3B8;font-size:12px;margin-top:24px;">This code expires in 10 minutes.</p>
    <p style="color:#94A3B8;font-size:11px;margin-top:8px;">If you didn't request this, you can ignore this email.</p>
  </div>
</div>`;

async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');
  if (handlePreflight(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const email = str(req.body?.email, 254).toLowerCase();
  if (!isEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  // Without these, anyone could loop this endpoint to flood an arbitrary
  // inbox and burn the daily Gmail send quota, taking sign-in down for
  // everyone else.
  const perAddress = await rateLimit(`otp:addr:${email}`, { max: 1, windowSec: 60 });
  if (!perAddress.ok) {
    return tooManyRequests(res, perAddress.retryAfter, `Please wait ${perAddress.retryAfter}s before requesting another code.`);
  }
  const dailyAddress = await rateLimit(`otp:addr:daily:${email}`, { max: 10, windowSec: 86400 });
  if (!dailyAddress.ok) {
    return tooManyRequests(res, dailyAddress.retryAfter, 'Daily verification limit reached for this address. Please try again tomorrow.');
  }
  const perIp = await rateLimit(`otp:ip:${clientIp(req)}`, { max: 20, windowSec: 3600 });
  if (!perIp.ok) {
    return tooManyRequests(res, perIp.retryAfter, 'Too many requests from this network. Please try again later.');
  }

  const otp = crypto.randomInt(100000, 1000000).toString();

  await withRetry(() => redis.set(`bcci:otp:${email}`, otp, { ex: OTP_TTL_SECONDS }));
  // A fresh code clears the failed-attempt counter for the previous one.
  await redis.del(`bcci:rl:otpverify:${email}`).catch(() => {});

  const result = await sendRaw({
    to: email,
    subject: 'Your BCCI Verification Code',
    html: otpEmail(otp),
  });

  if (!result.success) {
    // Don't leave a code the applicant can never receive.
    await redis.del(`bcci:otp:${email}`).catch(() => {});
    return res.status(502).json({
      error: 'We could not send the verification email. Please try again in a moment.',
    });
  }

  console.log(`[OTP] sent to ${email}`);
  return res.status(200).json({ success: true, message: 'Verification code sent to your email.' });
}

export default withErrorHandling('SendOtp', handler);
