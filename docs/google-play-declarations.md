# Google Play declarations for Phixr (drafted 26 Nov 2026, for Saj to approve)

Play Console → Phixr → Policy and programmes → App content. Answers are taken from the
Privacy Policy (`constants/legal.ts`) and the Android build's permissions.

## Already submitted (6 of 11)
| Declaration | Answer |
|---|---|
| Privacy policy | https://joinphixr.com/legal/privacy (readable without logging in once PR #30 merges) |
| Ads | **Yes**, the app contains ads |
| Advertising ID | **No**. The build has no AD_ID permission and no ad SDK; ads are chosen on our servers |
| Government apps | No |
| Financial features | None. Boosts are in-app purchases; creator payouts aren't a "financial feature" in Play's sense |
| Health apps | None |

## Proposed: Target audience and content
- **Age groups:** 13–15, 16–17, 18 and over. We don't target under-13s and remove their accounts.
- **Could it appeal to children (under 13)?** No.
- Stays out of the Families programme. Under-18 protections are described in the Online Safety statement.

## Proposed: Content rating (IARC questionnaire)
- **Category:** Social / communication (user-generated content)
- **Contact email:** support@joinphixr.com
- **Violence, sexuality, language, drugs, gambling, horror:** the app itself contains none. Content comes from users and is moderated.
- **Users can interact or exchange content** (posts, comments, messages): **Yes**
- **Users can share their location with other users:** **Yes**. This covers optional venue tags and approximate area, never exact GPS.
- **Digital purchases** (boosts): **Yes**
- **Unrestricted web browsing:** No
- Expected result: roughly PEGI 12 / Teen, with the "Users interact" and "In-app purchases" labels.

## Proposed: Data safety
- **Encrypted in transit:** Yes
- **Users can ask for their data to be deleted:** Yes. In the app (Settings → Delete account) and at https://joinphixr.com/account-deletion (new page in PR #30)
- **Data shared with third parties:** **None.** Our providers (Supabase, Cloudflare, Sentry, PostHog, Google Cloud) only process data for us, which Play doesn't count as "sharing". Advertisers only ever get anonymous totals.

**Data collected** (all of it covers app functionality, plus the purposes noted):

| Play data type | Why | Required or optional |
|---|---|---|
| Name (display name), email, user IDs | Account management, app functionality | Required |
| Other personal info (date of birth) | Account management, age protections | Required |
| Purchase history (boost receipts) | App functionality | Optional |
| Approximate location (area, venue tags) | App functionality, personalisation, advertising (with consent) | Optional |
| Precise location (photo GPS read once to suggest a place, then deleted) | App functionality, processed ephemerally | Optional |
| Other in-app messages (DMs, comments) | App functionality | Optional |
| Photos and videos | App functionality | Optional |
| App interactions (likes, skips, views, follows) | App functionality, personalisation, analytics, fraud prevention | Required |
| In-app search history | App functionality, personalisation | Optional |
| Other user-generated content (captions, bios) | App functionality | Optional |
| Crash logs, diagnostics | Analytics, app functionality | Required |
| Device or other IDs (hashed device ID, push token) | Fraud prevention and security, app functionality | Required |

Not collected: contacts, calendar, health, financial account details (Stripe handles payouts
itself), web browsing history, audio files.

## Needs Saj (personal or credential details I can't enter)
- **Sign-in details:** Google's reviewers need a test login. Set up a dedicated reviewer account (for example handle `phixr_review`) and type its email and password into Play yourself.
- **App-level trader status:** under EU rules, an app that makes money (ads, boosts) usually counts as a "trader". That means Play shows a contact address, email and phone on the store listing. Decide whose details to show (yours, or a company address).
