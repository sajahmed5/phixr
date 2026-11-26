// ============================================================================
// r2-sync — keeps the Cloudflare R2 media copy in step with Supabase Storage.
// Called every 10 minutes by pg_cron via pg_net (public.dispatch_r2_sync), with
// the shared webhook secret. Two jobs per run:
//
//   1. Copy: serving objects that something uses but that aren't in R2 yet
//      (missed live mirrors, and the one-time backfill of existing media).
//   2. Trash: keys from deleted posts that nothing references any more, after a
//      10-minute grace — deleted from Supabase Storage AND R2.
//
// Body (optional): { "copy": <max objects, default 60>, "trash": <max keys, default 200> }
// ============================================================================
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

import { r2CopyFromStorage, r2Delete } from '../_shared/r2.ts';
import { withSentry } from '../_shared/sentry.ts';

const SECRET = Deno.env.get('PUSH_WEBHOOK_SECRET') ?? '';
const CONCURRENCY = 4;
const BUDGET_MS = 100_000; // stop starting new copies well before the function timeout

Deno.serve(withSentry('r2-sync', async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!SECRET || req.headers.get('x-webhook-secret') !== SECRET) return json({ error: 'unauthorized' }, 401);

  const started = Date.now();
  const opts = (await req.json().catch(() => ({}))) as { copy?: number; trash?: number };
  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  // ---- 1. copy pending objects -------------------------------------------
  const { data: pending, error: pErr } = await svc.rpc('r2_pending_keys', { _limit: opts.copy ?? 60 });
  if (pErr) return json({ error: pErr.message }, 500);
  const queue = [...((pending ?? []) as { key: string; content_type: string | null }[])];
  let copied = 0;
  let failed = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        if (Date.now() - started > BUDGET_MS) return;
        if (await r2CopyFromStorage(svc, item.key, item.content_type)) copied++;
        else failed++;
      }
    }),
  );

  // ---- 2. empty the trash ------------------------------------------------
  const { data: due, error: tErr } = await svc.rpc('media_trash_due', { _limit: opts.trash ?? 200 });
  if (tErr) return json({ copied, failed, error: tErr.message }, 500);
  const keys = (due ?? []) as string[];
  let trashed = 0;
  if (keys.length) {
    const { error: rmErr } = await svc.storage.from('media').remove(keys);
    if (rmErr) {
      console.error('[r2-sync] storage remove:', rmErr.message);
    } else {
      await r2Delete(svc, keys);
      await svc.from('media_trash').delete().in('key', keys);
      trashed = keys.length;
    }
  }

  return json({ copied, failed, left_in_batch: queue.length, trashed, ms: Date.now() - started });
}));

function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
}
