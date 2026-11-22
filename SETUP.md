# Callback form release checklist

The revised source is ready for configuration and deployment. Do not publish the
new Vercel API until the Google Apps Script webhook below has been updated. The
API intentionally refuses the old webhook's acknowledgement format.

## 1. Durable lead storage

1. Open the clinic's intended Google Sheet and its bound Apps Script project.
2. Replace the script with google-apps-script/lead-sheet-webhook.gs.
3. In Apps Script Project Settings, add these Script Properties:
   - WEBHOOK_SECRET: a new strong random secret, shared only with the Vercel API.
   - SPREADSHEET_ID: the identifier in the intended Google Sheet's URL.
   - LEAD_SHEET_NAME: optional; defaults to Callback Leads. Use the existing tab
     name only if its original 14 column headings match the script.
4. Update the existing web-app deployment to the new version. It must execute as
   the sheet owner and accept requests without a Google sign-in; the mandatory
   webhook secret authenticates requests. Never place the secret in browser code.
5. Set GOOGLE_SHEET_WEBHOOK_URL and matching GOOGLE_SHEET_WEBHOOK_SECRET in Vercel.

The script keeps one row per request ID, protects spreadsheet cells from formula
execution and uses a lock plus a short notification claim to avoid concurrent
duplicate alerts. Existing rows are not deleted. Notification failure leaves the
saved row marked pending, and a retry reuses that row. Pending rows need follow-up
if the visitor never retries; this version does not run a background retry job.

## 2. Bot protection

Configure a Cloudflare Turnstile widget for the intended production hostname and
any preview hostname you test. Set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY in
the appropriate Vercel environment. Managed mode may show an interaction when
Cloudflare requires one. Missing server configuration blocks submissions rather
than accepting them without protection.

## 3. Clinic notifications

Configure at least one channel:

- Email: RESEND_API_KEY, NOTIFICATION_EMAIL and a verified RESEND_FROM_EMAIL.
  The default onboarding sender is for provider testing, not general clinic use.
- SMS: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, NOTIFICATION_SMS_TO and either
  TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID. Enable the destination country
  in Twilio's messaging permissions and check any trial-account limitations.

A request is confirmed to the visitor only after the sheet explicitly records it
and at least one notification provider accepts an alert. Provider acceptance is
not a delivery receipt; verify receipt on the clinic's actual device/inbox during
the controlled acceptance test. Email retries use a provider idempotency key.

## 4. Tracking

The browser sends Lead only after confirmed success. Optional Meta CAPI uses the
same stable event ID, including across retries. Configure META_CAPI_ACCESS_TOKEN
and, if needed, META_PIXEL_ID. Use META_TEST_EVENT_CODE only while testing, then
remove it before live traffic. Phone links do not explicitly send Contact or Lead.
Check Events Manager for external automatic rules and conversion eligibility.
The ad set must optimize for the verified form-success event instead of the old
call-click Contact event. This source update does not change the ad campaign.

## 5. Test and release

1. Run npm ci and npm test. The tests use mocks and send no real notifications.
2. Verify the intended Vercel team, project and environment. The verified project is
   protection-bot in the alex-a6f8 team, linked to
   askenter1506-beep/Magdalini-chiropractic. The local .vercel/project.json refers
   to an older project and must not be used for deployment.
3. Prepare a preview or staged production deployment. Do not expose production
   credentials to unreviewed code or unrelated projects.
4. On a controlled deployment, use a test recipient you own. Confirm a single row,
   actual notification receipt, the success screen and Meta event deduplication.
   Refresh/retry the same request and confirm it reuses its record and event ID.
5. Check Android and iPhone, including Facebook/Instagram in-app browsers, and a
   small mobile viewport. The full form need not fit every short screen, but its
   primary fields/action must be easy to reach and the sticky button must work.
6. Verify that storage or notification failures show an honest error and retain
   the user's input. Check the sheet for any pending requests.
7. Promote the tested build only after its configuration and integrations pass.

No ads are activated by deploying these files. Keep the campaign paused until
the form, selected conversion event and placements have been checked together.
