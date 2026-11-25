# Phixr launch readiness (build brief Part 10)

_Date: 25 Nov 2026. Dev project: FameApp (yslrmejkaivqjvbuqfdc), Postgres 17._

## 1. What exists (Parts 1–9, all merged)

1. **Settings & trust** — every tunable in `platform_settings` (server-only vs client-visible), view-event ingest, bot detection + bot-cleaned analytics.
2. **Feeds & ranking** — friends-feed hearts, affinity learning, quality-ranked deck with a guaranteed explore quota.
3. **Creator dashboard** — daily rollups, per-post insights with drop-off curves, tips engine, creator overview.
4. **Audience groups & like privacy** — secret group audiences, delayed+grouped like notifications, quiet likes.
5. **Points & boosts** — quality-weighted earning, comment-ring detection, points-paid boosts with a labelled deck slot.
6. **Teen safety & moderation** — under-13 refusal, minor privacy defaults, teen shields everywhere, rule-based text moderation with strikes, OSA transparency, CSAM escalation process.
7. **Search v2, map, businesses** — venue-aware full-text search, map view with clustering, business accounts + venue claims, sponsored search.
8. **Ads platform** — ads as posts, consent-walled targeting (18+ only), 15-minute billing, advertiser reports (adults-only, 50-floor), self-serve ads manager (phixr-ads repo), admin oversight.
9. **Paid partnerships & earnings** — ASA-first labels with brand approval, brand stats, promo-post nudge, flag-gated earnings ledger + payouts schema.

## 2. Cold start (10)

- Deck empty state already existed ("You're all caught up" + refresh); get_deck's explore quota + backfill mean the deck serves content whenever any exists.
- **NEW: featured starter creators** — `featured_creators` (admin-managed from the user page in fame-admin, audited, under-18s refused by trigger). Featured creators lead `recommended_accounts` and get a settings-driven (`featured_creator_boost`) lift in **brand-new** users' decks (viewers with no learned interests). Verified live (F1–F4): minor refusal, featured-first suggestions, featured post topping a new viewer's deck, unchanged decks for existing users.

## 3. Performance (10)

Seeded 10,000 approved public posts (+10k tags, 10k quality rows, 10k daily-stat rows, 3,000 swipes), measured warm server-side on the dev instance, then deleted the seed completely:

| Query | Warm timing |
|---|---|
| `get_deck(20)` — viewer with ~7,000 live candidates | **~275–325 ms** |
| `get_deck(20)` — brand-new viewer | ~30 ms |
| `search_posts('coffee')` over 10k posts | ~30 ms |
| `get_creator_overview()` (10k-post creator) | ~45–48 ms |
| `get_post_insights(post)` | 7–13 ms |
| `recommended_accounts(10)` | ~2 ms |

- The deck's ~300 ms is dominated by ranking arms, not the base scan (~50 ms for 7k candidates). Fine for the 10–12-user cohort; **recommendation before public scale**: add a settings-driven recency cap on the candidate pool and revisit the explore arm's per-post tag partition.
- **Gap vs the brief**: the 1,000-user dimension couldn't be seeded — Supabase's email send rate limit blocks bulk signups and direct `auth.users` writes are off-limits. Post volume (the expensive dimension) was fully exercised; user-count mainly adds trivially-indexed profile rows. Re-run with 1k users after raising the auth email limit, if wanted.

## 4. Security & privacy review (10)

Checked: Supabase security advisors, every function's EXECUTE ACL, RLS policies on the sensitive tables, column grants, plus live probes. **Two real findings, both fixed:**

1. **Function grants (fixed, `20261125380000`)** — ~117 definer functions were executable by `anon`, and internal helpers — including `_award_to`, the uncapped points writer — by any authenticated user via PostgREST. Now: anon keeps exactly 6 deliberate pre-auth functions (anonymous feedback, signup handle check, public share pages); internals/trigger functions revoked from all client roles; default privileges changed so future functions start with **no** client EXECUTE. Verified live: `_award_to` refused for a signed-in user, capped award RPCs still work, aclexplode audit clean.
2. **Profiles column leak (fix staged, `20261125390000` + `20261125400000`)** — any signed-in user could SELECT any profile's `date_of_birth`, `search_location` (exact coordinates), points, consent and terms data. Fix: column-level SELECT (public columns only) + `get_my_profile()` for own-row reads. The function half is applied and the app now uses it; **the revoke half (`…400000`) must be applied only after every distributed client has this build** — older clients `select('*')` and would break. UPDATE was already column-restricted (verified: DOB/consent/verified/points not client-writable).

Re-verified holding: left swipes readable only by their owner; group membership owner-only; post locations coarse cells only; minors never in advertiser/brand data; minors can't be featured/targeted/boosted-at.

Advisor notes for Saj (dashboard, not SQL): enable leaked-password protection (HaveIBeenPwned) in Auth settings; `pg_net` sits in the `public` schema (move only with care — cron jobs use it).

## 5. Monitoring (10)

- **Sentry**: client + edge functions wired with PII scrubbing (existing). _Saj to do in sentry.io: create alert rules (new-crash, crash-rate spike) and set notification channels — no code needed._
- **PostHog funnels** (count-only, no PII, opt-out honoured): `signup_started` → **`signup_completed` (new)** → `first_swipe` → `first_post` → **`first_boost` (new)**, plus first_comment/share. Build the funnel dashboards in PostHog once events flow.

## 6. Legal (10)

In-app, reachable from Settings → Legal: Terms, Privacy, Community Guidelines, **Advertising policy (new)**, **Online safety / OSA statement (new)**. All five are structured placeholders — **Saj supplies the real text before launch** (the privacy placeholder now lists the Parts 8–9 ad/partnership/earnings data points it must cover). `TERMS_VERSION` re-prompt mechanism already works.

## 7. App store (10)

- **Builds**: iOS build 6 submitted to App Store Connect (TestFlight after processing); Android build 7 (.aab) on EAS, `eas submit -p android` when wanted. **Both predate Parts 9–10's JS and the IAP module — cut one more build when Part 10 merges** (it will be build 8 / versionCode 9) and publish OTAs against its runtime thereafter.
- **IAP (built this part)**: boosts purchasable with money end-to-end — `expo-iap` module + config plugin, purchase flow in the boost composer (hidden behind `iap_enabled` = 0), `iap-validate` edge function (deployed; answers 503 until keys exist), `create_boost_from_iap` (service-role, replay-protected, verified live I1–I3), `iap_receipts` ledger for tax records.
  **Activation checklist (Saj)**: create consumables `phixr.boost.1day/3day/7day` in App Store Connect + Play Console → set `APPLE_SHARED_SECRET` + `GOOGLE_PLAY_SA_JSON` function secrets → sandbox-test a purchase on a dev build (receipt-validation path may need tuning against real StoreKit 2 JWS payloads — budget for it) → flip `iap_enabled` to 1. Price in the stores with Apple's/Google's 15–30% commission in mind vs the points price.
- **Listing**: description, screenshots, and the privacy nutrition label are Saj-side. Nutrition-label guidance from what the app actually collects: Contact info (email) — account; Location (coarse, user-chosen centre) — app functionality; Photos/videos — user content; Identifiers (user id) — analytics (opt-out exists); Purchases (when IAP goes live). No tracking across apps; no precise location.

## 8. fame-admin (10)

Responsive pass done: below 800px the sidebar becomes a wrap-around top bar and tables scroll horizontally — every page usable on a phone. Featuring + earnings + promo-hint controls all live on the user page / nav.

## 9. Known gaps (launch blockers in bold)

- **Legal text is placeholder** (Terms/Privacy/Guidelines/Ads/OSA) — Saj supplies before launch.
- **Staged migration `20261125400000`** (profiles column privacy) — apply once the Part 10 build is the only client in use.
- **One more native build** needed after Part 10 merges (IAP module changed the runtime fingerprint again).
- IAP activation checklist above (products, keys, sandbox test).
- Pre-ticked ads-consent at signup: Saj's call, flagged twice — ICO treats pre-ticked consent as invalid; one-word change to flip before public launch.
- Stripe: advertiser top-ups and creator payouts both wait on keys (manual credits / flag-off meanwhile).
- Perf: 1,000-user seed not run (email rate limit); deck candidate-pool cap recommended before public scale.
- Google Business Profile OAuth for venue claims still manual (API access pending).
- Part 5 `award_message_activity` (DM reply points) still untested end-to-end on devices (needs two phones).
- Sentry alert rules + PostHog funnel dashboards: console-side setup.
- Apple ITMS-90725 (informational, on build 6): built with the iOS 26.5 SDK; from **April 2027** Apple requires the iOS 27 SDK (Xcode 27). Nothing to do now — eas.json uses the default build image, so this resolves itself with the next Expo SDK / EAS image upgrade, which must happen before April 2027 anyway.

---

# Brief 2 addendum (Parts 11–17, 2026-11-25)

## 10. App Privacy "nutrition label" — delta for the next submission

Everything below is NEW data since build 8 (which covered Parts 1–10). Phixr still
does **no cross-app tracking** — engaged/similar ad audiences (Part 13) use only
first-party, on-platform behaviour behind explicit personalised-ads consent, so the
"Data Used to Track You" section stays EMPTY and App Tracking Transparency is still
not required.

Declare / confirm in App Store Connect → App Privacy:

| Data | Label category | Linked to identity | Purpose | Notes |
| --- | --- | --- | --- | --- |
| Hashed device identifier (Part 11, `account_devices`) | Identifiers → Device ID | Yes | App functionality (security: multi-account integrity, new-login alerts, ban evasion) | Salted SHA-256 of a per-install keychain id; the raw id never leaves the device |
| Login alerts / sign-in device history (Part 14C) | Usage Data → Other | Yes | App functionality (account security) | Platform + first/last seen per account |
| Two-step login enrolment + backup-code hashes (14C) | Not a label item | — | — | TOTP secrets live with Apple-hosted auth (Supabase); codes stored only as SHA-256 |
| Interests / muted topics / learned weights (14A) | Usage Data → Product Interaction | Yes | App functionality, personalisation | Already partially covered by swipes in build 8's label — confirm "personalisation" purpose is ticked |
| Wellbeing preferences incl. quiet hours (14D) | User Content → Other | Yes | App functionality | Quiet window, auto-reply text, reminder minutes |
| Ad interaction for retargeting (13C) | Usage Data → Advertising Data | Yes | Third-party advertising (first-party data, no tracking) | Only for consenting adults; serving-time matching; advertisers never receive lists |
| Team membership & activity log (13A) | Usage Data → Other | Yes | App functionality | Business staff actions recorded for the business owner |
| Business insights (13E) | Not user-linked in output | — | Analytics | Stored with viewer id for daily dedupe but NEVER exposed; label as Analytics → Product Interaction, linked |

## 11. Apple guideline check (new features)

- **2FA / backup codes (14C):** no guideline issues; codes shown in-app, shareable to
  the user's own storage. Recovery is support-mediated (no SMS) — fine.
- **IAP (10) unchanged** by Brief 2; boosts still Apple IAP, advertiser top-ups are
  web-only (Stripe) and the app never links out to purchase — compliant with 3.1.1/3.1.3(b).
- **UGC (1.2):** moderation, blocking, reporting all pre-date Brief 2; Part 17 closed
  the scheduled-publishing moderation bypass, strengthening the 1.2 story.
- **Ads (2.5.14 / 5.1.1):** personalised ads remain consent-gated; the per-ad
  "Why am I seeing this" text now covers engaged/similar honestly.
- **Weekly digest + login-alert pushes (14C/15):** Apple requires opt-out for
  marketing-ish pushes — the digest has an in-app toggle and a daily push cap; fine.
- ⚠ Pre-ticked ads-consent at signup (Part 9 decision) remains the one flagged
  compliance risk (ICO, not Apple).

## 12. Brief 2 security review (Part 17) — outcome

Checked with impersonated test accounts against dev: account-switching isolation
(cross-account reads all empty), team roles (refusals + instant removal), 2FA gates
(admin seats, payouts), retargeting privacy (floor, stamp, serving-time matching),
collab/highlight audience rules, group-membership secrecy (member can see a group
post but never the group, membership or post→group link; groups posts unreachable
from deck/search/public links), and the anon API surface (exactly 6 functions).

**Found and FIXED in `20261125600000_p17_security_hardening`:**
1. `ad_accounts.balance_pence`/`status` were client-writable → self-credited ad money. 
2. `ad_sets.audience_validated_at` client-writable → 50-person-floor bypass; also
   audience changes now clear the validation stamp.
3. Direct `comments` INSERT skipped add_comment's limits/hidden words.
4. Direct `swipes` INSERT/DELETE skipped record_swipe/undo accounting.
5. Scheduler trusted client-written draft `media_status` → a forged draft could
   publish flagged or someone else's media; verdicts are now locked in server-side
   at save time (`server_media_status` trigger) and re-checked at publish.
6. Dead write grants revoked (venues, pipeline_verdicts, handle_history, …).

## 13. Brief 2 performance (dev project, 2026-11-25)

- Scheduled publishing under load: 150 due drafts drained in 3 cron passes,
  ~90–106 ms per 50-draft pass (every one published, zero stuck).
- Account switching: server calls after a switch total <2 ms
  (get_my_profile 0.6 ms, get_client_settings 0.2 ms); Part 11 measured the full
  on-device switch as effectively instant (SecureStore session swap).
- Content calendar query: 0.5 ms with 150 rows.
- A/B report over 60 days of impressions: 11 ms.
- get_deck (now with muted-topics + hide-likes joins): 62 ms at current data size.
