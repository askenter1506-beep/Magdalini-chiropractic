/**
 * Durable callback storage, notification claims and duplicate protection.
 * In Apps Script Project Settings, set Script Properties WEBHOOK_SECRET,
 * SPREADSHEET_ID and (optionally) LEAD_SHEET_NAME. Never publish the secret.
 * Redeploy this web app after changing code; the Vercel API requires protocol 2.
 */
var LEAD_HEADERS = [
  'Submitted (Cyprus Time)', 'Full Name', 'Phone Number', 'Status', 'Notes',
  'Form Location', 'Page URL', 'UTM Source', 'UTM Medium', 'UTM Campaign',
  'UTM Content', 'UTM Term', 'Meta Event ID', 'Submitted (ISO UTC)',
  'Delivery State', 'Notification Claim', 'Claim Expires (ms)',
  'Notification Channels', 'Updated (ISO UTC)'
];

function plainCell(value) {
  var text = String(value == null ? '' : value);
  return /^[\s]*[=+@-]/.test(text) ? "'" + text : text;
}

function reply(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var lock;
  try {
    var payload = JSON.parse(e && e.postData && e.postData.contents || '{}');
    var properties = PropertiesService.getScriptProperties();
    var expectedSecret = properties.getProperty('WEBHOOK_SECRET');
    var spreadsheetId = properties.getProperty('SPREADSHEET_ID');
    if (!expectedSecret || !spreadsheetId) return reply({ ok: false, error: 'Storage configuration missing' });
    if (payload.secret !== expectedSecret) return reply({ ok: false, error: 'Unauthorized' });
    if (!/^lead_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.eventId || '')) return reply({ ok: false, error: 'Invalid request identifier' });
    if (['capture', 'complete'].indexOf(payload.operation) < 0) return reply({ ok: false, error: 'Invalid operation' });

    lock = LockService.getScriptLock();
    lock.waitLock(10000);
    var book = SpreadsheetApp.openById(spreadsheetId);
    var sheetName = properties.getProperty('LEAD_SHEET_NAME') || 'Callback Leads';
    var sheet = book.getSheetByName(sheetName) || book.insertSheet(sheetName);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(LEAD_HEADERS);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, LEAD_HEADERS.length).setFontWeight('bold');
    } else {
      // Do not silently reinterpret an unrelated or manually rearranged sheet.
      var headings = sheet.getRange(1, 1, 1, LEAD_HEADERS.length).getValues()[0];
      for (var h = 0; h < 14; h++) {
        if (headings[h] !== LEAD_HEADERS[h]) return reply({ ok: false, error: 'Unexpected spreadsheet headers' });
      }
      for (var j = 14; j < LEAD_HEADERS.length; j++) {
        if (headings[j] && headings[j] !== LEAD_HEADERS[j]) return reply({ ok: false, error: 'Unexpected delivery columns' });
      }
      sheet.getRange(1, 15, 1, 5).setValues([LEAD_HEADERS.slice(14)]);
    }

    var lastRow = sheet.getLastRow();
    var records = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, LEAD_HEADERS.length).getValues() : [];
    var index = -1;
    for (var i = 0; i < records.length; i++) {
      if (String(records[i][12]) === payload.eventId) { index = i; break; }
    }
    var now = Date.now();
    var record;
    var row;
    if (index < 0) {
      if (payload.operation !== 'capture') return reply({ ok: false, error: 'Request not found' });
      if (!payload.fullName || !/^\+[1-9]\d{7,14}$/.test(payload.phoneE164 || '')) return reply({ ok: false, error: 'Missing contact details' });
      record = [payload.timestampCyprus || '', payload.fullName, payload.phoneE164, 'New', '', payload.formLocation || '', payload.pageUrl || '', payload.utmSource || '', payload.utmMedium || '', payload.utmCampaign || '', payload.utmContent || '', payload.utmTerm || '', payload.eventId, payload.timestampIso || new Date(now).toISOString(), 'pending', '', '', '', new Date(now).toISOString()];
      sheet.appendRow(record.map(plainCell));
      row = sheet.getLastRow();
    } else {
      record = records[index];
      row = index + 2;
      // A reused request ID must not overwrite another person's contact details.
      if (String(record[2]).replace(/^'/, '') !== String(payload.phoneE164)) return reply({ ok: false, error: 'Request identity mismatch' });
    }

    if (payload.operation === 'complete') {
      if (!payload.claimToken || record[15] !== payload.claimToken) return reply({ ok: false, error: 'Notification claim mismatch' });
      var notified = payload.notificationSucceeded === true;
      record[14] = notified ? 'notified' : 'pending';
      record[15] = '';
      record[16] = '';
      record[17] = notified && Array.isArray(payload.channels) ? payload.channels.filter(function (channel) { return channel === 'email' || channel === 'sms'; }).join(', ') : '';
      record[18] = new Date(now).toISOString();
      sheet.getRange(row, 15, 1, 5).setValues([record.slice(14).map(plainCell)]);
      SpreadsheetApp.flush();
      return reply({ ok: true, protocolVersion: 2, eventId: payload.eventId, state: record[14] });
    }

    if (record[14] === 'notified') return reply({ ok: true, protocolVersion: 2, eventId: payload.eventId, state: 'notified' });
    if (record[15] && Number(record[16]) > now) return reply({ ok: true, protocolVersion: 2, eventId: payload.eventId, state: 'processing' });
    record[14] = 'pending';
    record[15] = Utilities.getUuid();
    record[16] = now + 60000;
    record[18] = new Date(now).toISOString();
    sheet.getRange(row, 15, 1, 5).setValues([record.slice(14).map(plainCell)]);
    SpreadsheetApp.flush();
    return reply({ ok: true, protocolVersion: 2, eventId: payload.eventId, state: 'pending', claimToken: record[15] });
  } catch (err) {
    return reply({ ok: false, error: 'Could not save or confirm the request' });
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}
