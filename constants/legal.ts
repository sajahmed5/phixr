/**
 * Legal documents + the current terms version.
 *
 * Bump `TERMS_VERSION` whenever the Terms or Privacy text materially changes: the app
 * compares it to `profiles.terms_version` and re-prompts anyone on an older version.
 * (Bumped 2026-11-26: full rewrite for the personal / business account model, plus four
 * new documents (Business & Creator Terms, Copyright, Complaints & Appeals, Beta Testing).
 * Everyone re-accepts once.)
 *
 * Body format (also parsed by scripts/build-legal-site.js, which publishes every document
 * to https://phixr-legal.vercel.app): paragraphs are separated by blank lines; a block
 * that starts with a line like `3. YOUR CONTENT` (number, full stop, ALL CAPS) opens a
 * section; a paragraph that starts "Label — text" gets a bold lead-in on the website; a
 * block whose lines all start with "• " is a bulleted list. Titles must not contain an
 * apostrophe and bodies must not contain a backtick.
 */
export const TERMS_VERSION = '2026-11-26';

export type LegalDocId =
  | 'terms'
  | 'privacy'
  | 'guidelines'
  | 'safety'
  | 'complaints'
  | 'ads'
  | 'business'
  | 'copyright'
  | 'beta';

export const LEGAL_DOCS: Record<LegalDocId, { title: string; updated: string; body: string }> = {
  terms: {
    title: 'Terms of Service',
    updated: TERMS_VERSION,
    body: `Welcome to Phixr. These Terms of Service are a legal agreement between you and Phixr ("Phixr", "we", "us", "our"). They explain what you can expect from us and what we expect from you. By creating an account or using Phixr you agree to them. If you don't agree, please don't use Phixr.

We've tried to write these terms in plain English. If anything is unclear, email us at support@joinphixr.com and we'll explain.

1. ABOUT US AND THESE TERMS
Phixr is operated from the United Kingdom. You can contact us at support@joinphixr.com. Our address for the service of legal documents is available on request from the same email address.

These terms include the following documents, which also apply to you and which you can read in the app (Settings → Legal) and on our website:

• Community Guidelines: the rules for what you post and how you behave on Phixr.
• Online Safety: how we protect people and deal with illegal and harmful content.
• Advertising Policy: the rules for ads, boosts and paid partnerships.
• Business & Creator Terms: extra terms that apply if you turn on a business account.
• Copyright & Intellectual Property: how we deal with infringement and impersonation.
• Complaints & Appeals: how to complain or challenge a decision.
• Beta Testing (TestFlight): extra terms that apply while you use a pre-release version.

Our Privacy Policy explains how we collect and use personal data. It is not part of this contract, but please read it. If these terms and one of the documents above say different things about the same subject, the more specific document applies (for example, the Business & Creator Terms for business features).

In these terms, a "consumer" is an individual using Phixr wholly or mainly for purposes outside their trade, business, craft or profession. A "business user" is anyone using a business account, or using Phixr for the purposes of a trade, business, craft or profession. Some parts of these terms apply differently to consumers and business users, and we say so where they do.

2. WHO CAN USE PHIXR
You must be at least 13 years old to use Phixr. If you are under 18, some features are restricted or switched off for your protection (see our Online Safety statement), and you confirm that a parent or guardian knows you use Phixr.

Business accounts, promotion, boosts, advertising and creator earnings are only for people aged 18 or over.

You must give your true date of birth when you sign up. We may ask you to confirm your age if we have reason to think it is wrong. We remove accounts that we find belong to someone under 13, and we may remove or restrict accounts created with a false date of birth.

You can't use Phixr if we have previously banned you, or if the law prevents you from receiving our services. If you use Phixr on behalf of a business or organisation, you confirm that you have authority to accept these terms for it.

3. PERSONAL AND BUSINESS ACCOUNTS
Every account starts as a personal account. A personal account lets you post photos and videos, share stories, swipe the deck, like and skip posts, follow people, comment, send messages, and use audience groups and close friends. Personal accounts can't promote posts, buy boosts, earn money, use analytics dashboards or schedule posts.

If you are 18 or over you can turn on a business account in Settings → Business account. A business account unlocks creator and business tools, including drafts and scheduling, analytics and insights, boosting and promoting posts, paid-partnership labels, creator earnings and payouts, advertising through our ads manager on the web, team members with roles, a business inbox, offers and opening hours, and A/B tests. When you turn on a business account you also agree to the Business & Creator Terms.

Only business accounts can earn money or promote content on Phixr. You can switch a business account back to a personal account at any time. When you do, business tools stop being available to you, your posts stay where they are, and any balances are dealt with as the Business & Creator Terms and Advertising Policy explain.

Points are a free reward for taking part and are available to everyone, whichever type of account you have (see section 12).

You may hold more than one account (for example, a personal account and a separate account for a project), but you must not use extra accounts to get round a suspension or ban. Bans apply to the person, not just the account.

4. BETA AND PRE-RELEASE VERSIONS
Phixr is currently available as a closed beta through Apple's TestFlight. While you use a beta or other pre-release version, our Beta Testing terms also apply. In short: features may change, appear or disappear without notice; things may not always work as expected; and we may need to reset some or all data, including accounts, posts, points and messages. If you send us feedback, we may use it freely to improve Phixr. Nothing in this section affects your legal rights as a consumer.

5. YOUR ACCOUNT AND SECURITY
Keep your login details private and use a password you don't use anywhere else. You are responsible for activity on your account, unless it happens because someone else got into your account without your fault.

We strongly recommend turning on two-step login in Settings → Security & two-step login, and keeping your backup codes somewhere safe. If you get a login alert for a sign-in you don't recognise, tap "This wasn't me": we'll sign your account out everywhere and email you a link to reset your password. If you think your account has been compromised, tell us straight away at support@joinphixr.com.

Your handle must not impersonate anyone or infringe anyone's rights. We may change or reclaim a handle that does, or that breaks our rules. You must not buy, sell, rent, lend or transfer your account or handle.

6. YOUR LICENCE TO USE PHIXR
Phixr, including the app, our websites and the software behind them, belongs to us or the people we license it from. As long as you follow these terms, we give you a personal, non-exclusive, non-transferable, revocable licence to install and use the Phixr app on devices you own or control, and to use our service, for your own personal use or, if you have a business account, for your business. The rules of the app store you downloaded Phixr from also apply.

Some parts of Phixr use open-source software, which is licensed under its own terms. Nothing in these terms limits your rights under those licences.

7. OUR INTELLECTUAL PROPERTY
The Phixr name, logo, look and feel, software and other materials we provide are protected by intellectual property laws. You must not copy, modify, distribute, sell or lease any part of them, or decompile, reverse-engineer or try to extract the source code of our software, except where the law allows you to or we give you written permission. You must not use our name or logo in a way that suggests we endorse or are connected with you without our written permission.

8. YOUR CONTENT
Your content is yours. "Content" means anything you post, upload, send or create on Phixr, including photos, videos, stories, captions, comments, messages, profile details and offers.

So that Phixr can work, you give us a non-exclusive, worldwide, royalty-free licence to host, store, copy, adapt (for example, to make thumbnails and previews, or to compress and transcode video), publish, display and distribute your content on Phixr, in line with your privacy and audience settings, and to let our service providers do the same only for the purpose of running Phixr. This licence ends when you delete the content or your account, except: where others have reshared it within Phixr; where we need to keep it to comply with the law, to deal with a report, appeal or legal claim, or to keep evidence of a serious crime; in anonymised statistics; and in backups, which clear on a rolling basis shortly after deletion.

You keep your moral rights in your content. You agree that the technical changes needed to show it on Phixr (such as cropping to fit the screen, compression and thumbnails) are not a breach of them.

You are responsible for your content. You confirm that you own it or have permission to post it, that you have the consent of identifiable people where that is needed, and that it follows these terms, the Community Guidelines and the law.

We check content using automated systems and people, and we may hold content for review before it appears. We may remove or restrict content that breaks our rules or the law, or that we reasonably believe could cause harm. We don't promise to monitor everything, and we aren't responsible for content posted by other people, although we act on reports as described in our Online Safety statement.

If you send us ideas, suggestions or feedback, you agree we can use them without paying you or owing you anything.

9. HOW YOUR FEED WORKS
Phixr uses automated systems to decide which posts to show you and in what order. The main signals are what you like and skip, which accounts you follow, how fresh a post is, quality signals about the post, and the creator's points. Your left swipes (skips) are always private: we never show anyone which posts you skipped, and creators and advertisers only ever see anonymous totals.

You can see and change what Phixr has learned about your interests in Settings → Your interests, and use "not interested" controls in the feed. Ads and boosted posts are always labelled. Nobody can pay to rank higher in the feed except through clearly labelled ads and boosts. The Privacy Policy explains more about how we use automated systems.

10. MODERATION AND AUTOMATED SYSTEMS
We use a mix of automated tools and human review to keep Phixr safe. Automated systems scan photos and videos when they're uploaded, check text such as captions, comments, offers and scheduled posts before they're published, and look for fake engagement, bots and ban evasion. Depending on what they find, they may block, hold, hide, label or limit content, or stop fake engagement counting towards reach or points.

When we take action against your content or account, we'll usually tell you what we did and why, unless telling you would put someone at risk, interfere with an investigation or break the law. You can appeal decisions about your content or account in the app, and appeals are reviewed by a person. Our Complaints & Appeals document explains how.

11. ACCEPTABLE USE
When you use Phixr you must follow the Community Guidelines and the law. You must not:

• use Phixr if we have banned you, or create accounts to get round a ban or restriction;
• access, collect or copy data or content from Phixr by automated means (including scraping, crawling and bots), including to build datasets or train machine-learning models, unless we have agreed in writing;
• interfere with, disrupt, overload or try to gain unauthorised access to Phixr, other people's accounts, or our systems, or upload viruses or other harmful code;
• test the security of Phixr without our written permission (if you find a vulnerability, please report it to support@joinphixr.com and don't exploit it);
• buy, sell or rent accounts, handles, followers, likes, views or points, or take part in schemes to fake engagement;
• try to find out who skipped a post, who is in someone's audience groups, or any other information we keep private;
• get round age checks or the protections for under-18 users;
• use Phixr to send spam or unsolicited marketing;
• misuse reporting or appeal tools, for example by making reports you know are false; or
• help or encourage anyone else to do any of these things.

12. POINTS
Points are a free reward for genuine activity on Phixr. A higher points balance can help your posts reach more people, as explained in Settings → How points work. Everyone earns points the same way, whether they have a personal or business account. Business accounts can also spend points to boost their own posts; if a boost is stopped before it ends, the points for the unused time are returned. Points have no cash value. They are not money or property, and can't be bought, sold, transferred or exchanged for money.

We may adjust or remove points gained through manipulation (such as bots, swipe farms, comment rings or self-dealing), or by mistake. We may change how points are earned or what they do, and we'll explain significant changes in the app.

13. PURCHASES AND PAYMENTS
Paid features are only available to business accounts. Boosts can be paid for with points (see section 12) or, where we offer it, bought as an in-app purchase through Apple on iPhone or Google Play on Android. Apple or Google processes the payment, and their terms and refund processes apply alongside these terms. We never see your card details.

Advertising is paid for from an ad-account balance that you top up by card on the web through our payment provider, Stripe, once card billing is switched on. Top-ups are never taken inside the iPhone app. The Advertising Policy explains how advertising is billed.

Prices are shown in the app or ads manager before you pay. A boost gives a post extra, clearly labelled distribution for the duration or amount shown when you buy it. It doesn't guarantee any particular number of views, likes, follows or sales.

If we remove a boosted post because it breaks our rules, the boost stops. We don't refund boosts that stop because of a rules breach, except where the law or the app store's rules require it.

14. YOUR RIGHT TO CANCEL DIGITAL PURCHASES
If you are a consumer, you normally have a legal right to cancel a contract for digital content or a digital service within 14 days of buying it, under the Consumer Contracts (Information, Cancellation and Additional Charges) Regulations 2013.

Boosts start straight away. When you buy a boost, you ask us to start it immediately and you acknowledge that you lose your right to cancel once it has started. If you buy a boost that is set to start later, you can cancel it before it starts, within 14 days of buying it, for a full refund.

For purchases made through Apple or Google, refunds are handled through their refund processes (for Apple, at reportaproblem.apple.com). If you have trouble, contact us and we'll help.

Advertising top-ups are business purchases, so the consumer cancellation right doesn't apply to them. Unused advertising balance is refundable as the Advertising Policy explains.

15. YOUR RIGHTS AS A CONSUMER
If you are a consumer, nothing in these terms affects your legal rights. Under the Consumer Rights Act 2015, digital content you pay for must be of satisfactory quality, fit for purpose and as described, and any service we provide must be carried out with reasonable care and skill. If it isn't, you may be entitled to a repair or replacement, or to some or all of your money back. If digital content we supply damages your device or other digital content, and that happens because we didn't use reasonable care and skill, we'll either repair the damage or compensate you.

For independent advice about your consumer rights, contact Citizens Advice (citizensadvice.org.uk).

16. THIRD-PARTY SERVICES AND LINKS
Phixr works with services run by other companies, such as Apple and Google (app distribution, purchases, notifications and venue search) and our payment provider. Your use of those services is also governed by their terms and privacy policies. Venue information, such as names and addresses from map providers, comes from third parties and may not always be accurate.

Posts, profiles and messages may contain links to other websites. We don't control them and aren't responsible for their content, products or practices, although we block links to known harmful domains. Be careful before sharing information with or buying from anyone you meet on Phixr.

17. PRIVACY
Our Privacy Policy explains how we collect, use and protect personal data, and your rights. Your swipes, audience groups and approximate location get extra protection, described there.

18. CHANGES TO PHIXR AND TO THESE TERMS
Phixr is growing and changing, especially during the beta. We may add, change or remove features, for example to improve the service, respond to feedback, keep people safe, or comply with the law. If a change significantly affects something you've paid for and haven't yet received, we'll tell you in advance and you can cancel and get a refund for the part you haven't received.

We may update these terms, for example to reflect changes to Phixr or the law. We'll tell you about material changes in the app, and ask you to review and accept the new version before you continue using Phixr. If you don't accept the changes, you can stop using Phixr and delete your account. The version date of each document is shown at the top.

19. SUSPENSION AND TERMINATION
We may remove content, restrict features, or suspend or end accounts that break these terms, the Community Guidelines or the law, or that put other people or Phixr at risk. We may also do so where the law or a regulator requires it. How we respond depends on how serious the breach is and the account's history. Serious or repeated breaches can lead to a permanent ban.

Where appropriate we'll tell you what we did, why, and how to appeal, unless telling you would put someone at risk, interfere with an investigation or break the law. You can appeal in the app.

You can stop using Phixr whenever you like, and delete your account at any time in Settings → Delete account.

20. WHAT HAPPENS WHEN YOUR ACCOUNT ENDS
When your account ends, for whatever reason, your licence to use Phixr ends and your profile and content are removed from Phixr, as the Privacy Policy explains. We keep some information where the law requires, or where we need it for safety, security, fraud prevention or legal claims. Points end and have no value. Unused advertising balance and confirmed creator earnings are handled as the Advertising Policy and Business & Creator Terms explain.

Sections of these terms that by their nature should continue (including those about intellectual property, our responsibility for loss, the business indemnity, and governing law) continue after your account ends.

21. COMPLAINTS
If you have a complaint about Phixr, a purchase, or a decision we've made, please tell us. You can report content or appeal a decision in the app, or email support@joinphixr.com. Our Complaints & Appeals document explains how we handle complaints, how long it takes and what you can do if you're not happy with our response.

We don't currently offer an alternative dispute resolution (ADR) scheme, and we are not obliged to use one. This doesn't affect your right to go to court, or to complain to a regulator such as the Information Commissioner's Office.

22. OUR RESPONSIBILITY FOR LOSS OR DAMAGE
We don't exclude or limit our liability where it would be unlawful to do so. This includes liability for death or personal injury caused by our negligence, for fraud or fraudulent misrepresentation, and, if you are a consumer, for breach of your legal rights in relation to what we supply.

If you are a consumer: we are responsible for loss or damage you suffer that is a foreseeable result of us breaking these terms or failing to use reasonable care and skill. Loss or damage is foreseeable if it is obvious that it will happen, or if we both knew it might happen when you started using Phixr. We aren't responsible for loss or damage that isn't foreseeable. Personal accounts are for domestic and private use, so we aren't responsible to consumers for any loss of profit, business, business opportunity or business interruption.

If you are a business user: to the extent the law allows, we exclude all implied terms and warranties; we aren't liable for any loss of profit, revenue, business, goodwill, anticipated savings or data, or for any indirect or consequential loss; and our total liability to you arising from or in connection with Phixr in any 12-month period is limited to the greater of £100 and the amounts you paid us in the 12 months before the event giving rise to the claim.

For everyone: Phixr is a platform for content created by its users. We aren't responsible for what other users post, say or do, on or off Phixr. We work hard to keep Phixr available and secure, but we can't promise it will always be available, uninterrupted or free from errors, and we aren't responsible for problems caused by your device, internet connection or other services we don't control.

23. INDEMNITY (BUSINESS USERS ONLY)
This section applies only to business users. It does not apply to consumers.

If you are a business user, you will compensate us for any losses, damages, fines, penalties and reasonable costs (including reasonable legal fees) that we suffer as a result of a claim by a third party, or action by a regulator, arising from: your content, ads, offers or paid partnerships; your breach of these terms, the Business & Creator Terms, the Advertising Policy or the law; or anything done by members of your team. We'll tell you promptly about any such claim, let you take part in defending it where that's reasonable, and not settle it without consulting you.

24. EVENTS OUTSIDE OUR CONTROL
We aren't responsible for delays or failures caused by events outside our reasonable control. These include failures of internet, power or telecommunications networks, outages at service providers we rely on, cyber-attacks despite reasonable precautions, fire, flood, storm, epidemic, war, terrorism, civil unrest, industrial action, and action by governments or regulators. If one of these events affects Phixr, we'll do what we reasonably can to limit the effect and get things working again. If it significantly affects something you've paid for, you can cancel and get a refund for the part you haven't received.

25. NOTICES
We'll send notices to you in the app or by email to the address on your account, so please keep it up to date. Notices sent by email are treated as received when sent, unless we know they didn't arrive.

Please send notices to us by email to support@joinphixr.com. Our address for the service of legal documents is available on request from the same email address.

26. APPLE AND GOOGLE PLAY
If you downloaded Phixr from Apple's App Store:

• These terms are between you and Phixr only, not Apple. Phixr, not Apple, is solely responsible for the app and its content.
• Your licence to use the app is limited to Apple-branded products you own or control, as permitted by the Usage Rules in Apple's Media Services Terms and Conditions.
• Apple has no obligation to provide any maintenance or support for the app.
• If the app fails to meet any warranty that applies to it, you can tell Apple, and Apple will refund the purchase price of the app, if any. To the extent the law allows, Apple has no other warranty obligation for the app.
• Phixr, not Apple, is responsible for dealing with any claims by you or anyone else relating to the app, including product liability claims, claims that the app fails to meet legal or regulatory requirements, and claims under consumer protection, privacy or similar laws.
• If anyone claims that the app or your use of it infringes their intellectual property rights, Phixr, not Apple, is responsible for investigating, defending, settling and discharging that claim.
• You confirm that you are not located in a country subject to a United States government embargo, or designated by the United States government as a "terrorist supporting" country, and that you are not on any United States government list of prohibited or restricted parties.
• Questions, complaints and claims about the app should be sent to us at support@joinphixr.com.
• You must comply with any third-party terms that apply when you use the app, such as your mobile network's terms.
• Apple and its subsidiaries are third-party beneficiaries of these terms and, once you accept them, Apple has the right to enforce them against you as a third-party beneficiary.

If you downloaded Phixr from Google Play, Google Play's terms also apply to your download and any purchases you make through Google Play.

27. GENERAL
Transfer — We may transfer our rights and obligations under these terms to another organisation, for example as part of a reorganisation or sale of Phixr. If we do, we'll tell you, and your rights under these terms won't be reduced. You may not transfer your rights or obligations to anyone else.

Third-party rights — Apart from Apple's rights described in section 26, nobody other than you and us has any right to enforce these terms, and the Contracts (Rights of Third Parties) Act 1999 does not apply.

Entire agreement — These terms (with the documents listed in section 1) are the whole agreement between you and us about Phixr and replace any earlier agreement or understanding. Nothing in this paragraph limits your legal rights as a consumer or our liability for fraudulent misrepresentation.

Severance — If a court decides that part of these terms is unlawful or unenforceable, the rest stays in force.

No waiver — If we don't enforce our rights straight away, we can still enforce them later. Not insisting on something once doesn't mean we've given up the right to insist on it.

Language — These terms are in English, and English is the language of our contract with you.

28. GOVERNING LAW AND COURTS
These terms are governed by the law of England and Wales.

If you are a consumer, you can bring legal proceedings about Phixr in the courts of England and Wales. If you live in Scotland, you can also bring them in Scotland; if you live in Northern Ireland, you can also bring them in Northern Ireland. If you live in Scotland or Northern Ireland, you keep the protection of any mandatory rules of the law where you live.

If you are a business user, the courts of England and Wales have exclusive jurisdiction over any dispute or claim arising from or in connection with these terms or Phixr.`,
  },
  privacy: {
    title: 'Privacy Policy',
    updated: TERMS_VERSION,
    body: `This policy explains what personal data Phixr collects, why we collect it, who we share it with, how long we keep it, and the rights you have. It applies to the Phixr app, our websites (including the ads manager and public post pages) and our support channels.

We've designed Phixr to collect as little as we need. In particular, your skips are always private, we never store your exact location, under-18s are never included in advertising, and we don't track you across other companies' apps or websites.

1. WHO WE ARE AND HOW TO CONTACT US
Phixr ("we", "us") is the data controller for your personal data. That means we decide how and why it is used, and we are responsible for protecting it under the UK General Data Protection Regulation (UK GDPR), the Data Protection Act 2018 and the Privacy and Electronic Communications Regulations (PECR).

Phixr is operated from the United Kingdom. For any privacy question, or to use your rights, email support@joinphixr.com. Please put "Privacy" in the subject line so it reaches the right person quickly. Our postal address for legal correspondence is available on request from the same email address.

2. THE SHORT VERSION
• We use your data to run Phixr, keep it safe, and (only if you're an adult and you agree) show you personalised ads.
• Nobody can ever see which posts you skipped. Creators and advertisers only see anonymous totals.
• Advertisers never see figures based on fewer than 50 people, and never get lists of people.
• Under-18s are never included in advertiser data or ad targeting.
• We only ever store a coarse area, never your exact GPS location.
• We never sell your personal data.
• You can download your data, correct it, or delete your account in the app.

3. WHAT WE COLLECT AND WHY
Below we explain each type of data, why we use it, and our lawful basis under UK GDPR. Section 5 explains what the lawful bases mean.

Account details — your email address, handle, display name, date of birth and password. Your password is stored only as a secure hash by our authentication provider; we can't see it. We use these to create and run your account, sign you in, contact you about your account, and apply age-appropriate protections. Lawful basis: contract; for age protections, also legal obligation (the Online Safety Act 2023).

Profile details — your profile photo, bio, links, and whether your account is private. Lawful basis: contract.

Your content — posts, photos, videos, stories, captions, comments, messages, offers, opening hours and anything else you create. We remove location data (EXIF metadata, including GPS) from photos when they're uploaded, before they're stored. Lawful basis: contract.

Your activity — your likes and skips, what you view and for how long, searches, follows, saves and shares. We use this to rank your feed, count anonymous reach for creators, award points, and detect fake engagement. Your skips are always private. Lawful basis: contract (running the feed you signed up for) and legitimate interests (keeping engagement genuine and Phixr free of manipulation).

Interests — topics we infer from your activity so we can show you posts you'll like. You can see and change them in Settings → Your interests. Lawful basis: contract.

Approximate area (optional) — if you set a search area or add a location to a post, we store a coarse grid cell and a place label, never your exact GPS coordinates. When you search for a venue, your approximate position and search words are sent to Google Places to find nearby public places. Map pins only ever show public venues. Under-18s can't tag venues. Lawful basis: consent; you can remove your area at any time in Settings.

Points — your points balance and a history of how you earned and used them. Lawful basis: contract.

Audience groups and close friends — the lists you create to choose who sees your posts and stories. Membership is secret: nobody else can see who you've put in a group. Lawful basis: contract.

Security information — a one-way hashed device identifier (the raw identifier never leaves your device), sign-in history per device for login alerts, two-step login enrolment, hashed one-time backup codes, and records of security actions such as "This wasn't me". Lawful basis: legitimate interests (protecting accounts and preventing ban evasion).

Wellbeing settings — quiet mode hours, auto-reply text, time-reminder settings, hidden words and like-count preferences. Lawful basis: contract.

Notification details — your device's push token and your notification preferences, so we can send the notifications you've chosen. Lawful basis: contract.

Advertising data (adults only, by consent) — your personalised-ads choice with a timestamp, and your interactions with ads (views, clicks and hides). If you consent, ads may be chosen using your age group, area and interests, including whether you have previously liked an advertiser's posts ("engaged" and "similar" audiences). This matching happens on our servers at the moment an ad is shown, and advertisers never receive a list of people. Lawful basis: consent; you can withdraw it at any time in Settings → Personalised ads. If you don't consent, you'll still see ads, but they won't be based on you.

Business account data — the fact that you have a business account, business details, venue claims, offers and opening hours, team members and their roles, a log of team actions, business inbox conversations, drafts and scheduled posts, A/B tests and campaign settings. Lawful basis: contract; legal obligation for records we must keep.

Purchases, billing and payouts — for iPhone boosts, Apple processes your payment and sends us a purchase receipt; we never see your card details. Advertiser billing and creator payouts are handled by our payment provider, which may collect identity, bank and tax details to verify you and pay you; we receive the records we need, such as amounts, dates and payout status. Lawful basis: contract; legal obligation (accounting and tax records).

Moderation and safety records — reports you make or that are made about you or your content, the results of automated checks, moderation decisions, strikes, appeals and their outcomes. Lawful basis: legal obligation (the Online Safety Act 2023) and legitimate interests (keeping Phixr safe).

Support and feedback — messages you send us, bug reports and feedback, including any screenshots you choose to attach. Lawful basis: legitimate interests (helping you and improving Phixr).

Crash reports — when the app crashes or hits an error, a report is sent to our error-reporting service. Identifiers, email addresses and login tokens are removed before the report leaves your device. Lawful basis: legitimate interests (keeping Phixr working).

Usage analytics (optional) — if you leave Settings → Share anonymous usage data switched on, we collect usage events (for example, which screens are opened) linked to a random account identifier. These events never include your name, email or handle, never record which posts you swiped, and don't use your IP address to work out where you are. Lawful basis: legitimate interests; you can switch it off at any time and it stops before any further event is sent.

Technical information — your IP address and basic device information are processed when your device connects to our servers, to deliver the service, limit abuse and keep things secure. We don't store your IP address on your profile. Lawful basis: legitimate interests.

Special category data — we don't ask for information about your health, religion, ethnicity, sexual orientation, political views or other special categories. If you choose to include such information in public content, it will be visible as you choose. Where we process information about suspected criminal offences (for example, when reporting child sexual abuse material to the authorities), we do so as permitted by the Data Protection Act 2018.

4. INFORMATION WE GET FROM OTHERS
We also get some information about you from other people and organisations:

• other users, when they mention or tag you, message you, add you to an audience group, invite you to a business team, or report you or your content;
• Apple and Google, when you buy something through their stores (purchase receipts) and through TestFlight if you're a beta tester (see the Beta Testing terms);
• our payment provider, about payouts and billing (status, amounts and verification outcomes); and
• Google Places, which provides information about public venues.

5. OUR LAWFUL BASES EXPLAINED
Contract — we need the data to provide Phixr under our Terms of Service.

Legitimate interests — we use the data for our legitimate interests or those of others, such as keeping Phixr secure, preventing fraud and fake engagement, and improving the service, where those interests aren't overridden by your rights. You can ask us for details of the balancing test we carried out, and you have the right to object (see section 17).

Consent — you have chosen to let us use the data for a specific purpose (personalised ads and your approximate area). You can withdraw your consent at any time in Settings. Withdrawing doesn't affect anything we did before, or anything else in your account.

Legal obligation — the law requires us to use the data, for example to keep financial records, to meet our online safety duties, or to report child sexual abuse material.

Vital interests — very occasionally, we may use or share data to protect someone's life, for example where someone appears to be at immediate risk of serious harm.

6. WHAT OTHER PEOPLE CAN SEE
Your handle, display name, profile photo and bio are public. If your account is public, your posts can be seen by anyone on Phixr and on public post pages; if it's private, only followers you approve can see them. Audience groups and close friends let you narrow this further.

Creators can see who liked their posts unless you switch on Settings → Hide my likes; your likes still count in totals. Nobody can ever see which posts you skipped. Comments are visible to people who can see the post. Messages are visible to the people in the conversation, and business messages may be seen by members of that business's team.

Creators and advertisers see anonymous totals about how their posts and ads perform. Advertiser figures never cover fewer than 50 people, and never include under-18s.

7. CHILDREN AND TEENAGERS
Phixr is for people aged 13 and over. We follow the ICO's Age Appropriate Design Code (the Children's Code), which means we put the best interests of under-18 users first when we design features that use their data. In practice:

• High privacy by default: accounts for 13 to 17-year-olds are private by default and protected from discovery by adults by default.
• No advertising profiling: under-18s never receive targeted ads or boosted content, and are never included in advertiser data, audiences or reports.
• Location: approximate area is off unless you choose it, we never store exact GPS, and under-18s can't tag venues.
• Data minimisation: we collect only what we need to run the service, and we don't collect phone numbers, contacts or browsing history.
• Feed personalisation: the feed uses your activity on Phixr to choose posts, because that is the core service. We don't use teenagers' data for anything else that could harm their interests.
• No paid features: under-18s can't buy boosts, earn money or turn on a business account.
• Wellbeing: a daily time reminder is on by default, and sensitive-content filters can't be turned off.
• Clear information: we explain privacy choices in plain language at the point you make them.

If we learn that an account belongs to someone under 13, we delete it. If you think a child under 13 is using Phixr, please report the account in the app (choose "May be under 13") or tell us at support@joinphixr.com.

8. AUTOMATED DECISIONS AND PROFILING
We use automated systems in three main ways. None of them involves decisions about you that are made using special category data.

Feed ranking — our systems decide which posts to show you and in what order, based on what you like and skip, who you follow, how fresh posts are, quality signals and creator points. This is profiling, but it doesn't have legal or similarly significant effects on you. You can view and change your interests in Settings → Your interests and use "not interested" controls.

Content moderation — automated tools scan uploaded images and video posters for unsafe content, and check text such as captions, comments, offers and scheduled posts before they're published. They may block, hold for human review, label as sensitive, or hide content.

Bot and fake-engagement detection — automated systems look for patterns that suggest bots, swipe farms, comment rings or ban evasion. Engagement that looks fake may not count towards reach, points or earnings, and accounts may be restricted.

Where an automated decision significantly affects you (for example, removing your content, restricting your account or withholding earnings), you have the right to be told about it, to explain your point of view, to have a person review the decision, and to challenge it. You can do this by appealing in the app (appeals are always reviewed by a person) or by emailing support@joinphixr.com. More serious account actions, such as permanent bans, are checked by a person.

9. ADVERTISING AND YOUR CHOICES
Ads on Phixr are always labelled, and every ad has a "Why am I seeing this?" option that explains why it was shown to you. Personalised ads are only shown to adults who have switched on Settings → Personalised ads. You can change your choice at any time, and we keep a timestamped record of it.

We don't use advertising cookies or advertising identifiers, we don't track you across other companies' apps or websites, and we don't show Apple's App Tracking Transparency prompt because we don't do that kind of tracking. Advertisers never receive lists of people, contact details or individual-level data.

10. WHO WE SHARE INFORMATION WITH
We never sell your personal data. We share it only in these situations:

Service providers — companies that process data on our behalf under contracts that require them to keep it secure and use it only on our instructions (see section 11).

Other users — as described in section 6, according to your settings.

Advertisers and businesses — only anonymous, aggregated totals, never covering fewer than 50 people, and never including under-18s.

Payment providers and app stores — to process purchases, billing and payouts.

Authorities — where the law requires us to, or where we believe in good faith that disclosure is necessary to protect someone from serious harm, prevent or detect crime, or respond to a valid legal request. We report child sexual abuse material to the relevant authorities. When we receive a request from law enforcement, we check that it is lawful and proportionate before we respond.

Professional advisers — our lawyers, accountants and insurers, where needed, under duties of confidentiality.

A new owner — if Phixr is reorganised, sold or merged, your data may be transferred to the new owner, who would have to respect this policy.

11. OUR SERVICE PROVIDERS
These are the main service providers (processors) we use, what they do and where they process data:

Supabase — our database, authentication and file storage. Data is hosted in the EU (Ireland).

Cloudflare — stores copies of photos and videos (in the EU) and delivers them to your device. To make them load quickly, Cloudflare's network may briefly cache them in data centres near the people viewing them, which can be outside the UK and EEA.

Sentry — crash and error reports, with identifiers, email addresses and tokens removed. Processed in the EU (Germany).

PostHog — optional usage analytics, which you can switch off in Settings. Processed in the EU.

Expo, Apple and Google push services — delivering push notifications to your device. These services may process your push token and notification content in the United States.

Google Cloud — Vision safety scanning of uploaded images and video posters, and video transcoding (Cloud Run). This may involve processing outside the UK and EEA, including in the United States.

Google Places — venue search, when you search for places. Your search words and approximate position are sent to Google.

Apple App Store and Google Play — app distribution, in-app purchases and, for beta testers, TestFlight.

Stripe — planned: advertiser card billing and creator payouts, once switched on. Stripe also acts as a controller for some data it needs for its own legal duties, such as identity checks, under its own privacy policy.

We may change providers from time to time. If we add a provider that changes how your data is handled in a significant way, we'll update this policy.

12. INTERNATIONAL TRANSFERS
Most of your data is stored in the European Economic Area (EEA), which the UK recognises as providing adequate protection for personal data. Some providers, such as push-notification services, Google Cloud and Cloudflare's delivery network, may process data in other countries, including the United States, and some providers based outside the UK may access data from other countries to support and secure their services.

Whenever personal data is transferred outside the UK and EEA, we make sure it is protected by an appropriate safeguard. That means either a UK adequacy regulation (for example, the UK Extension to the EU-US Data Privacy Framework, where the recipient is certified), or a contract approved for UK transfers: the International Data Transfer Agreement (IDTA), or the UK Addendum to the EU Standard Contractual Clauses. You can ask us for more information about these safeguards.

13. INFORMATION STORED ON YOUR DEVICE
Apps don't use cookies in the way websites do, but they do store information on your device, which the law treats in a similar way. Phixr does not use advertising cookies, tracking pixels or cross-app tracking. Phixr stores:

Login session — kept in your device's secure keychain, so you stay signed in. Strictly necessary.

Offline queue — swipes, posts and messages you make while offline, kept until they can be sent automatically when you're back online. Strictly necessary.

Saved copies for offline viewing — recent feed cards, chats and your inbox, so they're available without a connection. Strictly necessary.

Cached media — images and videos you've viewed, so they load quickly and use less data. Strictly necessary.

Preferences — settings such as your analytics choice and app preferences. Strictly necessary.

Analytics identifier (optional) — if usage analytics is switched on, our analytics tool keeps a random identifier and a short queue of events on your device. Switching analytics off in Settings stops this.

Our websites, such as the ads manager, use only storage that is strictly necessary, such as keeping you signed in. Signing out removes your login session from the device, and deleting the app removes everything Phixr has stored on it.

14. HOW LONG WE KEEP INFORMATION
We keep personal data only for as long as we need it. In summary:

Account details and content — until you delete them or delete your account.

Messages — until they are deleted, or until your account is deleted.

Raw view events — deleted within 90 days. After that, only aggregate statistics remain, which don't identify you.

Media moderation verdicts — the automated result of scanning an upload is kept for about 24 hours.

Moderation, safety and appeal records — kept for as long as we need them to keep Phixr safe, deal with appeals and repeat offending, and meet our legal duties. Strikes expire after a set period.

Evidence of serious crime — where content is evidence of a serious crime, such as child sexual abuse material, we preserve it securely for law enforcement, even if the account is deleted, for as long as the law requires.

Login history, device records and similar security records — only as long as they're useful for keeping accounts secure and preventing ban evasion.

Advertising consent records — for as long as your account exists, so we can show when and how you gave or withdrew consent.

Billing, payout and tax records — for as long as the law requires, which is usually six years after the end of the financial year they relate to.

Crash reports and analytics events — deleted automatically after a limited period set in those services.

Support emails — for as long as we need them to deal with your request and any follow-up.

Backups — when you delete your account we remove your profile and content from Phixr, and backup copies clear on a rolling basis shortly after.

15. HOW WE PROTECT YOUR INFORMATION
We take security seriously and use measures appropriate to the risk, including:

• encryption of data in transit and at rest;
• database rules (row-level security) so each account can only reach the data it is allowed to see;
• storing your login session in your device's secure keychain;
• storing passwords, backup codes and device identifiers only as one-way hashes;
• two-step login, login alerts and a one-tap "This wasn't me" lockdown;
• removing location data from photos before they're stored;
• removing identifiers from crash reports;
• limiting staff access to what each person needs, and keeping an append-only audit log of administrative actions; and
• rate limits and automated checks to block abuse.

No system is completely secure, so please help protect your account by using a unique password and turning on two-step login.

16. IF SOMETHING GOES WRONG
If a security incident affects personal data, we'll act quickly to contain it and investigate. Where the law requires, we'll report it to the Information Commissioner's Office within 72 hours of becoming aware of it. If an incident is likely to put your rights and freedoms at high risk, we'll tell you without undue delay, explain what happened and what you can do to protect yourself.

17. YOUR RIGHTS
You have the following rights under UK data protection law. Some of them apply only in certain circumstances.

Right to be informed — to be told how we use your data. That's what this policy is for.

Right of access — to get a copy of your personal data. The quickest way is Settings → Export my data. You can also email us.

Right to rectification — to have inaccurate data corrected or incomplete data completed. You can edit most details yourself in Edit profile.

Right to erasure — to have your data deleted. You can delete individual posts at any time, or your whole account in Settings → Delete account. We may need to keep some data where the law requires it, as section 14 explains.

Right to restrict processing — to ask us to limit how we use your data, for example while we check whether it is accurate.

Right to data portability — to receive the data you gave us in a structured, machine-readable format, or have it sent to another organisation where that's technically possible. Settings → Export my data provides this.

Right to object — to object to processing based on legitimate interests. We'll stop unless we have compelling legitimate grounds that override your interests, or we need the data for legal claims. You can always object to direct marketing, and we'll stop.

Rights about automated decisions — to have a person review a significant automated decision, give your view and challenge it, as section 8 explains.

Right to withdraw consent — where we rely on consent (personalised ads and approximate area), you can withdraw it at any time in Settings.

18. HOW TO USE YOUR RIGHTS
Many of your rights can be used directly in the app. For anything else, email support@joinphixr.com from the email address on your account and tell us what you'd like us to do.

We'll respond within one month of receiving your request. If your request is complex, or you've made several, we may extend this by up to two further months; if so, we'll tell you within the first month and explain why. Using your rights is normally free. We may need to confirm your identity before we act, and the time limit starts once we have. We'll make reasonable and proportionate searches for the information you ask for. If we can't do what you've asked, we'll explain why.

A parent or guardian can make a request on behalf of a child, but we'll consider the child's own wishes and best interests, especially where the child is old enough to understand their rights.

19. COMPLAINTS
If you're unhappy with how we've handled your data, please contact us first at support@joinphixr.com. We'll acknowledge your complaint within 30 days and let you know the outcome without undue delay.

You also have the right to complain to the Information Commissioner's Office (ICO), the UK's data protection regulator, at ico.org.uk or on 0303 123 1113. The ICO usually expects you to raise your concern with us first.

20. CHANGES TO THIS POLICY
We'll update this policy when we change how we use personal data, or when the law changes. We'll tell you about material changes in the app, and ask you to review them before you continue using Phixr. The version date is shown at the top.`,
  },
  guidelines: {
    title: 'Community Guidelines',
    updated: TERMS_VERSION,
    body: `Phixr is for sharing what you make and finding what you love. These guidelines keep it a place worth being. They apply to everything on Phixr: posts, stories, comments, messages, profiles, handles, offers, ads and business inbox conversations. They apply to personal and business accounts alike.

Breaking these guidelines also breaks our Terms of Service. Where we say "we remove", we may also hold content for review, mark it as sensitive, limit its reach, apply a strike, restrict features, or suspend or ban the account, depending on how serious the breach is and the account's history.

1. KEEP IT LEGAL
Don't post or share anything that is illegal in the UK, or use Phixr to commit or help with a crime. This includes child sexual abuse material, terrorism content, threats to kill, harassment and stalking, intimate images shared without consent, fraud, the sale of illegal drugs, weapons or stolen goods, and hate crime. Illegal content is removed, and we report it to the authorities where the law requires or where someone is at risk.

2. CHILD SAFETY COMES FIRST
We have zero tolerance for anything that sexualises, exploits or endangers children. This includes sexual or suggestive content involving anyone under 18, sexualised comments about minors, grooming, trying to contact children inappropriately, asking a child for images, and sharing content that shows children being abused. We remove it, ban the account permanently and report it to the authorities.

Be thoughtful when you post images of children, including your own. Don't post images of other people's children without a parent's or guardian's permission, and never share images of children in a state of undress.

3. NUDITY AND SEXUAL CONTENT
Phixr doesn't allow nudity or sexual content. We remove photos and videos that show nudity (including in art or protest), sexual activity, sexually suggestive poses or close-ups, and sexual solicitation, including offering or asking for sexual services.

Breastfeeding, swimwear and medical or health information are fine, as long as no genitals, buttocks or female nipples are shown. Borderline content may be marked as sensitive. Sensitive content is hidden from under-18s entirely and covered for adults until they choose to view it.

Never share intimate images of anyone without their consent, or threaten to. This is a criminal offence. If it has happened to you, report it in the app and contact the Revenge Porn Helpline (revengepornhelpline.org.uk).

4. BULLYING AND HARASSMENT
Don't attack people. We remove bullying, threats, unwanted sexual comments, repeated unwanted contact, encouraging others to pile on, mocking someone's appearance or circumstances, and sharing content designed to humiliate someone.

Public figures can be criticised more than private individuals, but threats and targeted abuse aren't allowed against anyone. Use your tools: block, mute, hidden words, comment limits and message requests all help, and blocking is always invisible to the person you block.

5. HATE
We remove content that attacks, dehumanises or calls for exclusion of people because of their race, ethnicity, nationality, religion or belief, disability, sex, sexual orientation, gender identity, age or serious illness. This includes slurs, harmful stereotypes, hateful symbols, and denying or praising well-documented atrocities.

Criticising ideas, institutions and beliefs is allowed. So is discussing hate in order to condemn it or raise awareness, as long as the purpose is clear.

6. VIOLENT EXTREMISM
We don't allow terrorist or violent extremist organisations or individuals on Phixr, or content that praises, supports, promotes or recruits for them. Content shared to report on or condemn extremism must make that context clear.

7. VIOLENCE AND GRAPHIC CONTENT
Don't threaten or incite violence, glorify violent acts, or share gore for shock value. Don't share instructions for making weapons or carrying out attacks. Graphic content may be allowed where it's newsworthy or documents events in the public interest, but it will usually be marked as sensitive and hidden from under-18s.

8. SUICIDE, SELF-HARM AND EATING DISORDERS
We remove content that encourages, promotes or gives instructions for suicide, self-harm or eating disorders, including "challenges" built around them. Talking about your own experiences, recovery and getting support is allowed, and can help others; we may add a sensitive-content screen or support information.

If you're struggling, you're not alone. You can talk to Samaritans any time on 116 123, or text SHOUT to 85258. If you're under 19, you can call Childline on 0800 1111. If someone is in immediate danger, call 999.

9. DANGEROUS ACTIVITIES AND CHALLENGES
Don't post content that encourages people, especially young people, to do things that could seriously hurt them or others, such as dangerous stunts, challenges, or misuse of drugs or other substances.

10. REGULATED GOODS AND SERVICES
Don't use Phixr to buy, sell or trade illegal drugs, prescription medicines, weapons (including parts and ammunition), explosives, tobacco or vaping products, alcohol, gambling services, animals, human body parts, counterfeit goods, or fake documents. Businesses may promote lawful products and services only in line with the Advertising Policy.

11. BE REAL
Don't impersonate people, brands or organisations, or mislead people about who you are. Parody, fan and commentary accounts are allowed if they make clear they're not the real thing.

Don't fake engagement. That means no bots, swipe farms, comment rings, bought or swapped likes, follows or views, and no coordinated manipulation. Our systems look for it, and fake engagement never counts towards reach, points or earnings.

Don't post, commission or reward fake reviews or misleading endorsements, and always label paid partnerships. Hidden advertising and fake reviews can break consumer protection law.

Running several accounts for different interests is fine. Using extra accounts to get round a restriction or ban is not.

12. SPAM AND SCAMS
Don't post repetitive or unwanted content, send mass unsolicited messages, or use misleading links, clickbait or fake giveaways. Don't run scams, including phishing, fake investment or get-rich-quick schemes, pyramid schemes, romance scams, or asking for money under false pretences. Bio links that lead to blocked domains are removed.

13. HARMFUL FALSE INFORMATION
Don't knowingly share false information intended to cause real harm, such as false health claims that could put people in danger, hoaxes about emergencies, or false information about how to vote. Sharing a false message to cause non-trivial harm can be a criminal offence. We may label, limit or remove misleading content that could cause harm.

14. RESPECT OTHER PEOPLE'S PRIVACY
Don't share someone's private information without their permission. That includes home addresses, phone numbers, email addresses, identity or financial documents, private messages and their exact location. Don't post images or videos of people in private situations (for example, in changing rooms, toilets or their own home) without their consent, and don't film people secretly.

Some things on Phixr are private by design. Don't try to find out who skipped a post, who is in someone's audience groups, or anything else we keep private, and don't try to find someone offline from what they share.

15. RESPECT OTHER PEOPLE'S WORK
Only post content you've made or have permission to use. Our Copyright & Intellectual Property policy explains how to report content that uses your work without permission.

16. BUSINESSES AND CREATORS
If you have a business account, the information you give must be accurate, including your business details, offers and opening hours. Offers must be genuine and available on the terms you describe. Paid partnerships must use the "Paid partnership" label. Ads and boosts must follow the Advertising Policy, and business accounts must follow the Business & Creator Terms.

17. REPORTING, STRIKES AND APPEALS
If you see something that breaks these guidelines, report it using the Report option on the post, comment, profile, message or ad. Reports are confidential: we never tell anyone who reported them.

Reports and automated checks are reviewed by a combination of automated tools and people. Breaking the rules can lead to a strike. Strikes expire after a period, but repeated or serious breaches lead to restrictions, suspension or a permanent ban. Some breaches, such as child sexual exploitation, lead to an immediate permanent ban.

You can appeal any removal, strike or account decision in the app, and appeals are reviewed by a person. Our moderation numbers are published in the transparency report in the app.

18. CONTEXT MATTERS
We look at context when we apply these guidelines. Content that would otherwise break a rule may sometimes be allowed if it's clearly newsworthy, educational, documentary, satirical or artistic, and doesn't put anyone at risk. We may still mark it as sensitive or hide it from under-18s. The nudity rule in section 3 applies whatever the context.

These guidelines will change as Phixr grows. We'll tell you about significant changes in the app.`,
  },
  safety: {
    title: 'Online Safety',
    updated: TERMS_VERSION,
    body: `This statement explains, in plain language, how Phixr keeps people safe and how we meet our duties as a user-to-user service under the Online Safety Act 2023. It covers how we deal with illegal content, how we protect children, how you can report content and complain, and how we're open about what we do.

1. OUR APPROACH
Safety is built into Phixr from the start, not added afterwards. We assess the risk of illegal content and of harm to children on Phixr, keep those assessments under review, and update them before we make significant changes to how Phixr works. We use the results to decide which protections we need. We aim to protect people while respecting their freedom of expression and privacy.

2. PROTECTING UNDER-18 USERS
Phixr is for people aged 13 and over. Accounts for 13 to 17-year-olds get extra protection that is on by default:

• Accounts are private by default.
• Teens are protected from discovery by adults by default.
• Teens are never shown targeted ads, boosts or advertiser content.
• Teens are excluded from all advertiser data, audiences and reports.
• Teens can't add links to their bio.
• Sensitive-content filters are always on for teens and can't be switched off. Content marked as sensitive is hidden from under-18s entirely.
• A daily time reminder is on by default.
• Teens can't tag venues, and we never store anyone's exact location.
• Teens can't turn on a business account, buy boosts or earn money.

3. CHECKING AGE
Everyone must give their date of birth when they sign up. If someone enters a date of birth that makes them under 13, they can't sign up, and a cool-down stops them immediately trying again with a different date. We may ask someone to confirm their age if we have reason to think it is wrong, and we delete accounts that we find belong to someone under 13. Phixr doesn't allow pornography or other content that the Online Safety Act requires to be kept from children using highly effective age checks.

4. ILLEGAL CONTENT
We take proportionate steps to stop people coming across illegal content on Phixr, to reduce the risk of Phixr being used to commit crimes, and to remove illegal content quickly once we know about it.

Uploads are scanned before they can be seen, and anything the systems flag is held for review. Priority illegal content, including child sexual abuse material, terrorism content, threats, fraud, the sale of drugs and weapons, intimate image abuse and hate crime, is removed and escalated on dedicated internal queues.

5. CHILD SEXUAL EXPLOITATION AND ABUSE
Protecting children overrides everything else. If we find child sexual abuse material, we remove it immediately, ban the account permanently, preserve the evidence securely, and report it to the relevant authorities. We never tell the uploader what was detected. Grooming and any attempt to sexually exploit a child are treated in the same way.

If you're worried about a child, you can also report to the police's Child Exploitation and Online Protection command (CEOP) at ceop.police.uk. You can report child sexual abuse images found anywhere online to the Internet Watch Foundation at iwf.org.uk.

6. HOW WE FIND HARMFUL CONTENT
As well as acting on reports, we run automated scanning on photos and videos when they're uploaded, and text checks on captions, comments, offers and scheduled posts before they're published. Scheduled content is checked again when it publishes, so nothing gets round review. We also use link blocklists, hidden-word filters, comment limits, and systems that detect fake engagement, bots and people trying to get round bans.

Automated tools aren't perfect. They may block, hold or label content, and people review flagged content and appeals. Serious account actions, such as permanent bans, are checked by a person.

7. REPORTING CONTENT
You can report anything on Phixr in two taps, including posts, stories, comments, profiles, messages and ads. You don't need to be the person affected. Reports are confidential: we never tell anyone who reported them. You can also report content to us by emailing support@joinphixr.com, including if you don't have a Phixr account.

When you report, choose the reason that fits best. Reports go into a prioritised review queue, and the most serious harms, such as risks to children or threats to someone's life, are handled first.

8. WHAT HAPPENS AFTER A REPORT
We review the content against our Community Guidelines and the law. Depending on what we find and the account's history, we may remove content, mark it as sensitive, limit its reach, apply a strike, restrict features, suspend an account, or ban it permanently. Where we can, we'll tell you the outcome of your report.

If we take action against your content or account, we'll usually tell you what we did, which rule it broke, and how to appeal, unless telling you would put someone at risk, interfere with an investigation or break the law.

9. COMPLAINTS AND APPEALS
You can complain to us if you think: content on Phixr is illegal or harmful to children; we didn't deal with a report properly; we took action against your content or account unfairly (including because of a wrong decision about your age); or we're not meeting our duties under the Online Safety Act. You can appeal moderation decisions in the app, and appeals are reviewed by a person. If we decide we got it wrong, we'll restore your content or account and remove any strike.

Our Complaints & Appeals document explains how to complain, how long it takes, and what you can do if you're not happy with our response.

10. FREEDOM OF EXPRESSION AND PRIVACY
We want people to be able to express themselves on Phixr. When we write rules and make moderation decisions, we consider people's right to freedom of expression and their privacy, and we take context into account, such as whether content is news, educational, artistic or satirical. Our Privacy Policy explains how we protect personal data while keeping Phixr safe.

11. TOOLS YOU CONTROL
• Block: stop someone seeing or contacting you. Blocking is always invisible to the person you block.
• Mute: stop seeing someone's posts without unfollowing them.
• Report: tell us about anything that breaks the rules.
• Hidden words: automatically hide comments and messages containing words you choose.
• Comment limits: choose who can comment on your posts.
• Message requests: messages from people you don't follow arrive as requests.
• Private account and audience groups: choose who sees your posts.
• "Not interested": see less of something in your feed.
• Quiet mode and time reminders: take a break when you need one.

12. KEEPING YOUR ACCOUNT SECURE
In Settings → Security & two-step login you can turn on two-step login, get backup codes, and see your devices and sessions. Login alerts tell you about new sign-ins. If one wasn't you, tap "This wasn't me" to sign out everywhere and reset your password.

13. TRANSPARENCY
We publish moderation statistics in the transparency report in the app, and update it regularly. It shows how many reports we received, what action we took, how quickly we responded and the outcomes of appeals. We'll also give Ofcom any information it requests under the Online Safety Act.

14. WORKING WITH THE POLICE AND REGULATORS
We cooperate with law enforcement and regulators where the law requires, and where someone's life or safety is at risk. We check that requests for user data are lawful and proportionate before we respond. We preserve evidence of serious crimes, such as child sexual abuse material, even if the account is deleted.

15. IF YOU NEED HELP NOW
If someone is in immediate danger, call 999 before you report in the app. For non-emergencies you can contact the police on 101.

• Samaritans: call 116 123, any time, for free.
• Shout: text SHOUT to 85258 for free, confidential text support.
• Childline (under 19): call 0800 1111 or visit childline.org.uk.
• CEOP (worried about a child online): ceop.police.uk.
• Report Harmful Content: reportharmfulcontent.com.
• Revenge Porn Helpline: revengepornhelpline.org.uk.

16. CONTACT
For safety concerns about specific content or accounts, please use in-app reporting first, as it's the fastest way to reach the review team. For anything else, including questions about this statement, email support@joinphixr.com.`,
  },
  complaints: {
    title: 'Complaints & Appeals',
    updated: TERMS_VERSION,
    body: `We want to hear when something has gone wrong, so we can put it right. This document explains how to complain about content, a moderation decision, the service or a purchase, how long we take to respond, and what you can do if you're not happy with our answer. It forms part of our Terms of Service and also sets out our complaints procedure under the Online Safety Act 2023.

1. WHO CAN COMPLAIN
Anyone can complain, including people who don't have a Phixr account, parents and carers, and people who are affected by content on Phixr. You can also complain on someone else's behalf if they've asked you to, or if they are a child you're responsible for.

2. COMPLAINTS ABOUT CONTENT
If you think content on Phixr is illegal, harmful, or breaks our Community Guidelines, report it using the Report option on the post, story, comment, profile, message or ad. This is the fastest route to our review team. If you can't use the app, email support@joinphixr.com with a link to or description of the content and why you're concerned.

If you've already reported something and think we didn't deal with it properly, email us with the details and we'll look at it again.

3. APPEALING A MODERATION DECISION
If we've removed or restricted your content, marked it as sensitive, applied a strike, restricted your account, or suspended or banned it, you can appeal. Open the notification about the decision and tap Appeal, or email support@joinphixr.com if you can't access the app.

Tell us why you think the decision was wrong and include anything that helps, such as context we might have missed. Appeals are always reviewed by a person, who wasn't involved in the original decision where possible. If we find we got it wrong, we'll restore your content or account, remove any strike, and reverse any effect on your reach or points.

You can also appeal if we've restricted your account because we think you're under 13 or under 18 and you believe that's wrong.

4. COMPLAINTS ABOUT THE SERVICE OR A PURCHASE
If you have a complaint about how Phixr works, how we've treated you, or something you've paid for, email support@joinphixr.com. Please include your handle, what happened, when it happened, and what you'd like us to do. For purchases, include the date and what you bought.

Boosts bought on iPhone are processed by Apple, so refunds are requested through Apple at reportaproblem.apple.com. Purchases through Google Play are refunded through Google Play. If you have trouble, contact us and we'll help. Complaints about advertising charges or payouts should come to us by email.

5. COMPLAINTS ABOUT YOUR PERSONAL DATA
If you're unhappy with how we've used your personal data or handled a request about your rights, email support@joinphixr.com with "Privacy" in the subject line. We'll acknowledge your complaint within 30 days and tell you the outcome without undue delay. Our Privacy Policy explains your rights.

6. OUR TIMESCALES
We aim to meet these timescales. We'll tell you if we need longer, and why.

In-app reports — reports of the most serious harms, such as risks to children, threats to life and child sexual abuse material, are prioritised and acted on as quickly as possible. Other reports are reviewed in priority order, and we'll tell you the outcome where we can.

Appeals — we aim to decide appeals within 7 days.

Emailed complaints — we aim to acknowledge complaints within 5 working days and to give you a full response within 28 days.

Data protection requests — we respond to requests to use your data rights within one month, as the Privacy Policy explains.

7. IF YOU'RE NOT HAPPY WITH OUR RESPONSE
If you're not satisfied with our response, reply to it and ask for your complaint to be reviewed again. A different person will look at it and give you our final response, normally within 28 days.

8. ALTERNATIVE DISPUTE RESOLUTION
Alternative dispute resolution (ADR) is a way of resolving disputes through an independent body without going to court. We don't currently offer an ADR scheme, and we are not obliged to use one. If we can't resolve your complaint, you can use the options below.

9. THE INFORMATION COMMISSIONER'S OFFICE
If your complaint is about personal data, you can complain to the Information Commissioner's Office (ICO), the UK's data protection regulator, at ico.org.uk or on 0303 123 1113. The ICO usually expects you to have raised your concern with us first.

10. OFCOM AND THE ONLINE SAFETY ACT
Ofcom is the UK's online safety regulator. It makes sure services like Phixr meet their duties under the Online Safety Act 2023, including having effective reporting and complaints procedures. Ofcom doesn't resolve individual complaints about content or moderation decisions, but you can tell Ofcom if you think we aren't meeting our duties, at ofcom.org.uk. Ofcom uses this information to decide whether to take action.

11. ADVERTISING COMPLAINTS
If you think an ad on Phixr is misleading, harmful or offensive, report it in the app. You can also complain to the Advertising Standards Authority (ASA) at asa.org.uk, which regulates advertising in the UK, including paid partnerships.

12. CONSUMER ADVICE AND THE COURTS
For independent advice about your rights as a consumer, contact Citizens Advice (citizensadvice.org.uk). You can also take your claim to court. For smaller claims, there are simplified procedures: the small claims track in England and Wales (you can start a claim online through Money Claim Online), simple procedure in Scotland, and the small claims process in Northern Ireland. Our Terms of Service explain which courts can hear a claim.

13. HOW WE USE COMPLAINTS
We keep records of complaints and appeals and use them to improve our rules, systems and decisions. Information about appeals and their outcomes is included in our transparency report in the app. We don't hold it against you for complaining.

14. CONTACT
In-app: use Report on any content, or Appeal from a moderation notification. Email: support@joinphixr.com.`,
  },
  ads: {
    title: 'Advertising Policy',
    updated: TERMS_VERSION,
    body: `This policy covers ads, boosts and paid partnerships on Phixr. It forms part of our Terms of Service and, for business accounts, sits alongside the Business & Creator Terms. All advertising on Phixr must also follow UK law and the UK Code of Non-broadcast Advertising and Direct & Promotional Marketing (the CAP Code), which is enforced by the Advertising Standards Authority (ASA).

1. WHO CAN ADVERTISE
Only business accounts can advertise, boost posts or take part in paid partnerships, and you must be 18 or over to have a business account. Advertising is managed through our ads manager on the web. Advertisers are responsible for making sure their ads are legal, decent, honest and truthful, and for holding evidence to support any claims they make.

2. TYPES OF ADVERTISING
Ads — sponsored posts shown as cards in the deck and, where available, as sponsored results in search, created and paid for in the ads manager.

Boosts — paying to show one of your own posts to more people, for the duration or amount shown when you buy.

Paid partnerships — posts by creators who are paid, gifted or otherwise rewarded by a brand to post about it.

3. HOW ADS APPEAR ON PHIXR
Every ad and boosted post is clearly labelled, so people can tell it apart from ordinary posts. Every ad has a "Why am I seeing this?" option that gives an honest explanation of why it was shown. The number of ads anyone sees is limited. You can hide any ad, and it disappears straight away.

4. WHAT CAN'T BE ADVERTISED
We don't allow ads for:

• illegal products or services;
• weapons, ammunition, explosives or fireworks;
• drugs or drug paraphernalia, including CBD products with claims that break the rules;
• prescription-only medicines;
• tobacco, vaping or nicotine products;
• gambling, including lotteries and prize draws that need a licence;
• alcohol;
• dating, escort or adult services, and sexual products;
• cosmetic procedures aimed at under-18s;
• payday loans, or crypto-asset or financial promotions that break Financial Conduct Authority rules;
• political advertising, including ads about elections, referendums or political parties;
• miracle health, diet or weight-loss claims;
• counterfeit goods or goods that infringe someone's rights;
• get-rich-quick schemes, pyramid schemes or other misleading business opportunities; and
• spyware or tools for monitoring people without their knowledge.

We may refuse or remove any ad that we think isn't right for Phixr, even if it isn't on this list.

5. WHAT ADS MUST NOT DO
Ads must not mislead, including about price, availability or the advertiser's identity. They must not be shocking or offensive, use fake buttons or other tricks to get clicks, or pressure people with false urgency. They must not exploit people's insecurities about their body, or promote an unhealthy body image. They must not target or appeal particularly to under-18s for products that are age-restricted. Ads must link to a working destination that matches the ad.

6. REVIEW OF ADS
Ads and boosted posts go through the same automated safety checks as all posts, and may be reviewed by a person before or after they run. We may stop an ad at any time if it breaks this policy or if people report it. Approval doesn't mean an ad complies with the law; that remains the advertiser's responsibility.

7. TARGETING AND PRIVACY
Personalised ads are only shown to adults who have consented. Anyone can change their choice at any time in Settings → Personalised ads. Targeting can use age group, coarse area and interests, never exact location. "Engaged" audiences (people who have liked the advertiser's posts) and "similar" audiences are matched on our servers at the moment an ad is shown. Advertisers never receive lists of people or any individual-level data.

Under-18s never receive targeted ads or boosted posts, and never appear in advertiser data or audiences. Advertiser reports only ever show anonymous totals about adults, and never any figure based on fewer than 50 people.

Brand-safety controls let advertisers keep their ads away from sensitive content.

8. BOOSTS
A boost shows one of your own posts to more people for the duration or amount shown when you buy it, and is always labelled. Boosts never reach under-18s. A boost doesn't guarantee any particular number of views, likes, follows or sales. Boosts are paid for with points or, where offered, bought as an in-app purchase through Apple or Google Play, in which case their terms and refund processes apply. Boosts are available to business accounts only. Boost reports follow the same privacy rules as ad reports. Your right to cancel a boost is explained in our Terms of Service.

9. PAID PARTNERSHIPS
If you're paid, gifted a product, given a discount or otherwise rewarded to post about a brand, or if you have a commercial relationship with it, your post is advertising. You must use the in-app "Paid partnership" label so people can tell straight away. We also recommend putting "#ad" at the start of your caption. The brand can approve the label so its name appears. The Business & Creator Terms explain your duties in more detail.

Hidden advertising breaks the CAP Code and consumer protection law, and leads to moderation action on Phixr.

10. BILLING
Advertising is paid for from your ad-account balance, which you top up by card on the web through our payment provider, Stripe, once card billing is switched on. Top-ups are never taken inside the iPhone app. Charges build up as your ads are delivered, as shown in the ads manager, and the reports and activity log show every charge. Prices and any VAT are shown before you pay.

Balances can't be transferred to another account and don't earn interest. If you close your ad account or business account, unused balance is refundable, less any amounts you owe us. If we remove an ad because it breaks this policy, charges for delivery already made still apply.

11. REPORTING AN AD
Anyone can report any ad in two taps from the ad itself. Ads that break this policy are removed, and advertisers who repeatedly or seriously break it lose access to advertising. You can also complain to the ASA at asa.org.uk.

12. CHANGES
We may update this policy, for example to reflect changes in law or new ad features. We'll tell advertisers about significant changes before they take effect, through the ads manager or by email.`,
  },
  business: {
    title: 'Business & Creator Terms',
    updated: TERMS_VERSION,
    body: `These terms apply if you turn on a business account on Phixr. They add to our Terms of Service, Community Guidelines and Advertising Policy, which still apply. If these terms and the Terms of Service say different things about business features, these terms apply.

When you use a business account, you're using Phixr for the purposes of your trade, business, craft or profession. That means you're a business user under our Terms of Service. Some consumer protections don't apply to business use, and the business indemnity in the Terms of Service does.

1. WHO CAN HAVE A BUSINESS ACCOUNT
You must be at least 18 to turn on a business account. Business accounts are for creators, sole traders, companies, venues, charities and other organisations. If you turn one on for an organisation, you confirm you have its authority, and the organisation is bound by these terms too.

The details you give us must be true and kept up to date. We may ask you to confirm your identity, age or business details, or your right to manage a venue you claim, before you can use some features.

2. TURNING ON A BUSINESS ACCOUNT
You can turn on a business account in Settings → Business account. It unlocks:

• drafts and scheduled posts;
• analytics and insights;
• boosting and promoting posts;
• paid-partnership labels;
• creator earnings and payouts, where available;
• advertising through our ads manager on the web;
• team members with roles;
• a business inbox;
• offers and opening hours; and
• A/B tests.

Personal accounts can't use these tools. Only business accounts can earn money or promote content on Phixr.

3. SWITCHING BACK TO A PERSONAL ACCOUNT
You can switch back to a personal account at any time. When you do, you lose access to business tools, and team members lose access to your account. Your posts stay published.

Before you switch, we recommend that you finish or stop any boosts or campaigns, and check any scheduled posts. Earnings that have already been confirmed remain yours and will be paid out under section 9. Unused advertising balance stays refundable, as the Advertising Policy explains.

4. DATA YOU CAN SEE
Analytics and insights show anonymous totals, such as reach, likes, skips, saves and shares. You'll never see who skipped a post. You can see who liked your posts, except people who have chosen to hide their likes.

Advertiser and boost reports only ever show anonymous totals about adults, and never any figure based on fewer than 50 people. Under-18s are never included in advertiser data or targeting. You'll never see who is in anyone's audience groups, or anyone's exact location.

You must not try to identify individuals from aggregate data, combine Phixr data with other data to do so, or use any data from Phixr to contact people outside Phixr without their permission.

5. DRAFTS, SCHEDULING AND TESTS
You can save drafts and schedule posts to publish later. Scheduled posts are checked when you schedule them and again when they publish, and may be held or blocked if they break our rules.

A/B tests let you compare different versions of a post. Results are shown as anonymous totals. Everyone who sees a version of the post sees a normal post, labelled in the same way as any other.

6. BOOSTS AND PROMOTION
Boosts and ads are covered by the Advertising Policy. Boosts can be paid for with points or, where offered, bought as an in-app purchase through Apple or Google Play. Ads are paid for from your ad-account balance in the ads manager on the web. Boosts and ads never reach under-18s.

7. THE ADS MANAGER
The ads manager is a website where you can create and manage ads, top up your balance, and see reports. You must keep your login details secure. Everything done in the ads manager under your account or by your team is your responsibility. Ads must follow the Advertising Policy.

8. CREATOR EARNINGS
Creator earnings are being introduced gradually and may not be available to everyone, or in every place, straight away. Before you opt in to earnings, the app will show you how earnings build up, the rates that apply, any minimum before you can be paid, how and when payouts are made, and any fees. That information forms part of these terms. We'll give you reasonable notice before we change it, unless the change is needed for legal or safety reasons.

Earnings are based only on genuine activity. Engagement from bots, swipe farms, comment rings, self-engagement or other manipulation doesn't count. Earnings shown in the app are estimates until they are confirmed. We may withhold, adjust or reverse earnings that came from manipulation, fraud, content that breaks our rules, or a mistake, and we'll explain why. You can appeal these decisions in the same way as moderation decisions.

Earnings are not wages. Having a business account or earning on Phixr doesn't make you our employee, worker, agent or partner.

9. PAYOUTS
Payouts will be made through our payment provider, Stripe, once payouts are switched on. To receive payouts, you'll need to set up an account with the payment provider, accept its terms, pass its identity and verification checks, and give it details of a bank account in your name or your business's name. We never see your full bank details.

We may delay a payout while we investigate suspected fraud, manipulation or a serious breach of our rules, or where the law requires. If we end your account because of fraud or a serious breach, we may withhold earnings connected with it, to the extent the law allows. Otherwise, confirmed earnings remain payable after your account ends.

10. TAX
You're responsible for your own tax affairs, including declaring your Phixr earnings and paying any tax and National Insurance due. If you're an individual, income from Phixr is usually treated as self-employed income, and you may need to register with HMRC for Self Assessment. HMRC's guidance on gov.uk explains when you need to register and what allowances may apply. If you're registered for VAT, you're responsible for any VAT on your earnings.

We or our payment provider may need to collect tax information from you, and to report information about your earnings to HMRC where the law requires (for example, under the rules for digital platforms). If we're required by law to deduct anything from a payout, we'll tell you.

11. PAID PARTNERSHIPS AND DISCLOSURE
If you're paid, gifted a product, given a discount, or otherwise rewarded by a brand to post about it, or you have any commercial relationship with it, your post is advertising. You must:

• use the in-app "Paid partnership" label on the post;
• make it clear upfront that the post is an ad, for example by starting your caption with "#ad";
• not make claims about a product that you or the brand can't back up; and
• follow the CAP Code, the ASA's influencer guidance and the Competition and Markets Authority's guidance on hidden advertising.

Brands are also responsible for making sure partnerships are disclosed. If a brand asks you not to disclose a partnership, don't agree to it. Hidden advertising breaks the CAP Code and consumer protection law, including the Digital Markets, Competition and Consumers Act 2024, and leads to action on Phixr.

12. TEAMS AND ROLES
You can invite team members to help run your business account and give each of them a role that limits what they can do. Team members use their own Phixr logins, and must only be people aged 18 or over. Everything they do for your business is recorded in a log that the account owner can see.

The account owner is responsible for the team: for choosing who to invite and what role to give them, for everything team members do on the business account, and for removing access promptly when someone leaves or no longer needs it. Don't share your own login with team members; invite them instead.

13. THE BUSINESS INBOX
The business inbox brings together messages to your business. Messages to your business may be seen by team members with the right role. You must:

• reply honestly and not mislead customers;
• not send spam or unsolicited marketing, and follow the rules on electronic marketing (PECR);
• handle any personal data you receive lawfully. For data you take outside Phixr, you are the controller under UK data protection law and must have your own privacy information; and
• not ask people for passwords, payment card details or other sensitive information through the inbox.

Auto-replies must be accurate and must not pretend to be a person if they aren't.

14. OFFERS, OPENING HOURS AND VENUES
Offers, opening hours and venue details must be accurate and kept up to date. Offers must be genuine, available on the terms you describe, and clear about any conditions, such as end dates, limits or exclusions. Prices must include any compulsory charges. You must honour offers you publish on Phixr, unless they've clearly ended or sold out.

You may only claim a venue you're authorised to manage. Offers are checked before they publish, and we may remove offers or venue claims that are misleading or unauthorised.

15. TREATING CUSTOMERS FAIRLY
You're responsible for your products, services and dealings with customers, and for complying with consumer protection law. That includes the Consumer Rights Act 2015 and the Digital Markets, Competition and Consumers Act 2024, which bans misleading and aggressive practices, fake reviews, and hiding compulsory charges. Phixr isn't a party to any sale between you and your customers.

16. ACCOUNT REVIEW AND SUSPENSION OF BUSINESS FEATURES
We may review business accounts, for example to confirm identity, age or business details, to check venue claims, or because of reports or unusual activity. While we review, or if you break these terms, the Advertising Policy or the law, we may suspend some or all business features (such as advertising, boosts, earnings or payouts) without affecting your personal features, or restrict the whole account. We'll tell you what we've done and why, unless the law or safety reasons prevent it, and you can appeal in the app.

17. YOUR RESPONSIBILITY
You're responsible for your business content, ads, offers, partnerships and team, and for complying with the law that applies to your business. The business indemnity and the limits on our responsibility for business users in our Terms of Service apply to your use of business features.

18. CHANGES AND ENDING
We may change business features and these terms. We'll give you reasonable notice of significant changes, unless they're needed for legal or safety reasons. You can stop using business features at any time by switching back to a personal account, or delete your account in Settings. Sections that by their nature should continue (such as those about payouts of confirmed earnings and tax) continue after your business account ends.

Questions about business accounts: support@joinphixr.com.`,
  },
  copyright: {
    title: 'Copyright & Intellectual Property',
    updated: TERMS_VERSION,
    body: `Phixr is built on people sharing their own work. This policy explains how we respect intellectual property, how to report content that infringes your rights, how to respond if your content is removed, and how we deal with repeat infringement, trade marks and impersonation. It forms part of our Terms of Service.

1. RESPECTING OTHER PEOPLE'S WORK
Only post content you've created yourself or have permission to use. Just because something is online doesn't mean you can repost it. Giving credit, or saying "no copyright intended", doesn't make it allowed.

UK law allows some limited uses of other people's work without permission, known as fair dealing. These include criticism, review and quotation, reporting current events, and caricature, parody or pastiche. Whether a use is fair depends on the circumstances. If you're not sure, ask the owner for permission or get advice.

2. YOUR CONTENT
Your content is yours. The licence you give us to show it on Phixr is explained in our Terms of Service. We don't claim ownership of your content.

3. REPORTING COPYRIGHT INFRINGEMENT
If you think content on Phixr infringes your copyright, or the copyright of someone you're authorised to act for, you can flag it in the app: open the post's Report menu and choose "Uses my work without permission", and the app will offer to start the email for you. To make a complete copyright report, email support@joinphixr.com with "Copyright report" in the subject line and include:

• your full name and contact details (email address, and phone number if you're happy to give it);
• if you're acting for someone else, who they are and your relationship to them;
• a description of the work you believe has been infringed, and where we can see the original if it's online;
• the handle of the account and a link to or description of each item you're reporting, so we can find it;
• a statement that you believe in good faith that the use isn't authorised by the owner, its agent or the law;
• a statement that the information in your report is accurate, and that you're the owner or authorised to act for the owner; and
• your full name as your signature.

We may not be able to act on a report that is incomplete. We'll review your report and, if it's valid, remove or disable access to the content promptly.

We'll usually tell the person who posted the content that we removed it because of a copyright report, and give them your name and the details of your report so they can respond or contact you. If you'd rather we didn't share your contact details, tell us, and we'll explain whether we can still act.

4. IF YOUR CONTENT WAS REMOVED
If we removed your content because of a copyright report and you believe that was a mistake (for example, because you own the work, have a licence, or your use is fair dealing), you can send us a counter-notice. Appeal in the app, or email support@joinphixr.com with "Copyright counter-notice" in the subject line. Please include:

• your full name, handle and contact details;
• a description of the content that was removed;
• why you believe the removal was a mistake;
• a statement that the information in your counter-notice is accurate and given in good faith;
• your agreement that we may share your counter-notice, including your name and contact details, with the person who made the report; and
• your full name as your signature.

We'll consider your counter-notice and may share it with the person who reported the content. We may restore the content if we're satisfied the report was mistaken, or if the person who reported it doesn't take further action. We can't settle legal disputes between you; if you can't agree, you may need to take advice or go to court.

5. REPEAT INFRINGEMENT
We take action against accounts that repeatedly infringe other people's intellectual property. Each valid report may lead to a strike. Accounts that repeatedly infringe will lose features and, in appropriate circumstances, be permanently banned. Strikes removed on a successful counter-notice or appeal don't count.

6. TRADE MARKS
Don't use someone else's trade mark (such as a brand name or logo) in a way that's likely to confuse people about who is behind an account, post, offer or ad, or suggests a connection or endorsement that doesn't exist. To report trade mark infringement, flag the content or account in the app (choose "Misuses my brand or trade mark") and email support@joinphixr.com with "Trade mark report" in the subject line. Include the same information as for a copyright report, plus the trade mark, where it's registered and the registration number.

7. IMPERSONATION
Don't pretend to be someone else, whether a person, brand or organisation. Parody, fan and commentary accounts are allowed if they make clear they're not the real thing, for example in the name and bio.

If someone is impersonating you or your business, report the profile in the app (choose "Pretending to be me or someone else"), or email us. If you don't have a Phixr account, email support@joinphixr.com with a link to the profile. We may ask you to prove your identity or that you represent the business. Accounts that impersonate others are removed, and we may reclaim handles that impersonate people or brands.

8. FALSE OR ABUSIVE REPORTS
Only report content you genuinely believe infringes your rights. Making reports you know are false, or using reports to silence legitimate criticism or competition, breaks our terms and may lead to action against your account. It may also make you legally responsible for the harm caused.

9. OUR OWN RIGHTS
The Phixr name, logo, app and website are protected by intellectual property laws. Please don't use them without our permission, except to refer to Phixr accurately.

10. CONTACT
Intellectual property reports, counter-notices and questions: support@joinphixr.com. Our address for the service of legal documents is available on request from the same email address.`,
  },
  beta: {
    title: 'Beta Testing (TestFlight)',
    updated: TERMS_VERSION,
    body: `Thanks for helping us test Phixr. These terms apply while you use a pre-release (beta) version of Phixr, including through Apple's TestFlight. They add to our Terms of Service and other documents, which still apply in full. If these terms and the Terms of Service say different things about a beta version, these terms apply.

1. TAKING PART
Beta testing is by invitation. You must meet the same eligibility rules as for Phixr in general, including being at least 13. You can stop testing at any time by deleting the beta app, and we can end your participation, or the beta, at any time.

2. PRE-RELEASE SOFTWARE
Beta versions are unfinished. They may contain bugs, may crash, and may not always work as expected. Features may change, appear or disappear without notice, and some may never be released. Please don't rely on a beta version for anything important, and keep your own copies of photos and videos you care about.

Beta builds from TestFlight stop working after a period set by Apple, and you may need to install a newer build to keep testing.

3. YOUR DATA MAY BE RESET
While Phixr is in beta, we may need to reset some or all data, including accounts, posts, stories, comments, messages, points, followers and settings, for example to fix a problem or prepare for public launch. We'll try to warn testers before a planned reset, but this may not always be possible. You can download a copy of your data at any time in Settings → Export my data.

Any data we hold during the beta is still protected under our Privacy Policy, and your data rights apply in the same way.

4. INFORMATION FROM TESTFLIGHT
TestFlight is run by Apple. When you test through TestFlight, Apple shares some information with us under Apple's terms, such as the name and email address you were invited with, your device model and operating system version, crash reports, usage information, and any feedback or screenshots you send through TestFlight. We use this to run the beta and improve Phixr, as our Privacy Policy explains.

5. PURCHASES DURING THE BETA
Purchases made in a TestFlight build use Apple's test environment, and you're not charged. Anything bought in a beta build, such as a test boost, may be removed or reset and has no value.

6. FEEDBACK
We'd love to hear what you think. You can send feedback through the in-app report button, through TestFlight, or by email to support@joinphixr.com. Please don't include other people's personal information in feedback unless it's needed to explain a problem.

When you send us feedback, ideas or suggestions, you give us permission to use them freely, for any purpose, without paying you or owing you anything. You don't have to send feedback, and you keep ownership of any content you post on Phixr as usual.

7. NO CONFIDENTIALITY REQUIRED
You don't have to keep the beta secret. You're welcome to talk about Phixr, share your opinions and post about your experience. Please remember that features you see may change before launch, and respect other testers' privacy: don't share screenshots of other people's private profiles, messages or personal information without their permission.

8. THE FULL TERMS STILL APPLY
The Terms of Service, Privacy Policy, Community Guidelines and all our other documents apply to beta versions just as they do to the public app. That includes the rules on content and behaviour, our moderation and reporting processes, and your right to appeal. Nothing in these beta terms affects your legal rights as a consumer.

9. WHEN THE BETA ENDS
When Phixr launches publicly, we'll ask you to install the public version. Unless we tell you otherwise, your account will carry on, subject to any reset described in section 3.

10. CONTACT
Questions about the beta: support@joinphixr.com.`,
  },
};

/** Display order and one-line descriptions for the Legal index screen and public site. */
export const LEGAL_DOC_LIST: { id: LegalDocId; summary: string }[] = [
  { id: 'terms', summary: 'The agreement between you and Phixr.' },
  { id: 'privacy', summary: 'What data we collect, why, and your rights.' },
  { id: 'guidelines', summary: 'What is and isn’t allowed on Phixr.' },
  { id: 'safety', summary: 'How we keep people safe, especially under-18s.' },
  { id: 'complaints', summary: 'How to complain or appeal a decision.' },
  { id: 'ads', summary: 'Rules for ads, boosts and paid partnerships.' },
  { id: 'business', summary: 'Extra terms for business accounts and creators.' },
  { id: 'copyright', summary: 'Reporting infringement and impersonation.' },
  { id: 'beta', summary: 'Extra terms for testing pre-release versions.' },
];
