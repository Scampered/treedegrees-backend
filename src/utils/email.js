// src/utils/email.js — sends via Brevo HTTP API (no SMTP needed)
// Required env var: BREVO_API_KEY
// Sender: tree3degrees@gmail.com (must be verified in Brevo)

const BREVO_URL    = 'https://api.brevo.com/v3/smtp/email';
const FROM_EMAIL   = 'tree3degrees@gmail.com';
const FROM_NAME    = 'TreeDegrees';
const BASE_URL     = () => process.env.FRONTEND_URL || 'https://treedegrees.vercel.app';

async function sendBrevo(toEmail, subject, html, text = '') {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn('⚠️  BREVO_API_KEY not set — email disabled');
    return false;
  }
  console.log(`📧 Sending email via Brevo API to ${toEmail} — "${subject}"`);
  try {
    const res = await fetch(BREVO_URL, {
      method: 'POST',
      headers: {
        'accept':       'application/json',
        'api-key':      apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender:   { name: FROM_NAME, email: FROM_EMAIL },
        to:       [{ email: toEmail }],
        subject,
        htmlContent: html,
        textContent: text || subject,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('❌ Brevo send failed:', res.status, err);
      return false;
    }
    console.log(`✅ Email sent to ${toEmail}`);
    return true;
  } catch (e) {
    console.error('❌ Brevo fetch error:', e.message);
    return false;
  }
}

// ── Templates ─────────────────────────────────────────────────────────────────
function verificationTemplate(nickname, verifyUrl) {
  return {
    subject: '🌳 Verify your TreeDegrees email',
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
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
            Welcome to TreeDegrees! Please verify your email address to activate your account.
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${verifyUrl}" style="background:#1f7e1f;color:#e0ffe0;text-decoration:none;padding:14px 32px;border-radius:50px;font-size:15px;font-weight:600;display:inline-block;">
              ✅ Verify my email
            </a>
          </div>
          <p style="color:#4d7a4d;font-size:12px;text-align:center;margin:0;">
            This link expires in 24 hours. If you didn't sign up, ignore this email.
          </p>
        </td></tr>
        <tr><td style="background:#082208;padding:16px 32px;text-align:center;border-top:1px solid #196219;">
          <p style="color:#2d5a2d;font-size:11px;margin:0;">🌳 TreeDegrees · Your social graph, your way</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
    text: `Hi ${nickname || 'there'},\n\nVerify your TreeDegrees email: ${verifyUrl}\n\nExpires in 24 hours.\n\nTreeDegrees`,
  };
}

function letterArrivedTemplate(nickname, senderName, vehicleEmoji) {
  return {
    subject: `${vehicleEmoji} A letter arrived from ${senderName} — TreeDegrees`,
    html: `<!DOCTYPE html><html><body style="margin:0;padding:40px 20px;background:#082208;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table width="480" cellpadding="0" cellspacing="0" style="background:#0d2b0d;border-radius:16px;border:1px solid #196219;max-width:100%;">
      <tr><td style="background:#113f11;padding:24px 32px;text-align:center;">
        <p style="margin:0;font-size:36px;">${vehicleEmoji}</p>
        <h2 style="margin:8px 0 0;color:#80d580;font-size:18px;">Letter delivered!</h2>
      </td></tr>
      <tr><td style="padding:28px 32px;">
        <p style="color:#c0e0c0;font-size:15px;margin:0 0 12px;">Hi ${nickname || 'there'},</p>
        <p style="color:#80a080;font-size:14px;margin:0 0 24px;line-height:1.6;">
          A letter from <strong style="color:#c0e0c0;">${senderName}</strong> just arrived in your TreeDegrees mailbox.
        </p>
        <div style="text-align:center;">
          <a href="https://treedegrees.vercel.app/letters" style="background:#1f7e1f;color:#e0ffe0;text-decoration:none;padding:12px 28px;border-radius:50px;font-size:14px;font-weight:600;display:inline-block;">
            ✉️ Open my letters
          </a>
        </div>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`,
    text: `Hi ${nickname || 'there'},\n\nA letter from ${senderName} just arrived. Open your letters: https://treedegrees.vercel.app/letters\n\nTreeDegrees`,
  };
}

function resetPasswordTemplate(nickname, resetUrl) {
  return {
    subject: '🔑 Reset your TreeDegrees password',
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#082208;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#082208;padding:40px 20px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#0d2b0d;border-radius:16px;border:1px solid #196219;overflow:hidden;max-width:100%;">
        <tr><td style="background:#113f11;padding:24px 32px;text-align:center;">
          <p style="margin:0;font-size:28px;">🔑</p>
          <h1 style="margin:8px 0 0;color:#80d580;font-size:22px;font-weight:700;">TreeDegrees</h1>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="color:#c0e0c0;font-size:16px;margin:0 0 8px;">Hi ${nickname || 'there'},</p>
          <p style="color:#80a080;font-size:14px;margin:0 0 24px;line-height:1.6;">
            We received a request to reset your password. Click below to set a new one:
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${resetUrl}" style="background:#1f7e1f;color:#e0ffe0;text-decoration:none;padding:14px 32px;border-radius:50px;font-size:15px;font-weight:600;display:inline-block;">
              🔑 Reset my password
            </a>
          </div>
          <p style="color:#4d7a4d;font-size:12px;text-align:center;margin:0;">
            This link expires in 1 hour. If you didn't request this, ignore this email.
          </p>
        </td></tr>
        <tr><td style="background:#082208;padding:16px 32px;text-align:center;border-top:1px solid #196219;">
          <p style="color:#2d5a2d;font-size:11px;margin:0;">🌳 TreeDegrees · Your social graph, your way</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
    text: `Hi ${nickname || 'there'},\n\nReset your TreeDegrees password: ${resetUrl}\n\nExpires in 1 hour.\n\nTreeDegrees`,
  };
}

// ── Public send functions ─────────────────────────────────────────────────────

export async function sendVerificationEmail(toEmail, nickname, token) {
  const verifyUrl = `${BASE_URL()}/verify?token=${token}&email=${encodeURIComponent(toEmail)}`;
  const { subject, html, text } = verificationTemplate(nickname, verifyUrl);
  return sendBrevo(toEmail, subject, html, text);
}

export async function sendLetterArrivedEmail(toEmail, nickname, senderName, vehicleEmoji) {
  const { subject, html, text } = letterArrivedTemplate(nickname, senderName, vehicleEmoji);
  return sendBrevo(toEmail, subject, html, text);
}

export async function sendPasswordResetEmail(toEmail, nickname, token) {
  const resetUrl = `${BASE_URL()}/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(toEmail)}`;
  const { subject, html, text } = resetPasswordTemplate(nickname, resetUrl);
  return sendBrevo(toEmail, subject, html, text);
}
