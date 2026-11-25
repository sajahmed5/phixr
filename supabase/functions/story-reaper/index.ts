// ============================================================================
// story-reaper — deletes expired stories AND their media so nothing is orphaned.
// Called by pg_cron via pg_net (see dispatch_story_reaper). Verifies the shared
// webhook secret, then, with the service role: collects expired stories' object
// keys, removes them from the 'media' bucket, and deletes the rows.
// ============================================================================
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

import { withSentry } from '../_shared/sentry.ts';

const SECRET = Deno.env.get('PUSH_WEBHOOK_SECRET') ?? '';

Deno.serve(withSentry('story-reaper', async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (SECRET && req.headers.get('x-webhook-secret') !== SECRET) return json({ error: 'unauthorized' }, 401);

  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  // 1. find expired stories + their object keys
  const { data: expired, error } = await svc
    .from('stories')
    .select('id, media_url, thumbnail_url')
    .lte('expires_at', new Date().toISOString())
    .limit(1000);
  if (error) return json({ error: error.message }, 500);
  if (!expired || expired.length === 0) return json({ deleted: 0 });

  // 2. remove media from storage (dedupe keys; ignore already-gone).
  //    Part 12C: media snapshotted into a story highlight must SURVIVE the
  //    story's expiry — exclude any key a highlight item references.
  const candidate = [...new Set(expired.flatMap((s) => [s.media_url, s.thumbnail_url].filter(Boolean)))] as string[];
  const { data: kept } = await svc
    .from('story_highlight_items')
    .select('media_url, thumbnail_url')
    .in('media_url', candidate);
  const keep = new Set((kept ?? []).flatMap((k) => [k.media_url, k.thumbnail_url].filter(Boolean)));
  const keys = candidate.filter((k) => !keep.has(k));
  if (keys.length) {
    const { error: rmErr } = await svc.storage.from('media').remove(keys);
    if (rmErr) console.error('[story-reaper] storage remove:', rmErr.message);
  }

  // 3. delete the rows (cascade removes story_views)
  const ids = expired.map((s) => s.id);
  const { error: delErr } = await svc.from('stories').delete().in('id', ids);
  if (delErr) return json({ error: delErr.message }, 500);

  return json({ deleted: ids.length, media_removed: keys.length });
}));

function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
}
