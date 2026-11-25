/**
 * Legal documents + the current terms version.
 *
 * Bump `TERMS_VERSION` whenever the Terms or Privacy text materially changes: the app
 * compares it to `profiles.terms_version` and re-prompts anyone on an older version.
 * (Bumped 2026-11-25: first full legal text replacing the pre-launch placeholders —
 * everyone re-accepts once.)
 */
export const TERMS_VERSION = '2026-11-25';

export type LegalDocId = 'terms' | 'privacy' | 'guidelines' | 'ads' | 'safety';

export const LEGAL_DOCS: Record<LegalDocId, { title: string; updated: string; body: string }> = {
  terms: {
    title: 'Terms of Service',
    updated: TERMS_VERSION,
    body: `These terms are an agreement between you and Phixr ("Phixr", "we", "us"), operated from the United Kingdom. By creating an account or using Phixr you accept them. If you don't accept them, don't use Phixr. Questions: support@joinphixr.com.

1. WHO CAN USE PHIXR
You must be at least 13. If you are under 18, some features are restricted for your protection (see our Online Safety statement) and you confirm a parent or guardian is aware you use Phixr. Business accounts, advertising, boosts and creator earnings are for people aged 18 or over. You must give a true date of birth; accounts created with a false one may be removed.

2. YOUR ACCOUNT
Keep your login details private and use a password you don't use elsewhere. You're responsible for what happens on your account. We strongly recommend two-step login (Settings → Security). Tell us at once if you think your account has been compromised. You may hold more than one account (for example a personal and a business account) but not to evade a suspension or ban — bans apply to the person, not just the account.

3. YOUR CONTENT
What you post stays yours. So that Phixr can work, you give us a non-exclusive, worldwide, royalty-free licence to host, store, reproduce, adapt (for example to make thumbnails and previews), publish and distribute your content on Phixr, for as long as it is on Phixr. The licence ends when you delete the content or your account, except where others have reshared it within Phixr, where we must keep it to comply with law, or in anonymised aggregates.

You are responsible for your content. You confirm you have the rights to post it and that it follows the Community Guidelines. We may remove content that breaks our rules or the law, and may hold content for review before it appears.

4. HOW THE FEED WORKS
Phixr ranks posts by what you like and skip, how fresh posts are, their quality signals, and creator points. Your left swipes (skips) are private: we never show anyone which posts you skipped, and creators only ever see anonymous totals. You can see and change what Phixr has learned about your interests in Settings → Your interests.

5. POINTS, BOOSTS AND PURCHASES
Points are a free reward for genuine activity. They have no cash value, can't be bought, sold or transferred, and may be adjusted or removed if gained through manipulation (bots, swipe farms, self-dealing). Boosts on iPhone are bought through Apple as in-app purchases under Apple's terms; prices are shown before you pay and purchases are non-refundable except as Apple's rules or the law require. Advertising is billed separately under the Advertising Policy.

6. CREATOR EARNINGS AND PARTNERSHIPS
Earnings features (18+) are governed by the Advertising Policy and the payout terms shown when you set up payouts. You're responsible for your own tax. Paid partnerships must be declared using the in-app label — undeclared advertising breaks UK advertising rules and these terms.

7. BUSINESS ACCOUNTS AND TEAMS
A business account owner can invite team members with limited roles. Team members use their own logins; everything they do for the business is recorded for the owner. The owner is responsible for their team's actions on the business account.

8. WHAT YOU MUST NOT DO
Don't break the Community Guidelines; don't use Phixr if you're banned; don't access Phixr by automated means or scrape it; don't interfere with or overload the service; don't buy, sell or rent accounts, followers, likes or points; don't misuse reporting or appeals; don't attempt to identify who skipped a post or who is in someone's audience groups.

9. SUSPENSION AND TERMINATION
We may suspend or remove content, restrict features, or suspend or terminate accounts that break these terms, the Community Guidelines or the law — permanently for serious or repeated breaches. Where appropriate we tell you what happened and you can appeal in-app. You can delete your account at any time in Settings.

10. DISCLAIMERS AND LIABILITY
Phixr is provided "as is". We don't promise it will always be available, uninterrupted or error-free, and we're not responsible for content posted by other users (though we moderate as described in the Online Safety statement). Nothing in these terms excludes liability that cannot be excluded under the law of England and Wales, including for death or personal injury caused by negligence, or fraud. Otherwise, our total liability to you is limited to the greater of £100 and the amounts you paid us in the 12 months before the claim. We are not liable for loss of profits, business or data arising from your use of Phixr.

11. CHANGES
We may update these terms. For material changes we'll ask you to review and accept the new version before continuing. The version date is shown at the top.

12. GENERAL
These terms are governed by the law of England and Wales and the courts of England and Wales have jurisdiction (if you live in Scotland or Northern Ireland, you may also bring proceedings there). If part of these terms is found unenforceable, the rest still applies. You may not transfer this agreement; we may transfer it as part of a reorganisation or sale, with your protections preserved.`,
  },
  privacy: {
    title: 'Privacy Policy',
    updated: TERMS_VERSION,
    body: `Phixr ("we") is the data controller for your personal data, operating from the United Kingdom under UK GDPR and the Data Protection Act 2018. Contact: support@joinphixr.com.

1. WHAT WE COLLECT AND WHY

Account data — email address, handle, display name, date of birth, password (stored only as a secure hash by our authentication provider). Needed to run your account and apply age protections. Lawful basis: contract.

Content — posts, stories, comments, messages, captions, profile details and anything else you create. Lawful basis: contract.

Activity — your likes and skips (always private: nobody ever sees which way you swiped), what you view and for how long, searches, follows. Used to rank your feed, count reach for creators, and detect fake engagement. Lawful basis: contract and legitimate interests (keeping the feed honest).

Approximate area (optional) — if you set a search area, we store a coarse grid cell and a place label, never your exact GPS location. Map pins only ever show public venues. Lawful basis: consent; remove it any time in Settings.

Security data — a one-way hashed device identifier (the raw identifier never leaves your device), sign-in history per device for login alerts, two-step login enrolment, and hashed one-time backup codes. Lawful basis: legitimate interests (protecting accounts, preventing ban evasion).

Wellbeing settings — quiet hours, auto-reply text, time-reminder and like-count preferences. Lawful basis: contract.

Ads data (adults only, by consent) — your personalised-ads choice with a timestamp, and your ad interactions (views, clicks, hides). If you consent, ads may be picked using your age group, area and interests, including whether you previously liked an advertiser's posts ("engaged" and "similar" audiences) — this matching happens on our servers at the moment an ad is shown; advertisers never receive a list of people. Advertisers only ever see anonymous totals about adults, and never any group smaller than 50 people. Under-18s are never included in advertiser data or targeting. Lawful basis: consent; withdraw any time in Settings.

Business and advertiser data — business details, venue claims, team membership and a log of team actions, campaigns and billing records. Lawful basis: contract and legal obligation (accounting).

Purchases and payouts — iPhone boosts are processed by Apple; we receive a purchase receipt, never your card details. Creator payouts and advertiser billing are processed by our payment provider; we keep the records the law requires. Lawful basis: contract and legal obligation (tax).

Moderation and safety records — reports you make or that are made about your content, moderation decisions, appeals, and strike history. Lawful basis: legal obligation (Online Safety Act) and legitimate interests.

Crash and performance data — error reports with identifiers, emails and tokens automatically removed before they leave the app. Anonymous usage analytics are optional (Settings → "Share anonymous usage data") and never include your identity or which posts you swiped.

2. WHO WE SHARE DATA WITH
Service providers who process data for us under contract: our database and authentication host, our push-notification delivery service, our error-reporting service (scrubbed), our optional analytics service (anonymous), Apple and Google (purchases and app distribution), and our payment provider (billing and payouts). We share data with authorities where the law requires — including reports of child sexual abuse material to the relevant authorities. We never sell your personal data and we do not track you across other companies' apps or websites.

3. HOW LONG WE KEEP IT
Your account data and content: until you delete them or your account. Raw view events: deleted within 90 days (only aggregate statistics remain). Media-moderation verdicts: about 24 hours. Push counters, login history and similar operational records: kept only as long as they are useful for security. Billing, payout and safety records: as long as the law requires. Deleting your account removes your profile and content from Phixr; backup copies clear on a rolling basis shortly after.

4. YOUR RIGHTS
You can: access and export your data (Settings → Export my data), correct it (Edit profile), delete it (delete posts, or Settings → Delete account), object to or restrict processing, and withdraw any consent (personalised ads, analytics, search area) without affecting anything else. To exercise a right that isn't in the app, email support@joinphixr.com. You can complain to the Information Commissioner's Office at ico.org.uk — though we'd appreciate the chance to resolve things first.

5. CHILDREN
Phixr is for ages 13 and up. Under-18 accounts are private by default, are excluded from all advertising data and targeting, can't buy boosts or receive earnings, and have further protections described in the Online Safety statement. We delete accounts found to belong to under-13s.

6. CHANGES
Material changes to this policy are shown in the app for review and acceptance before you continue. The version date is at the top.`,
  },
  guidelines: {
    title: 'Community Guidelines',
    updated: TERMS_VERSION,
    body: `Phixr is for sharing what you make and finding what you love — these rules keep it worth being on. They apply to everything: posts, stories, comments, messages, profiles, handles and live features. "We remove" below means we may also hold content for review, restrict features, apply strikes, or suspend or ban accounts, depending on severity.

1. KEEP IT LEGAL
No content that is illegal in the UK or that facilitates crime: no child sexual abuse material (detected material is removed, the account banned and a report made to the authorities), no terrorism content, no sale of drugs or weapons, no fraud or stolen goods.

2. NO SEXUAL CONTENT INVOLVING MINORS — EVER
Zero tolerance. This includes sexualised comments about minors and attempts to contact minors inappropriately. Accounts are banned and reported.

3. NUDITY AND SEXUAL CONTENT
Phixr is not for pornography or sexually explicit content. Artistic, educational and health contexts are allowed with care; borderline content may be marked sensitive, which hides it from under-18s entirely and covers it for adults until tapped.

4. HARASSMENT AND HATE
Don't attack people. No bullying, threats, or encouraging a pile-on; no hate against people for who they are (race, religion, nationality, disability, sex, sexual orientation, gender identity, age). Criticising ideas is fine; dehumanising people is not. Use the tools: block, mute, hidden words, comment limits and reporting all work, and blocking is always invisible to the blocked person.

5. VIOLENCE AND DANGEROUS ACTS
No glorifying violence, no gore shared for shock, no instructions for weapons or attacks, and no content encouraging self-harm, suicide or eating disorders. If you're struggling, the app's wellbeing tools can slow things down — and if someone is in immediate danger, call 999.

6. BE REAL
No impersonating people or brands (parody must be obvious). No fake engagement: no bots, swipe farms, bought likes or coordinated manipulation — our systems detect this, and manipulated engagement never counts toward reach or points. One person running several themed accounts is fine; evading a ban is not.

7. SPAM AND SCAMS
No repetitive unwanted content, pyramid schemes, misleading links, or off-platform scams. Bio links that lead to blocked domains are removed.

8. PRIVACY OF OTHERS
Don't share someone's private information (address, phone number, private messages) without their consent. Don't post images of people in private situations without their consent. Audience-group membership is private by design — don't try to expose who is in anyone's groups.

9. REPORTING, STRIKES AND APPEALS
Report anything with the in-app Report button — reports are confidential. A human-plus-automated review decides; repeated or serious breaches earn strikes leading to restrictions, suspension or a ban. Every removal and strike can be appealed in-app, and appeals are reviewed by a person. Our moderation numbers are published in the transparency report in the app.`,
  },
  ads: {
    title: 'Advertising Policy',
    updated: TERMS_VERSION,
    body: `This policy covers ads on Phixr, boosts, and paid partnerships. It sits alongside the Terms of Service and the UK Code of Non-broadcast Advertising (the CAP Code), which all advertising on Phixr must follow.

1. WHO MAY ADVERTISE
Advertisers must be 18 or over with a business account. Advertisers are responsible for their ads being legal, decent, honest and truthful, and for holding evidence for any claims.

2. WHAT MAY NOT BE ADVERTISED
No ads for: illegal products or services; weapons; drugs (including CBD claims that breach regulations); tobacco or vaping; gambling; alcohol; dating or adult services; cosmetic procedures aimed at under-18s; payday loans or crypto-asset promotions that breach FCA rules; political advertising; miracle health or weight-loss claims; counterfeits. We may refuse or remove any ad that doesn't fit Phixr.

3. HOW ADS WORK ON PHIXR
Every ad is clearly labelled as sponsored and every ad explains itself: tap "Why am I seeing this?" on any ad for an honest answer. Ads appear as cards in the deck and are capped in frequency. You can hide any ad, and hiding it is immediate.

4. TARGETING AND PRIVACY
Personalised ads are shown only to adults who have consented, and the choice can be changed at any time in Settings. Targeting uses age group, coarse area and interests — never exact location. "Engaged" and "similar" audiences are matched on our servers when an ad is served: advertisers never receive lists of people, only anonymous adult totals, and no figure based on fewer than 50 people is ever shown. Under-18s never receive targeted ads and never appear in advertiser data. Brand-safety controls let advertisers keep their ads away from sensitive content.

5. BOOSTS
A boost promotes your own post to more people and is always labelled. Boosts never reach under-18s. On iPhone, boosts are bought through Apple in-app purchase. Boost performance reports follow the same privacy floors as ad reports.

6. PAID PARTNERSHIPS (CREATORS)
If you're paid, gifted or sponsored to post about a brand, you must use the in-app "Paid partnership" label — the ASA requires advertising to be obviously identifiable. The brand can approve the tag so its name appears. Hidden advertising earns moderation action and can breach consumer-protection law.

7. BILLING
Advertising is billed from your ad-account balance, topped up by card on the web (never inside the iPhone app). Charges accrue per delivery as shown in the ads manager; reports and the activity log show every charge. Balances are not transferable and unused balance is refundable on account closure, less amounts owed.

8. REPORTING AN AD
Any user can report any ad in two taps from the ad itself. Ads that break this policy are removed; repeat offenders lose advertising access.`,
  },
  safety: {
    title: 'Online Safety',
    updated: TERMS_VERSION,
    body: `This is a plain-language summary of how Phixr protects people, in line with our duties under the Online Safety Act 2023.

PROTECTING UNDER-18s
You must be 13 to join, and we check date of birth at signup (with a cool-down that stops immediate retries after an under-13 answer). Accounts for 13–17-year-olds are: private by default; never shown targeted ads, boosts or advertiser content; excluded from all advertiser data; protected from discovery by adults by default; unable to add bio links; and covered by sensitive-content filters that cannot be turned off for them. A daily time reminder is on by default for teens.

ILLEGAL CONTENT
We scan uploads before they're visible and hold anything the systems flag for review. Child sexual abuse material triggers immediate removal, a permanent ban and a report to the authorities — this duty overrides everything else. Terrorism content, threats, and other priority illegal content are removed and escalated on dedicated internal queues.

REPORTING AND WHAT HAPPENS NEXT
Everything on Phixr can be reported in two taps, including ads and messages. Reports are confidential. They go into a prioritised review queue; outcomes (removal, strikes, restrictions, suspensions, bans) depend on severity and history, and we tell you the outcome of your report where we can. Decisions about your content or account can be appealed in the app and appeals are reviewed by a person.

PROACTIVE MODERATION
Beyond reports, Phixr runs automated scanning on media at upload, text moderation on captions, comments, offers and scheduled posts before they publish, hidden-word filters you control, comment limits, link blocklists, and systems that detect fake engagement and ban evasion. Scheduled content is re-checked at publish time so nothing bypasses review.

TOOLS YOU CONTROL
Block (invisible to the blocked person), mute, report, hidden words, comment limits, message requests from strangers, quiet mode, time reminders, and "not interested" controls for the feed. Under Settings → Security: two-step login and login alerts with one-tap account lockdown.

TRANSPARENCY
Our moderation statistics are published in the in-app transparency report, updated regularly: reports received, action taken, response times and appeal outcomes.

CONTACT
Safety concerns: use in-app reporting first — it's the fastest route to the review team. Anything else: support@joinphixr.com. If someone is in immediate danger, contact the police on 999 before reporting in-app.`,
  },
};
