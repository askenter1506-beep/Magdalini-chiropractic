const crypto = require('crypto');
const { splitFullName, validateName, validatePhone } = require('../lib/validation');

const DEFAULT_META_PIXEL_ID = '1025014860112458';

function sha256Normalized(value) {
  if (!value) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return (
    req.headers['x-real-ip'] ||
    (req.socket && req.socket.remoteAddress) ||
    ''
  );
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

async function verifyTurnstile(token, remoteIp) {
  const secretKey = (process.env.TURNSTILE_SECRET_KEY || '').trim();
  if (!secretKey) {
    throw new Error('Turnstile is not configured');
  }
  if (!token) {
    return { verified: false, reason: 'missing-token' };
  }

  const body = new URLSearchParams();
  body.append('secret', secretKey);
  body.append('response', token);
  if (remoteIp) body.append('remoteip', remoteIp);

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    throw new Error(`Turnstile HTTP ${response.status}`);
  }
  const data = await response.json();
  return {
    verified: Boolean(data.success),
    errorCodes: data['error-codes'] || []
  };
}

async function sheetOperation(lead, operation, extra = {}) {
  const webhookUrl = (process.env.GOOGLE_SHEET_WEBHOOK_URL || '').trim();
  const secret = (process.env.GOOGLE_SHEET_WEBHOOK_SECRET || '').trim();
  if (!webhookUrl || !secret) throw new Error('Required spreadsheet configuration is missing');
  const response = await fetch(webhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
    body: JSON.stringify({ operation, secret, eventId: lead.eventId, timestampCyprus: lead.timestampCyprus, timestampIso: lead.timestampIso, fullName: lead.fullName, phoneE164: lead.phone.e164, phoneFormatted: lead.phone.formatted, pageUrl: lead.pageUrl, formLocation: lead.formLocation, utmSource: lead.utm.source, utmMedium: lead.utm.medium, utmCampaign: lead.utm.campaign, utmContent: lead.utm.content, utmTerm: lead.utm.term, ...extra }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('Spreadsheet request failed');
  const result = await response.json();
  if (!result || result.ok !== true || result.protocolVersion !== 2 || result.eventId !== lead.eventId) throw new Error('Spreadsheet did not explicitly confirm this request');
  return result;
}

function missingConfiguration() {
  const missing = ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'GOOGLE_SHEET_WEBHOOK_URL', 'GOOGLE_SHEET_WEBHOOK_SECRET'].filter(key => !(process.env[key] || '').trim());
  const emailReady = process.env.RESEND_API_KEY && process.env.NOTIFICATION_EMAIL;
  const smsReady = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && (process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_MESSAGING_SERVICE_SID) && process.env.NOTIFICATION_SMS_TO;
  if (!emailReady && !smsReady) missing.push('NOTIFICATION_CHANNEL');
  return missing;
}

function safePageUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.origin + url.pathname : ''; } catch { return ''; }
}

async function sendResendEmail(lead) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const toRaw = (process.env.NOTIFICATION_EMAIL || '').trim();
  if (!apiKey || !toRaw) return { configured: false };

  const fromEmail =
    (process.env.RESEND_FROM_EMAIL || '').trim() ||
    'Magdalini Chiropractic Leads <onboarding@resend.dev>';
  const recipients = toRaw
    .split(',')
    .map((addr) => addr.trim())
    .filter(Boolean);

  const escapeHtml = (str) =>
    String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #111c2c;">
      <div style="background: #00385d; color: #ffffff; padding: 24px 28px; border-radius: 14px 14px 0 0;">
        <div style="font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; color: #aff2c5; font-weight: 700;">Speed-to-Lead Alert</div>
        <h1 style="margin: 6px 0 0; font-size: 22px; line-height: 1.25;">New Callback Request</h1>
      </div>
      <div style="background: #ffffff; padding: 28px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 14px 14px;">
        <p style="margin: 0 0 18px; font-size: 15px; color: #4e5765;">
          Please return this callback request <strong>during clinic working hours</strong> from <strong>+357 99 373304</strong>:
        </p>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 22px;">
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #edf2f7; color: #4e5765; width: 130px;">Full Name</td>
            <td style="padding: 10px 0; border-bottom: 1px solid #edf2f7; font-weight: 700; font-size: 16px;">${escapeHtml(lead.fullName)}</td>
          </tr>
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #edf2f7; color: #4e5765;">Phone Number</td>
            <td style="padding: 10px 0; border-bottom: 1px solid #edf2f7; font-weight: 700; font-size: 18px; color: #00385d;">
              <a href="tel:${escapeHtml(lead.phone.e164)}" style="color: #00385d; text-decoration: none;">${escapeHtml(lead.phone.formatted)}</a>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #edf2f7; color: #4e5765;">Submitted</td>
            <td style="padding: 10px 0; border-bottom: 1px solid #edf2f7;">${escapeHtml(lead.timestampCyprus)} (Cyprus time)</td>
          </tr>
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #edf2f7; color: #4e5765;">Form</td>
            <td style="padding: 10px 0; border-bottom: 1px solid #edf2f7;">${escapeHtml(lead.formLocation || 'Landing Page')}</td>
          </tr>
          ${
            lead.utm.campaign || lead.utm.source
              ? `<tr>
                  <td style="padding: 10px 0; border-bottom: 1px solid #edf2f7; color: #4e5765;">Campaign</td>
                  <td style="padding: 10px 0; border-bottom: 1px solid #edf2f7;">${escapeHtml([lead.utm.source, lead.utm.medium, lead.utm.campaign].filter(Boolean).join(' / '))}</td>
                </tr>`
              : ''
          }
        </table>
        <a href="tel:${escapeHtml(lead.phone.e164)}" style="display: inline-block; background: #2a6a47; color: #ffffff; text-decoration: none; font-weight: 700; padding: 14px 26px; border-radius: 999px; font-size: 15px;">
          Call ${escapeHtml(lead.firstName)} Now (${escapeHtml(lead.phone.formatted)})
        </a>
      </div>
    </div>
  `;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Idempotency-Key': lead.eventId,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: fromEmail,
      to: recipients,
      subject: `Call Back Now: ${lead.fullName} (${lead.phone.formatted})`,
      html,
      text: `New Callback Request (call during clinic working hours)\nName: ${lead.fullName}\nPhone: ${lead.phone.formatted}\nTime: ${lead.timestampCyprus}\nPage: ${lead.pageUrl}`
    }),
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Resend failed (${response.status}): ${text.slice(0, 200)}`);
  }

  return { configured: true, ok: true };
}

async function sendTwilioSms(lead) {
  const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  const fromNumber = (process.env.TWILIO_FROM_NUMBER || '').trim();
  const messagingServiceSid = (process.env.TWILIO_MESSAGING_SERVICE_SID || '').trim();
  const toRaw = (process.env.NOTIFICATION_SMS_TO || '').trim();

  if (!accountSid || !authToken || (!fromNumber && !messagingServiceSid) || !toRaw) {
    return { configured: false };
  }

  const recipients = toRaw
    .split(',')
    .map((num) => num.trim())
    .filter(Boolean);

  const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const messageBody = `New callback lead (${lead.timestampCyprus}):\n${lead.fullName}\n${lead.phone.formatted}\nPlease call during clinic working hours.`;

  const results = await Promise.all(
    recipients.map(async (to) => {
      const form = new URLSearchParams();
      form.append('To', to);
      if (messagingServiceSid) {
        form.append('MessagingServiceSid', messagingServiceSid);
      } else {
        form.append('From', fromNumber);
      }
      form.append('Body', messageBody);

      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: form.toString(),
          signal: AbortSignal.timeout(10000)
        }
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Twilio SMS to ${to} failed (${response.status}): ${text.slice(0, 200)}`);
      }
      return true;
    })
  );

  return { configured: true, ok: results.every(Boolean) };
}

async function sendMetaCapiLead(lead) {
  const accessToken = (process.env.META_CAPI_ACCESS_TOKEN || '').trim();
  const pixelId = (process.env.META_PIXEL_ID || DEFAULT_META_PIXEL_ID).trim();
  if (!accessToken || !pixelId) return { configured: false };

  const userData = {
    ph: [sha256Normalized(lead.phone.digitsWithCountry)],
    fn: [sha256Normalized(lead.firstName)],
    ...(lead.phone.country ? { country: [sha256Normalized(lead.phone.country)] } : {})
  };
  if (lead.lastName) {
    userData.ln = [sha256Normalized(lead.lastName)];
  }
  if (lead.clientIp) {
    userData.client_ip_address = lead.clientIp;
  }
  if (lead.userAgent) {
    userData.client_user_agent = lead.userAgent;
  }
  if (lead.fbp) {
    userData.fbp = lead.fbp;
  }
  if (lead.fbc) {
    userData.fbc = lead.fbc;
  }

  const eventPayload = {
    data: [
      {
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        event_id: lead.eventId,
        action_source: 'website',
        event_source_url: lead.pageUrl || 'https://magdalinichiropractic.cy/',
        user_data: userData,
        custom_data: {
          content_name: 'Callback Request',
          lead_type: 'phone_callback',
          form_location: lead.formLocation || 'hero'
        }
      }
    ]
  };

  const testEventCode = (process.env.META_TEST_EVENT_CODE || '').trim();
  if (testEventCode) {
    eventPayload.test_event_code = testEventCode;
  }

  const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(eventPayload),
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Meta CAPI failed (${response.status}): ${text.slice(0, 200)}`);
  }

  return { configured: true, ok: true };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, error: 'Method not allowed' }); }
  const body = parseBody(req);
  if (String(body.website || '').trim()) return res.status(200).json({ ok: true, trackLead: false });
  const nameCheck = validateName(body.fullName);
  if (!nameCheck.valid) return res.status(400).json({ ok: false, field: 'fullName', error: nameCheck.message });
  const phoneCheck = validatePhone(body.phone);
  if (!phoneCheck.valid) return res.status(400).json({ ok: false, field: 'phone', error: phoneCheck.message });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(body.submissionId || ''))) return res.status(400).json({ ok: false, code: 'REQUEST_ID_REQUIRED', error: 'Please reload the page and try again.' });
  const missing = missingConfiguration();
  if (missing.length) { console.error('[lead] Missing configuration names:', missing); return res.status(503).json({ ok: false, code: 'FORM_UNAVAILABLE', error: 'Online callback requests are temporarily unavailable. Please call us instead.' }); }
  const clientIp = getClientIp(req);
  try {
    const check = await verifyTurnstile(body.turnstileToken, clientIp);
    if (!check.verified) return res.status(403).json({ ok: false, code: 'TURNSTILE_FAILED', error: 'Please complete the security check and try again.' });
  } catch { return res.status(503).json({ ok: false, code: 'TURNSTILE_UNAVAILABLE', error: 'The security check is unavailable. Please try again or call us.' }); }
  const nameParts = splitFullName(nameCheck.cleaned);
  const now = new Date();
  const timestampCyprus = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Nicosia', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);
  const utm = body.utm && typeof body.utm === 'object' ? body.utm : {};
  const lead = { ...nameParts, eventId: 'lead_' + body.submissionId.toLowerCase(), timestampIso: now.toISOString(), timestampCyprus, phone: phoneCheck, pageUrl: safePageUrl(body.pageUrl), formLocation: String(body.formLocation || 'hero').slice(0, 60), fbp: String(body.fbp || '').slice(0, 200), fbc: String(body.fbc || '').slice(0, 400), clientIp, userAgent: String(req.headers['user-agent'] || '').slice(0, 400), utm: Object.fromEntries(['source', 'medium', 'campaign', 'content', 'term'].map(key => [key, String(utm['utm_' + key] || '').slice(0, 120)])) };
  let capture;
  try { capture = await sheetOperation(lead, 'capture'); }
  catch { console.error('[lead] Storage not confirmed', lead.eventId); return res.status(503).json({ ok: false, code: 'STORAGE_UNCONFIRMED', error: 'We could not confirm your request. Please retry or call us instead.' }); }
  if (capture.state !== 'notified') {
    if (!capture.claimToken) return res.status(409).json({ ok: false, code: 'REQUEST_IN_PROGRESS', error: 'Your request is still being processed. Please wait a moment and retry.' });
    const results = await Promise.allSettled([sendResendEmail(lead), sendTwilioSms(lead)]);
    const channels = results.flatMap((result, index) => result.status === 'fulfilled' && result.value && result.value.configured && result.value.ok ? [index === 0 ? 'email' : 'sms'] : []);
    let completion;
    try { completion = await sheetOperation(lead, 'complete', { claimToken: capture.claimToken, notificationSucceeded: channels.length > 0, channels }); }
    catch { return res.status(503).json({ ok: false, code: 'CONFIRMATION_PENDING', error: 'Your details were saved, but confirmation is delayed. Please retry or call us.' }); }
    if (!channels.length || completion.state !== 'notified') return res.status(503).json({ ok: false, code: 'NOTIFICATION_PENDING', error: 'Your details were saved, but we could not alert the clinic. Please retry or call us instead.' });
  }
  try { await sendMetaCapiLead(lead); } catch { console.error('[lead] Meta event delivery failed', lead.eventId); }
  return res.status(200).json({ ok: true, trackLead: true, eventId: lead.eventId, firstName: lead.firstName, lastName: lead.lastName, phoneFormatted: lead.phone.formatted, phoneDigits: lead.phone.digitsWithCountry, country: lead.phone.country.toLowerCase() });
};
