// ============================================================================
// feedback-screenshots — admin-only helper that turns a feedback report's ref
// into short-lived signed URLs for its screenshots, so triage tooling (the
// Claude session doing feedback review) can actually look at what the reporter
// saw. The `feedback` bucket stays private: reporters write only under their
// own uid prefix, nothing is ever public, and this function only READS.
//
// Auth: a shared secret in private.config (key 'feedback_screenshots_secret'),
// presented as the x-admin-secret header. The secret is server-side only — it
// lives in the DB, not in any client build. Signed URLs expire in 10 minutes.
// ============================================================================
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const EXPIRY_SECONDS = 600;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Constant-time string compare (both already non-empty). */
function sameSecret(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const svc = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // private.config isn't exposed over PostgREST; this RPC is executable by the
  // service role only (see migration 20261127100000).
  const { data: cfg } = await svc.rpc('feedback_screenshots_secret');
  const secret = typeof cfg === 'string' ? cfg : '';
  const given = req.headers.get('x-admin-secret') ?? '';
  if (!secret || !given || !sameSecret(given, secret)) {
    return json(401, { error: 'unauthorized' });
  }

  let ref: number;
  try {
    const body = await req.json();
    ref = Number(body?.ref);
  } catch {
    return json(400, { error: 'body must be JSON: { ref: number }' });
  }
  if (!Number.isInteger(ref) || ref <= 0) return json(400, { error: 'bad ref' });

  const { data: report, error } = await svc
    .from('feedback_reports')
    .select('ref, screenshot_path, screenshot_paths')
    .eq('ref', ref)
    .maybeSingle();
  if (error) return json(500, { error: error.message });
  if (!report) return json(404, { error: `no report #${ref}` });

  const row = report as {
    ref: number;
    screenshot_path: string | null;
    screenshot_paths: string[] | null;
  };
  const paths = [...new Set([...(row.screenshot_paths ?? []), row.screenshot_path].filter(
    (p): p is string => !!p,
  ))];
  if (paths.length === 0) return json(200, { ref, urls: [] });

  const { data: signed, error: signErr } = await svc.storage
    .from('feedback')
    .createSignedUrls(paths, EXPIRY_SECONDS);
  if (signErr) return json(500, { error: signErr.message });

  return json(200, {
    ref,
    expires_in: EXPIRY_SECONDS,
    urls: (signed ?? []).map((s, i) => ({ path: paths[i], url: s.signedUrl, error: s.error })),
  });
});
