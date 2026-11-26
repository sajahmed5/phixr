# Getting Phixr into Metricool (and other post schedulers)

*Recommendation, 26 Nov 2026. Nothing has been built. This is a plan for Saj to approve.*

## The short answer

**We can't add Phixr to Metricool ourselves, and right now no scheduler would add us.**
Metricool, Buffer, Hootsuite, Later, Sprout Social, Planoly, SocialBee, Publer and Zoho
Social do not have a "submit your network" form. Each one builds a new network itself, and only when
two things are true:

1. **Lots of their customers ask for it.** Buffer added Threads after more than 7,000
   requests. Metricool says it added Bluesky because customers asked for it so often.
2. **The network has a public posting interface** (an "API") with a standard secure sign-in
   for outside apps (OAuth). Each scheduler builds its own connection to that interface.

Phixr has neither of these yet. It's in beta, so customer demand is near zero, and it has no
public API. A big scheduler adding Phixr is realistically **12 months or more away**, and they
might never do it. **We can get HG Care and Yellowloaf posting to Phixr from their existing workflow
within weeks.** We do it by building a door into Phixr ourselves and plugging it into the
automation tools that Metricool already talks to.

## What we recommend, in order

| # | What | Who it helps | Rough effort | When it's usable |
|---|------|--------------|--------------|------------------|
| 0 | **Use Phixr's own scheduler** for HG Care and Yellowloaf. It's already built: drafts, scheduling up to 90 days ahead, team editors | Our two companies, today | None | Now |
| 1 | **Phixr Publishing API, private beta.** Business accounts get a key that lets an outside tool create drafts and scheduled posts | Us, then other businesses | ~2–3 weeks | ~1 month |
| 2 | **Phixr app on Zapier, invite-only first.** Lets you set up "When Metricool publishes a post, post the same to Phixr" | HG Care, Yellowloaf, any Metricool/Buffer/Hootsuite user | ~1 week after #1 | ~5–6 weeks. Public listing needs Zapier's review (~1 week, then a 90-day "beta" badge) |
| 3 | **Proper "Connect to Phixr" sign-in (OAuth)** in place of copy-and-paste keys | Every outside tool. Schedulers expect it | ~1–2 weeks | ~2–3 months |
| 4 | **Make (and n8n) apps** | Agencies that use Make rather than Zapier | ~1 week each | Make's QA team reviews it first |
| 5 | **Approach the schedulers** (see below), starting with the open-source one we can add ourselves | Everyone | Your time, plus ~1–2 weeks for Postiz | Months, and up to them |

**Don't do RSS or email-to-post.** Schedulers use RSS the other way round: they read a blog's
feed and post it *to* Instagram and the others, so RSS gives us nothing. Email-to-post suits text
better than photos and video. It's also a spam risk, and it duplicates what the Zapier route already does better.

### Why Zapier is the fast route

Metricool already has a Zapier app with a **"New Published Post"** trigger. Once Phixr has its
own Zapier app, HG Care can set up a "Zap" (Zapier's name for an automation) with no code:

> When Metricool publishes a post → upload its photo or video to Phixr → schedule it on the
> HG Care Phixr account.

Buffer, Hootsuite, Publer and SocialBee all have Zapier apps too, so the same idea works for
any business that uses them. **To check before we build:**
- which Metricool plan includes Zapier. The API needs the Advanced or Custom plan
- whether the trigger gives the media file link (photo or video), not just the post text

Zapier lets an invite-only app work straight away, so our two companies don't have to wait for
Zapier's review.

## What the Publishing API would need

Most of the hard parts already exist. The API would be a new front door into machinery we've
already built and tested:

- **Business accounts only.** Scheduling already checks for a business account on the server
  (`_require_business` in `schedule_draft`). The API uses the same check, so personal and under-18
  accounts can't use it.
- **Same drafts and scheduler.** Posts from the API become rows in `post_drafts` and go through
  `schedule_draft`. The existing limits still apply: 90 days ahead, 100 scheduled posts, retries.
  The every-minute publisher puts them live.
- **Same moderation, no shortcuts.** Media goes through the `media-pipeline` function:
  location data removed, adult-content scan, CSAM check, then copied to R2. Captions are checked
  when a post is scheduled, and anything flagged is held for review. *New work:* the pipeline only
  takes a direct upload from the app today. Tools like Metricool and Buffer pass a **link** to the
  media, so we need a safe "fetch from link" option with size and type limits.
- **Separate keys, not the app login.** Each business gets its own keys or OAuth tokens, kept
  apart from phone logins. They can be limited (for example "create posts" but not "read
  messages"), and a business can see and cancel them under Settings → Connected apps.
  Supabase now offers an OAuth server, still in beta. We could use it for #3 or build a simple
  version ourselves.
- **Teams.** Only the owner or an admin (`app/business/team.tsx` roles) can connect an app. Posts
  appear as the business, the same way editors' scheduled posts do now.
- **Posting only, at first.** No liking, following, commenting or messaging through the API.
  This keeps bots out and matches our fake-engagement rules.
- **Rate limits.** Reuse the upload limit (20 an hour per account today) and the
  scheduled-post cap, plus a per-key request limit.
- **Activity log.** Record every action an outside app takes: which app, which business, what it
  did. This is similar to the existing ads activity log.
- **Developer docs page** on joinphixr.com. It explains how to get a key, upload media and schedule a
  post. Schedulers and Zapier both ask for this.

## Legal and terms changes

- **Terms of Service, section 11 (Acceptable use)** bans automated access "unless we have
  agreed in writing". We need **API / Developer Terms** that count as that agreement, and
  section 11 should mention them.
- **Business & Creator Terms:** add a short "Connected apps" section. It should say that the
  business is responsible for anything posted through tools it connects, including the content
  rules and paid-partnership labels. We can cut off any app, and the existing business
  indemnity covers it.
- **Privacy Policy:** explain that a business can connect outside tools, what we share with
  them (only what the business allows), and how to disconnect. When a business connects
  Zapier or Metricool, those tools work for the business; they aren't our suppliers.
- **Zapier and Make** each have their own platform agreement that Phixr (the company) must accept.

## What Saj needs to do

1. **Approve the order above**, or change it. The main decision is whether to start #1 and #2 now.
2. **Ask Metricool now.** As a paying customer, ask your account manager or support what it would take
   to add a new network, how many requests they need, and who to talk to. It costs nothing and
   tells us how far away they are. Do the same with any other tool HG Care or Yellowloaf uses.
3. **Check your Metricool plan** includes Zapier (and the API, if you want it later).
4. **Create the Zapier (and later Make) developer accounts** in Phixr's company name, and accept
   their terms. Claude can't do this for you.
5. **Approve the terms changes** above (ideally with your solicitor, since they're contract terms).
6. **Later, once we have the API and real users:** contact the schedulers in this order:
   - **Postiz** is open source. We can write the Phixr connection ourselves and send it in. Their
     maintainers are slow to review, but it doesn't depend on demand.
   - **Smaller tools** (Publer, SocialBee, OneUp) have been quick to add new networks.
   - **Metricool**, with HG Care and Yellowloaf as references.
   - **Buffer** last. It worked directly with Bluesky to add it.
   - **Hootsuite and Sprout Social** go last. Their partner programmes are for agencies and
     app add-ons, not new networks.

## How each scheduler handles new networks

| Tool | Public way to add a network? | How networks get added | Other routes in |
|------|------------------------------|------------------------|-----------------|
| Metricool | No | Built by Metricool when customers ask (Bluesky, Dec 2024) | Zapier, Make, API (Advanced+ plans) |
| Buffer | No | Built by Buffer from customer requests. Did a partnership with Bluesky | New public API (beta), Zapier |
| Hootsuite | No (App Directory is for add-ons) | Built by Hootsuite | App Directory SDK, Zapier |
| Later | No | Big networks only | — |
| Sprout Social | No (partner programmes are for agencies and resellers) | Built by Sprout | — |
| Planoly | No | Big networks only. Reported to have no public API | — |
| SocialBee | No | Quick to add new networks (Bluesky) | Zapier, RSS (incoming only) |
| Publer | No | Built by Publer | API (Business+), Zapier |
| Zoho Social | No | Big networks only | RSS (incoming only) |
| Postiz (open source) | **Yes.** Anyone can contribute a connection | Community contributions | n8n, API |

## Sources

- Metricool: [API guide](https://help.metricool.com/basic-guide-for-api-integration-r97af),
  [Zapier triggers](https://help.metricool.com/en/article/zapier-with-metricool-1hdwext),
  [Bluesky launch](https://metricool.com/press-release-metricool-launches-bluesky-social-integration/),
  [Bluesky help](https://help.metricool.com/your-guide-to-bluesky-with-metricool-y9d7z)
- Buffer: [Threads launch (7,000+ requests)](https://buffer.com/resources/buffers-threads-integration/),
  [Bluesky partnership](https://alternativeto.net/news/2024/7/bluesky-partners-with-buffer-to-streamline-social-media-scheduling-and-posting),
  [API](https://developers.buffer.com/index.md)
- Hootsuite: [developers / App Directory](https://hootsuite.com/developers),
  [RSS Autopublisher](https://apps.hootsuite.com/apps/rssautopublisher)
- Sprout Social: [partnership programme](https://sproutsocial.com/partnership-program/)
- Later: [platforms](https://education.later.com/page/platforms-and-profile-types)
- SocialBee: [RSS](https://socialbee.com/blog/rss-feeds/), [Bluesky](https://socialbee.com/bluesky-post-scheduler/)
- Publer: [API](https://publer.com/blog/publer-api-for-marketers-and-developers/),
  [Zapier](https://publer.com/integrations/zapier)
- Zoho Social: [RSS feeds](https://help.zoho.com/portal/en/kb/social/collaboration/articles/rss-feeds)
- Postiz: [adding a provider](https://docs.postiz.com/contributing/create-provider.md),
  [repo](https://github.com/gitroomhq/postiz-app)
- Zapier: [publishing requirements](https://docs.zapier.com/platform/publish/integration-publishing-requirements),
  [private vs public](https://docs.zapier.com/platform/quickstart/private-vs-public-integrations)
- Make: [app review](https://developers.make.com/custom-apps-documentation/app-review)
- Supabase: [OAuth 2.1 server](https://supabase.com/docs/guides/auth/oauth-server)
