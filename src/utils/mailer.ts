import config from '../config';
import { createHttpError } from './httpError';

interface OtpEmailPayload {
  email: string;
  otp: string;
  subject: string;
  title: string;
  preheader: string;
}

const buildHtml = ({ title, preheader, otp }: OtpEmailPayload): string => `
  <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
    <h2 style="margin-bottom: 8px;">${title}</h2>
    <p style="margin: 0 0 16px;">${preheader}</p>
    <div style="display: inline-block; padding: 12px 20px; border-radius: 10px; background: #f3f4f6; font-size: 28px; font-weight: 700; letter-spacing: 8px;">
      ${otp}
    </div>
    <p style="margin-top: 16px;">This code expires in 10 minutes.</p>
  </div>
`;

const sendOtpEmail = async (payload: OtpEmailPayload): Promise<void> => {
  if (!config.resend.apiKey) {
    console.log(`[MAIL_FALLBACK] ${payload.subject} for ${payload.email}: ${payload.otp}`);
    return;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resend.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: `${config.resend.fromName} <${config.resend.fromEmail}>`,
      to: [payload.email],
      subject: payload.subject,
      text: `${payload.preheader} Your OTP is ${payload.otp}. This code expires in 10 minutes.`,
      html: buildHtml(payload)
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw createHttpError('Failed to send email OTP', 502, {
      code: 'MAIL_DELIVERY_FAILED',
      details
    });
  }
};

export const sendRegistrationOtpEmail = async ({ email, otp }: { email: string; otp: string }): Promise<void> => {
  await sendOtpEmail({
    email,
    otp,
    subject: 'Verify your Fitco account',
    title: 'Confirm your email',
    preheader: 'Use the verification code below to finish creating your Fitco account.'
  });
};

export const sendPasswordResetEmail = async ({ email, otp }: { email: string; otp: string }): Promise<void> => {
  await sendOtpEmail({
    email,
    otp,
    subject: 'Reset your Fitco password',
    title: 'Password reset verification',
    preheader: 'Use the verification code below to continue resetting your password.'
  });
};
