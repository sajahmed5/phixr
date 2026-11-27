// ============================================================================
// media-pipeline — Supabase Edge Function.
//
// Processes an uploaded media file through the MANDATED pipeline order before
// anything is persisted or served:
//   1. Accept upload → PRIVATE staging bucket (nothing public before step 6)
//   2. EXIF READ   (GPS + timestamp, in-memory, for suggestion; not persisted)
//   3. EXIF STRIP  (re-encode; then VERIFY the output is clean — fail-closed)
//   4. ADULT SCAN  (Google Vision SafeSearch; reject / flag / approve)
//   5. CSAM SCAN   (integration point; STUB — NOT PRODUCTION READY)
//   6. TRANSCODE + STORE → serving bucket (images inline; video via worker)
//   7. Return urls, moderation_status, and GPS/label/place tag suggestions.
//
// A failure at any step removes everything written so far — nothing orphaned.
// ============================================================================
import { config } from './config.ts';
import { processUpload } from './process.ts';
import { serviceClient, userClient } from './storage.ts';

import { withSentry } from '../_shared/sentry.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  // `apikey` + `x-client-info` are sent by the web client (raw XHR / supabase-js); without
  // them here the browser's CORS preflight fails and blocks the upload.
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}

Deno.serve(withSentry('media-pipeline', async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // ---- SECURITY: authenticate the caller. Unauthenticated → reject. ----
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401);
  const jwt = auth.slice(7);
  const uclient = userClient(jwt);
  const { data: userData, error: authErr } = await uclient.auth.getUser();
  const user = userData?.user;
  if (authErr || !user) return json({ error: 'unauthorized' }, 401);

  // ---- Size gate BEFORE reading the body or spending a rate-limit slot. ----
  // Reading an oversized body crashes the isolate (WORKER_RESOURCE_LIMIT) before the
  // per-kind check in process.ts can answer, so refuse on the declared length here.
  const declared = Number(req.headers.get('content-length') ?? '');
  const maxBody = Math.max(config.limits.maxVideoBytes, config.limits.maxImageBytes) + 1024 * 1024; // + multipart overhead
  if (Number.isFinite(declared) && declared > maxBody) {
    // Drain (without keeping) the upload first: answering while the client is still
    // sending makes the Supabase gateway turn our 413 into a Cloudflare 502.
    try {
      for await (const _chunk of req.body ?? []) { /* discard */ }
    } catch { /* client went away — nothing to answer */ }
    return json({
      error: 'too_large',
      message: `That file is too large to upload (max ${Math.round(config.limits.maxVideoBytes / 1048576)} MB). Try a shorter clip.`,
    }, 413);
  }

  // ---- SECURITY: per-user rate limit (recorded under the caller's identity). ----
  const { data: allowed, error: rlErr } = await uclient.rpc('claim_media_upload_slot', {
    _max: config.limits.uploadsPerHour,
    _window_seconds: 3600,
  });
  if (rlErr) return json({ error: 'rate_limit_check_failed' }, 500);
  if (!allowed) return json({ error: 'rate_limited', message: 'Too many uploads. Try again later.' }, 429);

  // ---- Read the file from multipart form-data. ----
  let bytes: Uint8Array;
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return json({ error: 'no_file' }, 400);
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return json({ error: 'bad_request', message: 'Expected multipart/form-data with a "file" field.' }, 400);
  }
  if (bytes.length === 0) return json({ error: 'empty_file' }, 400);

  // Steps 1–7 live in process.ts (shared with the Publishing API).
  const result = await processUpload(serviceClient(), user.id, bytes);
  return json(result.body, result.status);
}));
