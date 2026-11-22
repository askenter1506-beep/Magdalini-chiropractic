module.exports = function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  return res.status(200).json({
    turnstileSiteKey: (process.env.TURNSTILE_SITE_KEY || '').trim(),
    clinicPhoneDisplay: '+357 99 373304',
    clinicPhoneHref: '+35799373304'
  });
};
