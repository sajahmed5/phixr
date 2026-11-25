/**
 * Legal documents + the current terms version.
 *
 * The BODY text here is PLACEHOLDER — the founder supplies the real Terms, Privacy
 * Policy, and Community Guidelines and replaces the strings below. The MECHANISMS that
 * consume this (signup acceptance, the re-accept gate, the report-flow link, the settings
 * links) are wired to `TERMS_VERSION` + `LEGAL_DOCS`.
 *
 * Bump `TERMS_VERSION` whenever the Terms or Privacy text materially changes: the app
 * compares it to `profiles.terms_version` and re-prompts anyone on an older version.
 */
export const TERMS_VERSION = '2026-07-01';

export type LegalDocId = 'terms' | 'privacy' | 'guidelines' | 'ads' | 'safety';

export const LEGAL_DOCS: Record<LegalDocId, { title: string; updated: string; body: string }> = {
  terms: {
    title: 'Terms of Service',
    updated: TERMS_VERSION,
    body: `[PLACEHOLDER — Terms of Service]

This is placeholder text. Replace it with the final Terms of Service before launch.

It should cover at least: eligibility and the minimum age, acceptable use, the licence
you grant to content you post, the points system and any purchases, suspension and
termination, disclaimers and limitation of liability, and the governing law.`,
  },
  privacy: {
    title: 'Privacy Policy',
    updated: TERMS_VERSION,
    body: `[PLACEHOLDER — Privacy Policy]

This is placeholder text. Replace it with the final Privacy Policy before launch.

It should describe what personal data is collected and why, the lawful basis, how long
data is kept, who it is shared with (see the data-collection disclosure document), and
your rights to export and delete your data.

It must also cover (added for Parts 8–9): the ads consent choice and what
personalisation uses (age group, area, interests — never exact location), what ad
interactions are recorded (views, clicks, hides) and that advertisers only ever see
anonymous adult aggregates; paid-partnership declarations; and, when earnings launch,
the payment and tax records kept for creators.`,
  },
  guidelines: {
    title: 'Community Guidelines',
    updated: TERMS_VERSION,
    body: `[PLACEHOLDER — Community Guidelines]

This is placeholder text. Replace it with the final Community Guidelines before launch.

They should set clear rules on: nudity and sexual content, harassment and hate, violence,
illegal content, spam and manipulation, and impersonation — and explain how content is
reported, reviewed, and removed, and how to appeal a decision.`,
  },
  ads: {
    title: 'Advertising Policy',
    updated: TERMS_VERSION,
    body: `[PLACEHOLDER — Advertising & Paid Partnership Policy]

This is placeholder text. Replace it with the final policy before launch.

It should cover: who may advertise (18+ businesses), what may be advertised and the
prohibited categories, how ads are labelled ("Sponsored", "why am I seeing this"), the
personalisation consent choice and that under-18s never receive targeted ads, the
"Paid partnership" disclosure rules for creators (ASA/CAP), billing terms, and how to
report an ad.`,
  },
  safety: {
    title: 'Online Safety',
    updated: TERMS_VERSION,
    body: `[PLACEHOLDER — Online Safety (OSA) statement]

This is placeholder text. Replace it with the final statement before launch.

It should explain, in plain language, the protections Phixr runs under the Online
Safety Act: age rules and under-18 protections (private-by-default, no adult DMs, no
targeting, quiet hours), how to report content or accounts and what happens next,
proactive moderation (scanning, holds, strikes), the CSAM escalation duty, and where
the transparency figures are published.`,
  },
};
