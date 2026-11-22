const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const { createRequire } = require('module');
const root = process.env.CALLBACK_PROJECT_ROOT || require('path').resolve(__dirname, '..');
const projectRequire = createRequire(root + '/api/lead.js');
const validation = projectRequire('../lib/validation');
const source = fs.readFileSync(root + '/api/lead.js', 'utf8');
const sheetSource = fs.readFileSync(root + '/google-apps-script/lead-sheet-webhook.gs', 'utf8');
const id = 'a63b5804-5b02-4e48-9cbd-3f8a4710ad94';
const base = { fullName: 'Review Example', phone: '+35799373304', website: '', submissionId: id, turnstileToken: 'mock-token', pageUrl: 'https://example.invalid/?private=test', formLocation: 'hero' };
function jsonResponse(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }; }
function setup(options = {}) {
  const calls = [];
  const rows = [];
  const config = { TURNSTILE_SITE_KEY: 'mock-site', TURNSTILE_SECRET_KEY: 'mock-secret', GOOGLE_SHEET_WEBHOOK_URL: 'https://sheet.invalid/', GOOGLE_SHEET_WEBHOOK_SECRET: 'mock-webhook', RESEND_API_KEY: 'mock-email', NOTIFICATION_EMAIL: 'review@example.invalid', META_CAPI_ACCESS_TOKEN: 'mock-meta', ...options.env };
  const sandbox = { module: { exports: {} }, require: projectRequire, process: { env: config }, console: { error() {} }, URLSearchParams, URL, AbortSignal, Buffer,
    fetch: async (url, request) => {
      const channel = url.includes('siteverify') ? 'turnstile' : url.includes('sheet.invalid') ? 'sheet' : url.includes('resend.com') ? 'email' : url.includes('twilio.com') ? 'sms' : url.includes('graph.facebook.com') ? 'meta' : 'unexpected';
      if (channel === 'unexpected') throw Error('Network calls forbidden in tests');
      const payload = channel === 'turnstile' || channel === 'sms' ? null : JSON.parse(request.body);
      calls.push({ channel, payload, headers: request.headers });
      if (options.fail === channel) return jsonResponse({}, 503);
      if (channel === 'turnstile') return jsonResponse({ success: options.botValid !== false });
      if (channel === 'sheet') {
        if (options.html) return { ok: true, json: async () => { throw Error('HTML, not JSON'); } };
        if (options.legacy) return jsonResponse({ ok: true });
        if (payload.operation === 'capture') {
          let row = rows.find(x => x.eventId === payload.eventId);
          if (!row) { row = { eventId: payload.eventId, state: 'pending' }; rows.push(row); }
          return jsonResponse({ ok: true, protocolVersion: 2, eventId: payload.eventId, state: row.state, ...(row.state === 'notified' || options.busy ? {} : { claimToken: 'test-claim' }) });
        }
        const row = rows.find(x => x.eventId === payload.eventId);
        row.state = payload.notificationSucceeded ? 'notified' : 'pending';
        return jsonResponse({ ok: true, protocolVersion: 2, eventId: payload.eventId, state: row.state });
      }
      return jsonResponse({ ok: true });
    }
  };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  return { calls, rows, async submit(body = base) { let status; let result; await sandbox.module.exports({ method: 'POST', body, headers: { 'user-agent': 'isolated-test' }, socket: {} }, { setHeader() {}, status(value) { status = value; return this; }, json(value) { result = value; } }); return { status, ...result }; } };
}

test('accepts Greek, Cyrillic and international names; rejects formulas and control characters', () => {
  for (const name of ['Ελένη Νικολάου', 'Иван Петров', '王小明', "Anne-Marie O’Neil"]) assert.equal(validation.validateName(name).valid, true, name);
  for (const name of ['=SUM(1,1)', 'A', 'test\nname', 'www.example.invalid']) assert.equal(validation.validateName(name).valid, false, name);
});
test('accepts Cyprus landlines/mobile and foreign numbers without rejecting sequential endings', () => {
  for (const number of ['99 373304', '+35722339697', '0035799373304', '99 123456', '+442079460018', '+447911123456']) assert.equal(validation.validatePhone(number).valid, true, number);
  for (const number of ['11111111', '99999999', '123456', '+35712345678', 'text +35799373304']) assert.equal(validation.validatePhone(number).valid, false, number);
});
test('saves before alerting; tracks only after both storage and notification are confirmed', async () => {
  const t = setup(); const result = await t.submit(); assert.equal(result.status, 200); assert.equal(result.trackLead, true);
  assert.deepEqual(t.calls.map(x => x.channel), ['turnstile', 'sheet', 'email', 'sheet', 'meta']);
  assert.equal(t.calls[1].payload.pageUrl, 'https://example.invalid/');
  assert.equal(t.calls[2].headers['Idempotency-Key'], result.eventId);
  assert.equal(t.calls[4].payload.data[0].event_id, result.eventId);
});
for (const condition of ['html', 'legacy']) test('rejects ' + condition + ' spreadsheet acknowledgements without notifications or events', async () => {
  const t = setup({ [condition]: true }); const result = await t.submit(); assert.equal(result.status, 503); assert.ok(!t.calls.some(x => ['email', 'meta'].includes(x.channel)));
});
test('notification failure keeps saved request pending and emits no conversion', async () => {
  const t = setup({ fail: 'email' }); const result = await t.submit(); assert.equal(result.code, 'NOTIFICATION_PENDING'); assert.equal(t.rows.length, 1); assert.equal(t.rows[0].state, 'pending'); assert.ok(!t.calls.some(x => x.channel === 'meta'));
});
test('same successful submission retried creates one record, one notification and a stable event ID', async () => {
  const t = setup(); const a = await t.submit(); const b = await t.submit(); assert.equal(a.eventId, b.eventId); assert.equal(t.rows.length, 1); assert.equal(t.calls.filter(x => x.channel === 'email').length, 1);
});
test('storage failure cannot fall back to notification-only success', async () => {
  const t = setup({ fail: 'sheet' }); const result = await t.submit(); assert.equal(result.code, 'STORAGE_UNCONFIRMED'); assert.ok(!t.calls.some(x => x.channel === 'email' || x.channel === 'meta'));
});
test('missing Turnstile configuration fails closed before external calls', async () => {
  const t = setup({ env: { TURNSTILE_SECRET_KEY: '' } }); const result = await t.submit(); assert.equal(result.code, 'FORM_UNAVAILABLE'); assert.equal(t.calls.length, 0);
});
test('failed bot verification cannot create a record or event', async () => {
  const t = setup({ botValid: false }); const result = await t.submit(); assert.equal(result.status, 403); assert.equal(t.rows.length, 0); assert.equal(t.calls.length, 1);
});
test('honeypot never produces a notification or conversion', async () => {
  const t = setup(); const result = await t.submit({ ...base, website: 'bot' }); assert.equal(result.trackLead, false); assert.equal(t.calls.length, 0);
});
test('a concurrent notification claim does not alert or track again', async () => {
  const t = setup({ busy: true }); const result = await t.submit(); assert.equal(result.status, 409); assert.ok(!t.calls.some(x => ['email', 'meta'].includes(x.channel)));
});

function sheetHarness() {
  const records = [];
  const props = { WEBHOOK_SECRET: 'mock-webhook', SPREADSHEET_ID: 'mock-sheet' };
  const sheet = { getLastRow: () => records.length, appendRow: row => records.push([...row]), setFrozenRows() {}, getRange(row, col, count, width) { return { setFontWeight() {}, getValues() { return Array.from({ length: count }, (_, r) => Array.from({ length: width }, (_, c) => records[row - 1 + r]?.[col - 1 + c] ?? '')); }, setValues(values) { values.forEach((valuesRow, r) => valuesRow.forEach((value, c) => { records[row - 1 + r][col - 1 + c] = value; })); } }; } };
  const context = { PropertiesService: { getScriptProperties: () => ({ getProperty: key => props[key] || null }) }, LockService: { getScriptLock: () => ({ waitLock() {}, hasLock: () => true, releaseLock() {} }) }, SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }), flush() {} }, Utilities: { getUuid: () => 'mock-claim' }, ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => JSON.parse(text) }) } };
  vm.createContext(context); vm.runInContext(sheetSource, context);
  const payload = { secret: 'mock-webhook', eventId: 'lead_' + id, operation: 'capture', fullName: 'Review Example', phoneE164: '+35799373304' };
  return { records, props, call: extra => context.doPost({ postData: { contents: JSON.stringify({ ...payload, ...extra }) } }) };
}
test('real spreadsheet script creates one row and protects concurrent notification claims', () => {
  const h = sheetHarness(); const first = h.call({}); const second = h.call({}); assert.equal(first.claimToken, 'mock-claim'); assert.equal(second.state, 'processing'); assert.equal(h.records.length, 2);
  assert.equal(h.call({ operation: 'complete', claimToken: 'wrong', notificationSucceeded: true }).ok, false);
  assert.equal(h.call({ operation: 'complete', claimToken: first.claimToken, notificationSucceeded: true, channels: ['email'] }).state, 'notified');
  assert.equal(h.call({}).state, 'notified'); assert.equal(h.records.length, 2);
});
test('spreadsheet secret is mandatory and formula-like values are written as literal text', () => {
  const h = sheetHarness(); assert.equal(h.call({ secret: 'wrong' }).ok, false); assert.equal(h.records.length, 0);
  assert.equal(h.call({ fullName: '=SUM(1,1)', utmCampaign: '=IMPORTDATA("example")' }).ok, true);
  assert.equal(h.records[1][1], "'=SUM(1,1)"); assert.equal(h.records[1][9], "'=IMPORTDATA(\"example\")");
});
test('frontend retains submission ID on retry, accepts Unicode and does not hide via overridden CSS', () => {
  const src = fs.readFileSync(root + '/callback-form.js', 'utf8'); const context = { Date, URLSearchParams, Map, sessionStorage: { values: {}, getItem(key) { return this.values[key] || null; }, setItem(key, value) { this.values[key] = value; } }, window: { crypto: require('crypto').webcrypto }, document: { readyState: 'loading', addEventListener() {} } };
  vm.createContext(context); vm.runInContext(src.replace('  // ---------- Cloudflare Turnstile Loader ----------', '  globalThis.review = { validateName, validatePhone, getSubmissionId };\n  // ---------- Cloudflare Turnstile Loader ----------'), context);
  assert.equal(context.review.validateName('Иван Петров').valid, true);
  assert.equal(context.review.validatePhone('99123456', null).valid, true);
  assert.equal(context.review.getSubmissionId('+35799373304'), context.review.getSubmissionId('+35799373304'));
  assert.match(fs.readFileSync(root + '/styles.css', 'utf8'), /\.callback-form\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});
