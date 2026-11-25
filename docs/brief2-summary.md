# Brief 2 — final summary (Parts 11–17)

All seven parts are built, merged (11–16) or in review (17), applied to the dev
Supabase project with rollbacks, and verified with self-cleaning SQL suites plus
an on-device pass. Everything observes the Brief 1 Part 0 rules throughout:
left swipes never individual, the 50-person aggregate floor, no under-18s in
advertiser data, no exact GPS, audience-group membership secret, every tuning
number in `platform_settings`, migrations + rollbacks only, RLS +
`security definer` + explicit grants.

## What was built

**Part 11 — Multiple accounts** (phixr#11): secure on-device account vault
(SecureStore), instant switching with a drain-before-switch barrier, per-account
push routing with "@handle:" prefixes on shared devices, hashed device registry.

**Part 12 — Creator publishing tools** (phixr#12): server-synced drafts with
autosave, the scheduler (per-minute cron, pre-publish moderation), pins, story
highlights with snapshotted audiences, profile links with a domain blocklist,
collabs (co-authors), comment controls (pinning, hidden words, limits), quick
replies, DM folders.

**Part 13 — Business tools** (phixr#13, phixr-ads#1): teams with four roles and
their own logins, trigger-written activity log, business inbox (reply-as-business),
business posting through the scheduler, A/B tests with plain-English verdicts and
one-tap budget shift, engaged/similar retargeting matched at serving time behind
the consent wall and the 50-person floor, per-ad brand safety, offers + hours +
links on business profiles and verified venue map cards, aggregate-only business
insights. Plus the complete phixr-ads web UI. Side find: the Part 10
default-privileges revoke was per-schema (additive), so 41 functions had
silently regained anon access — fixed globally, anon surface back to exactly 6.

**Part 14 — Everyday features** (phixr#14): multi-step undo with full analytic
reversal, not-interested topics, show-me-more, a plain-words interests screen;
owner-only close-friends ring with a no-leak audit; TOTP 2FA with one-time backup
codes (required for team admins and payouts), login alerts with one-tap
"This wasn't me" (global sign-out + reset email); time reminders (teen default),
take-a-break, quiet mode with server-held pushes and DM auto-reply, hide like
counts both ways; audience-gated external sharing, download-own-posts, grown-up
collections, editable video captions, alt-text nudges.

**Part 15 — Notifications polish** (phixr#15): tri-state per-type settings
(on / people-I-follow / off) enforced server-side, a 15/day push cap (DMs and
security exempt; in-app feed never capped), the grouped activity tab, and the
Monday creator digest (on by default, min-views floor, weekly idempotent).

**Part 16 — fame-admin** (fame-admin#13): one review-queues page (held scheduled
posts, blocklist-flagged bio links, held offers, reported collab posts),
admin-only ban-evasion clusters and team activity logs, everything audited and
phone-usable. Settings were already covered by the generic editor.

**Part 17 — Final checks** (this PR): the security review found and fixed five
real holes (client-writable ad balance, audience-validation stamp, direct
comment/swipe writes, forgeable draft moderation — see
`20261125600000_p17_security_hardening`), re-verified switching isolation, team
roles, 2FA gates, retargeting privacy and group secrecy; performance timings
(publishing 150 due drafts in 3×~100 ms passes, A/B report 11 ms, deck 62 ms,
switch server calls <2 ms); the App Store privacy-label delta and guideline
check (docs/launch-readiness.md §10–13); and an on-device pass of the new
screens including the full 2FA enrol → backup codes → recover loop.

## Known gaps (carried to launch)

- **A new native build + TestFlight submission is required** — builds ≤8 predate
  Parts 11–17 (no new native modules were added, so one JS+config build covers it).
- Pre-ticked ads consent at signup: ICO-invalid consent risk (Saj's call, flagged).
- Stripe keys (advertiser top-ups, creator payouts), Play service-account JSON,
  legal text, Sentry alert rules: Saj-side.
- Staged migration `20261125400000` (profiles column privacy): apply once the
  new build is the only client.
- SMS 2FA backup waits on Twilio; auto video captions wait on a transcription
  service (hooks in place for both).
- 1,000-user load seed still blocked by signup email rate limits; deck
  candidate-pool cap recommended before public scale.
- fame-admin Part 16 pages verified by schema + types, not yet loaded in a
  browser (no local .env).

## Suggested next steps

1. Cut build 9 (iOS + Android), submit to TestFlight, then apply the staged
   privacy migration and update the App Privacy answers per §10.
2. Configure Stripe + Twilio + transcription keys; flip the pre-ticked consent
   if advised.
3. A small closed beta through TestFlight to exercise push delivery, 2FA and
   account switching on real devices.
