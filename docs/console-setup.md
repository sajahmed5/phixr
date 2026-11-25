# Console setup runbook — Sentry, PostHog, App Store Connect

Written 2026-11-25. Three console jobs need a signed-in browser. Sign in to any of
them in Chrome and Claude can drive the clicks; or follow the exact steps below —
each takes a few minutes. No code changes are needed except the one PostHog line
noted.

---

## 1. Sentry alert rules

Sign in at sentry.io → project **phixr** (the one whose DSN is in `.env`).

Create these four alerts (Alerts → Create Alert):

1. **New issue, any error** — type *Issues*: WHEN "a new issue is created"
   IF level ≥ error → THEN notify email, immediately. Name: `New error`.
2. **Regression** — type *Issues*: WHEN "a resolved issue changes state to
   unresolved" → notify email. Name: `Regression`.
3. **Error spike** — type *Issues*: WHEN "an issue is seen more than **50** times
   in **1 hour**" → notify email. Name: `Error spike`.
4. **Edge function failures** — the edge functions report with tag `fn`
   (send-push, secure-account, mfa-recover, iap-validate, story-reaper).
   Type *Issues*: WHEN new issue AND tag `fn` is set → notify email,
   environment: all. Name: `Edge function error`.

Also worth 2 minutes while there: Settings → Security → require 2FA for the org.

## 2. PostHog (EU region)

The app code is already wired (`lib/analytics.ts`, EU host default, full PII
scrubbing, opt-out respected) but **no project key is configured anywhere**, so
analytics currently no-op.

1. Create/sign in to a PostHog account at **eu.posthog.com** (EU region, matching
   the app's default host) and create project **Phixr**.
2. Copy the project API key (`phc_…`) into:
   - local `.env`: `POSTHOG_KEY=phc_…` (and `POSTHOG_HOST=https://eu.i.posthog.com`)
   - EAS env for production builds: `npx eas-cli env:create --name POSTHOG_KEY --value phc_… --environment production` (same for POSTHOG_HOST), so build 10+ ships with it.
3. Dashboards to create (Insights → New):
   - **Activation funnel**: `signup_completed` → `first_swipe` → `first_post`
     (events already emitted by the app), conversion over 7 days.
   - **Core engagement**: daily `swipe` count, `undo_used`, `batch_refetch` size,
     `deck_exhausted` — trends, last 30 days.
   - **Retention**: returning users on `swipe`, weekly cohorts.
   The event stream is anonymous by design — no per-user drill-downs will exist,
   and that's intentional (see analytics-scrub).

## 3. App Store Connect — App Privacy answers

appstoreconnect.apple.com → My Apps → **Phixr** (ascAppId 6796754690) → App
Privacy. These answers implement `docs/launch-readiness.md` §10. Global stance:

- **Data Used to Track You: NONE.** Phixr does no cross-app/site tracking, so
  App Tracking Transparency is not required. Do not declare any tracking.

Declare these data types (all "Linked to you" unless noted):

| ASC category → type | Collected? | Purposes to tick |
| --- | --- | --- |
| Contact Info → Email Address | Yes | App Functionality |
| User Content → Photos or Videos | Yes | App Functionality |
| User Content → Other User Content (posts, comments, messages, captions) | Yes | App Functionality |
| Identifiers → User ID | Yes | App Functionality |
| Identifiers → Device ID (hashed install id, Part 11) | Yes | App Functionality (security) |
| Usage Data → Product Interaction (swipes, views, interests, muted topics) | Yes | App Functionality, Product Personalization |
| Usage Data → Advertising Data (ad views/clicks, consent state — adults only) | Yes | Third-Party Advertising (first-party data; NOT used to track) |
| Usage Data → Other (login/device history, team activity logs, wellbeing prefs) | Yes | App Functionality |
| Location → Coarse Location (optional search area, grid cells only) | Yes | App Functionality, Product Personalization |
| Purchases → Purchase History (IAP receipts; billing/payout records) | Yes | App Functionality |
| Financial Info | **No** — cards are handled by Apple/payment provider, never seen by Phixr |
| Contacts, Health, Browsing History, Search History (outside app), Precise Location | **No** |
| Diagnostics → Crash Data, Performance Data | Yes | App Functionality — tick **"Not linked to you"** (Sentry events are scrubbed of identifiers) |

Optional-analytics note: PostHog usage data is anonymous and opt-out; it is
covered by the Usage Data declarations above.

When done, the privacy answers publish with the **next app submission** (build 9's
TestFlight build inherits the current label; the public App Store listing shows
the new answers on release).
