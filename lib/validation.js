const { parsePhoneNumberFromString } = require('libphonenumber-js/max');

function splitFullName(raw) {
  const fullName = String(raw || '').trim().replace(/\s+/g, ' ');
  const firstSpace = fullName.indexOf(' ');
  return { fullName, firstName: firstSpace < 0 ? fullName : fullName.slice(0, firstSpace), lastName: firstSpace < 0 ? '' : fullName.slice(firstSpace + 1) };
}
function validateName(raw) {
  if (/[\u0000-\u001f\u007f]/.test(String(raw || ''))) return { valid: false, message: 'Please enter your full name without control characters.' };
  const cleaned = splitFullName(raw).fullName;
  const letters = cleaned.match(/\p{L}/gu) || [];
  if (cleaned.length < 2 || cleaned.length > 120 || letters.length < 2 || /^[=]/.test(cleaned) || /[\u0000-\u001f\u007f]|https?:\/\/|www\./i.test(cleaned)) return { valid: false, message: 'Please enter your full name without links.' };
  if (letters.length >= 4 && /^(\p{L})\1+$/iu.test(letters.join(''))) return { valid: false, message: 'Please enter your real name.' };
  return { valid: true, cleaned };
}
function validatePhone(raw) {
  let input = String(raw || '').trim();
  if (input.startsWith('00')) input = '+' + input.slice(2);
  try {
    const parsed = parsePhoneNumberFromString(input, { defaultCountry: 'CY', extract: false });
    if (!parsed || !parsed.isValid()) throw Error('invalid');
    const national = parsed.nationalNumber;
    // Reject uniform fake numbers, but do not blacklist plausible number endings.
    if (/^(\d)\1{6,}$/.test(national) || ['12345678', '87654321', '01234567', '76543210', '23456789', '98765432'].includes(national)) throw Error('junk');
    const type = parsed.getType();
    if (type && !['MOBILE', 'FIXED_LINE', 'FIXED_LINE_OR_MOBILE', 'VOIP', 'PERSONAL_NUMBER'].includes(type)) throw Error('not a callback number');
    return { valid: true, e164: parsed.number, digitsWithCountry: parsed.number.slice(1), formatted: parsed.formatInternational(), country: parsed.country || '' };
  } catch {
    return { valid: false, message: 'Please enter a valid phone number. Include the country code for numbers outside Cyprus.' };
  }
}
module.exports = { splitFullName, validateName, validatePhone };
