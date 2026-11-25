# CSAM handling process (Part 6B)

This documents how Phixr detects, preserves and escalates suspected child
sexual abuse material, and where the hash-matching provider plugs in.
Everything described here exists in code today; the one swappable piece is
the scanner itself.

## The pipeline (what happens on every upload)

Every image and video goes through the `media-pipeline` Edge Function before
it can be seen by anyone (`supabase/functions/media-pipeline/index.ts`):

1. EXIF strip + transcode.
2. Vision safety pass (nudity/violence classifier) — `reject` removes it
   outright, `flag` holds it for the human review queue.
3. **CSAM scan** — `stubScanner.scan(...)` in
   `supabase/functions/media-pipeline/csam.ts`. On a hit:
   - the upload is refused with the generic reason `content_policy`
     (never telling the uploader what was detected),
   - a **case ref** is created and an evidence record written to
     `csam_reports` (no FK to the profile on purpose: evidence outlives
     account deletion),
   - the original bytes are preserved in the evidence path — **nothing is
     deleted** that may be needed by law enforcement.

## The hash-matching hook

`stubScanner` implements the scanner interface
(`scan(bytes, {userId, mime}) → {status, caseRef?}`). To integrate a real
provider (IWF hash list, PhotoDNA, Safer, etc.):

1. Implement the same interface in `csam.ts` calling the provider.
2. Keep the stub as the fallback when the provider errors (fail CLOSED for
   `reject` verdicts: a scan error should hold the upload, not pass it).
3. No other code changes: the pipeline, evidence write and fame-admin flow
   are provider-agnostic.

Access to provider hash lists (IWF membership, NCMEC/PhotoDNA licensing)
requires an application — start it early; it gates nothing else.

## Human handling (fame-admin)

- The **CSAM escalation** panel on a user page opens a distinct case:
  confirmation **freezes** the account and preserves evidence — it never
  deletes. Reviewer exposure is minimised: the case shows metadata and the
  case ref, not the media, unless a reviewer explicitly opens it with a
  logged justification.
- Every action lands in `admin_audit_log`, which is append-only at the
  database level (a trigger blocks UPDATE/DELETE even for the service role).

## Reporting to authorities (UK)

On a confirmed case, report to the **Internet Watch Foundation** and, where
the provider relationship requires it, **NCMEC**; preserve evidence for law
enforcement requests under the Online Safety Act and respond to UK police
RIPA/IPA requests via the DPO. Do **not** notify the uploader beyond the
generic refusal. Target timelines: escalate internally same-day; report
externally within the provider's/IWF's required window.

## Who does what

| Step | Owner |
| --- | --- |
| Automatic scan + evidence preservation | pipeline (no human) |
| Case review + freeze | fame-admin moderator with CSAM permission |
| External report (IWF/NCMEC/police) | designated safeguarding lead (Saj, until delegated) |
| Evidence release | safeguarding lead, logged in the audit trail |
