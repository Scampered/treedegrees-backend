// src/utils/email.js
// Sends emails via Brevo (Sendinblue) SMTP using nodemailer.
// Set BREVO_SMTP_USER and BREVO_SMTP_PASS in your environment variables.

import nodemailer from 'nodemailer';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!process.env.BREVO_SMTP_USER || !process.env.BREVO_SMTP_PASS) {
    console.warn('⚠️ BREVO_SMTP_USER or BREVO_SMTP_PASS not set');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false, // TLS
    auth: {
      user: process.env.BREVO_SMTP_USER,
      pass: process.env.BREVO_SMTP_PASS,
    },
  });

  return transporter;
}

// ── Email templates ────────────────────────────────────────────────────────

function verificationTemplate(nickname, verifyUrl) {
  return {
    subject: '🌳 Verify your TreeDegrees email',
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#082208;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#082208;padding:40px 20px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#0d2b0d;border-radius:16px;border:1px solid #196219;overflow:hidden;max-width:100%;">
        <tr><td style="background:#113f11;padding:24px 32px;text-align:center;">
          <p style="margin:0;font-size:28px;">🌳</p>
          <h1 style="margin:8px 0 0;color:#80d580;font-size:22px;font-weight:700;">TreeDegrees</h1>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="color:#c0e0c0;font-size:16px;margin:0 0 8px;">Hi ${nickname || 'there'},</p>
          <p style="color:#80a080;font-size:14px;margin:0 0 24px;line-height:1.6;">
            Welcome to TreeDegrees! Please verify your email address to activate your account and start connecting with friends.
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${verifyUrl}"
               style="background:#1f7e1f;color:#e0ffe0;text-decoration:none;padding:14px 32px;border-radius:50px;font-size:15px;font-weight:600;display:inline-block;">
              ✅ Verify my email
            </a>
          </div>
          <p style="color:#4d7a4d;font-size:12px;text-align:center;margin:0;">
            This link expires in 24 hours. If you didn't sign up, you can ignore this email.
          </p>
        </td></tr>
        <tr><td style="background:#082208;padding:16px 32px;text-align:center;border-top:1px solid #196219;">
          <p style="color:#2d5a2d;font-size:11px;margin:0;">🌳 TreeDegrees · Your social graph, your way</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    text: `Hi ${nickname || 'there'},\n\nVerify your TreeDegrees email by clicking: ${verifyUrl}\n\nThis link expires in 24 hours.\n\nTreeDegrees`,
  };
}

function letterArrivedTemplate(nickname, senderName, vehicleEmoji) {
  return {
    subject: `${vehicleEmoji} A letter arrived from ${senderName} — TreeDegrees`,
    html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:40px 20px;background:#082208;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#0d2b0d;border-radius:16px;border:1px solid #196219;max-width:100%;">
        <tr><td style="background:#113f11;padding:24px 32px;text-align:center;">
          <p style="margin:0;font-size:36px;">${vehicleEmoji}</p>
          <h2 style="margin:8px 0 0;color:#80d580;font-size:18px;">Letter delivered!</h2>
        </td></tr>
        <tr><td style="padding:28px 32px;">
          <p style="color:#c0e0c0;font-size:15px;margin:0 0 12px;">Hi ${nickname || 'there'},</p>
          <p style="color:#80a080;font-size:14px;margin:0 0 24px;line-height:1.6;">
            A letter from <strong style="color:#c0e0c0;">${senderName}</strong> has just arrived in your TreeDegrees mailbox. Open the app to read it!
          </p>
          <div style="text-align:center;">
            <a href="https://treedegrees.vercel.app/letters"
               style="background:#1f7e1f;color:#e0ffe0;text-decoration:none;padding:12px 28px;border-radius:50px;font-size:14px;font-weight:600;display:inline-block;">
              ✉️ Open my letters
            </a>
          </div>
        </td></tr>
        <tr><td style="background:#082208;padding:16px 32px;text-align:center;border-top:1px solid #196219;">
          <p style="color:#2d5a2d;font-size:11px;margin:0;">🌳 TreeDegrees</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    text: `Hi ${nickname || 'there'},\n\nA letter from ${senderName} just arrived. Open your letters: https://treedegrees.vercel.app/letters\n\nTreeDegrees`,
  };
}

// ── Public send functions ──────────────────────────────────────────────────

export async function sendVerificationEmail(toEmail, nickname, token) {
  console.log("📧 Sending verification email via Brevo...");
  const t = getTransporter();
  if (!t) return false;

  const baseUrl = process.env.FRONTEND_URL || 'https://treedegrees.vercel.app';
  const verifyUrl = `${baseUrl}/verify?token=${token}&email=${encodeURIComponent(toEmail)}`;
  const tmpl = verificationTemplate(nickname, verifyUrl);

  try {
    await t.sendMail({
      from: '"TreeDegrees 🌳" <tree3degrees@gmail.com>',
      to: toEmail,
      subject: tmpl.subject,
      html: tmpl.html,
      text: tmpl.text,
    });
    console.log(`✅ Verification email sent to ${toEmail}`);
    return true;
  } catch (err) {
    console.error('Email send error:', err.message);
    return false;
  }
}

export async function sendLetterArrivedEmail(toEmail, nickname, senderName, vehicleEmoji) {
  const t = getTransporter();
  if (!t) return false;
  const tmpl = letterArrivedTemplate(nickname, senderName, vehicleEmoji);
  try {
    await t.sendMail({
      from: '"TreeDegrees 🌳" <noreply@treedegrees.com>',
      to: toEmail,
      subject: tmpl.subject,
      html: tmpl.html,
      text: tmpl.text,
    });
    return true;
  } catch (err) {
    console.error('Letter email error:', err.message);
    return false;
  }
}