const crypto = require('crypto');

const DEFAULT_META_PIXEL_ID = '1025014860112458';
const VALID_CYPRUS_FIRST_DIGITS = new Set(['2', '7', '8', '9']);
const MIN_HUMAN_SUBMIT_MS = 700;

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

function splitFullName(fullName) {
  const cleaned = String(fullName || '').trim().replace(/\s+/g, ' ');
  const firstSpace = cleaned.indexOf(' ');
  if (firstSpace === -1) {
    return { fullName: cleaned, firstName: cleaned, lastName: '' };
  }
  return {
    fullName: cleaned,
    firstName: cleaned.slice(0, firstSpace),
    lastName: cleaned.slice(firstSpace + 1).trim()
  };
}

function validateName(rawName) {
  const cleaned = String(rawName || '').trim().replace(/\s+/g, ' ');
  if (cleaned.length < 2) {
    return { valid: false, message: 'Please enter your full name.' };
  }
  if (cleaned.length > 120) {
    return { valid: false, message: 'Please enter a shorter name.' };
  }
  // Must contain at least 2 Unicode letters (supports English & Greek scripts)
  const letters = cleaned.match(/\p{L}/gu) || [];
  if (letters.length < 2) {
    return { valid: false, message: 'Please enter a valid name.' };
  }
  // Reject obvious URLs or repeated single-character junk like "aaaaaa"
  if (/https?:\/\/|www\./i.test(cleaned)) {
    return { valid: false, message: 'Please enter your name without links.' };
  }
  const compactLower = letters.join('').toLowerCase();
  if (compactLower.length >= 4 && /^(\p{L})\1+$/u.test(compactLower)) {
    return { valid: false, message: 'Please enter your real name.' };
  }
  return { valid: true, cleaned };
}

function isObviousJunkDigits(local8) {
  // All 8 digits identical (e.g., 99999999, 11111111)
  if (/^(\d)\1{7}$/.test(local8)) return true;
  // 6 or more identical consecutive digits (e.g., 99111111, 99000000)
  if (/(\d)\1{5,}/.test(local8)) return true;
  // Exact common sequential patterns
  const sequential = [
    '12345678',
    '87654321',
    '01234567',
    '76543210',
    '23456789',
    '98765432'
  ];
  if (sequential.includes(local8)) return true;
  // Local number ending in 123456 or 654321 (e.g. 99123456)
  if (/(123456|234567|345678|654321|765432|876543)$/.test(local8)) return true;
  // Repeated 2-digit pair 4 times (e.g. 99999999 or 91919191)
  if (/^(\d{2})\1{3}$/.test(local8)) return true;
  return false;
}

function validateCyprusPhone(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  let local8 = '';

  if (digits.length === 8) {
    local8 = digits;
  } else if (digits.startsWith('357') && digits.length === 11) {
    local8 = digits.slice(3);
  } else if (digits.startsWith('00357') && digits.length === 13) {
    local8 = digits.slice(5);
  } else {
    return {
      valid: false,
      message: 'Please enter a valid 8-digit Cyprus phone number (e.g. 99 123456).'
    };
  }

  if (!VALID_CYPRUS_FIRST_DIGITS.has(local8[0])) {
    return {
      valid: false,
      message: 'Please enter a valid Cyprus mobile or landline number.'
    };
  }

  if (isObviousJunkDigits(local8)) {
    return {
      valid: false,
      message: 'That phone number looks incomplete or invalid. Please double-check it.'
    };
  }

  const e164 = `+357${local8}`;
  const formatted = `+357 ${local8.slice(0, 2)} ${local8.slice(2)}`;
  return {
    valid: true,
    e164,
    digitsWithCountry: `357${local8}`,
    local8,
    formatted
  };
}

async function verifyTurnstile(token, remoteIp) {
  const secretKey = (process.env.TURNSTILE_SECRET_KEY || '').trim();
  if (!secretKey) {
    return { verified: true, skipped: true };
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

async function saveToGoogleSheet(lead) {
  const webhookUrl = (process.env.GOOGLE_SHEET_WEBHOOK_URL || '').trim();
  if (!webhookUrl) return { configured: false };

  const payload = {
    secret: (process.env.GOOGLE_SHEET_WEBHOOK_SECRET || '').trim(),
    timestampCyprus: lead.timestampCyprus,
    timestampIso: lead.timestampIso,
    fullName: lead.fullName,
    firstName: lead.firstName,
    lastName: lead.lastName,
    phoneE164: lead.phone.e164,
    phoneFormatted: lead.phone.formatted,
    pageUrl: lead.pageUrl,
    formLocation: lead.formLocation,
    utmSource: lead.utm.source,
    utmMedium: lead.utm.medium,
    utmCampaign: lead.utm.campaign,
    utmContent: lead.utm.content,
    utmTerm: lead.utm.term,
    eventId: lead.eventId,
    status: 'New'
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'follow',
    signal: AbortSignal.timeout(10000)
  });

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`Google Sheet webhook failed (${response.status}): ${text.slice(0, 200)}`);
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.ok === false) {
      throw new Error(`Google Sheet webhook rejected payload: ${parsed.error || 'unknown error'}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Google Sheet webhook rejected')) {
      throw err;
    }
    // Non-JSON 200 responses are tolerated unless explicitly { ok: false }
  }

  return { configured: true, ok: true };
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
          Please call this patient back within <strong>10 minutes</strong> from <strong>+357 99 373304</strong>:
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
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: fromEmail,
      to: recipients,
      subject: `Call Back Now: ${lead.fullName} (${lead.phone.formatted})`,
      html,
      text: `New Callback Request (call within 10 minutes)\nName: ${lead.fullName}\nPhone: ${lead.phone.formatted}\nTime: ${lead.timestampCyprus}\nPage: ${lead.pageUrl}`
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
  const messageBody = `New callback lead (${lead.timestampCyprus}):\n${lead.fullName}\n${lead.phone.formatted}\nPlease call within 10 mins.`;

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
    country: [sha256Normalized('cy')]
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
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const body = parseBody(req);

  // 1. Invisible honeypot & timing bot trap:
  // Return fake 200 with trackLead:false so bots stop retrying, while NEVER firing Lead events or notifying clinic.
  const honeypot = String(body.website || '').trim();
  const elapsedMs = Number(body.elapsedMs);
  if (honeypot.length > 0 || (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < MIN_HUMAN_SUBMIT_MS)) {
    return res.status(200).json({ ok: true, trackLead: false });
  }

  // 2. Validate Full Name and Cyprus Phone before touching external APIs
  const nameCheck = validateName(body.fullName);
  if (!nameCheck.valid) {
    return res.status(400).json({
      ok: false,
      field: 'fullName',
      error: nameCheck.message
    });
  }

  const phoneCheck = validateCyprusPhone(body.phone);
  if (!phoneCheck.valid) {
    return res.status(400).json({
      ok: false,
      field: 'phone',
      error: phoneCheck.message
    });
  }

  const clientIp = getClientIp(req);

  // 3. Verify Cloudflare Turnstile server-side when configured
  try {
    const turnstileResult = await verifyTurnstile(body.turnstileToken, clientIp);
    if (!turnstileResult.verified) {
      return res.status(403).json({
        ok: false,
        code: 'TURNSTILE_FAILED',
        error: 'Security check could not be verified. Please try again.'
      });
    }
  } catch (err) {
    console.error('[lead] Turnstile verification error:', err);
    return res.status(502).json({
      ok: false,
      code: 'TURNSTILE_UNAVAILABLE',
      error: 'Could not verify security check right now.'
    });
  }

  // 4. Prepare normalized lead object
  const nameParts = splitFullName(nameCheck.cleaned);
  const now = new Date();
  const timestampCyprus = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Nicosia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(now);

  const eventId = `lead_${crypto.randomUUID()}`;
  const utm = body.utm && typeof body.utm === 'object' ? body.utm : {};

  const lead = {
    eventId,
    timestampIso: now.toISOString(),
    timestampCyprus,
    fullName: nameParts.fullName,
    firstName: nameParts.firstName,
    lastName: nameParts.lastName,
    phone: phoneCheck,
    pageUrl: String(body.pageUrl || '').slice(0, 500),
    formLocation: String(body.formLocation || 'hero').slice(0, 60),
    fbp: String(body.fbp || '').slice(0, 200),
    fbc: String(body.fbc || '').slice(0, 200),
    clientIp,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 400),
    utm: {
      source: String(utm.utm_source || '').slice(0, 120),
      medium: String(utm.utm_medium || '').slice(0, 120),
      campaign: String(utm.utm_campaign || '').slice(0, 120),
      content: String(utm.utm_content || '').slice(0, 120),
      term: String(utm.utm_term || '').slice(0, 120)
    }
  };

  // 5. Save lead & trigger notifications in parallel
  const [sheetRes, emailRes, smsRes] = await Promise.allSettled([
    saveToGoogleSheet(lead),
    sendResendEmail(lead),
    sendTwilioSms(lead)
  ]);

  const sinkOutcomes = { sheet: sheetRes, email: emailRes, sms: smsRes };
  for (const [channel, result] of Object.entries(sinkOutcomes)) {
    if (result.status === 'rejected') {
      console.error(`[lead] ${channel} failed for ${eventId}:`, result.reason);
    }
  }

  // Ensure at least one durable lead sink (Google Sheet, Email, or SMS) actually succeeded.
  // Never silently lose a lead, and never fire Meta Lead events if capture failed!
  const leadSinks = [sheetRes, emailRes, smsRes];
  const anySinkConfigured = leadSinks.some(
    (r) => r.status === 'rejected' || (r.status === 'fulfilled' && r.value && r.value.configured)
  );
  const anySinkSucceeded = leadSinks.some(
    (r) => r.status === 'fulfilled' && r.value && r.value.configured && r.value.ok
  );

  if (!anySinkSucceeded) {
    console.error('[lead] CRITICAL: Lead delivery failed across all sinks. Backup log:', {
      eventId,
      fullName: lead.fullName,
      phone: lead.phone.e164,
      timestampCyprus,
      anySinkConfigured
    });
    return res.status(502).json({
      ok: false,
      error: 'We could not deliver your request right now. Please call us directly instead.'
    });
  }

  // 6. Fire server-side Meta CAPI Lead event only after confirmed capture (deduped via eventId)
  try {
    await sendMetaCapiLead(lead);
  } catch (err) {
    console.error(`[lead] capi failed for ${eventId}:`, err);
  }

  return res.status(200).json({
    ok: true,
    trackLead: true,
    eventId,
    firstName: lead.firstName,
    lastName: lead.lastName,
    phoneFormatted: lead.phone.formatted,
    phoneDigits: lead.phone.digitsWithCountry
  });
};
