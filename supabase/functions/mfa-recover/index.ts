// ============================================================================
// mfa-recover — lost-authenticator escape hatch (Part 14C).
// The signed-in user (password = first factor) presents ONE unused backup
// code; a match consumes the code and removes their TOTP factors so they can
// re-enrol. Codes are stored only as SHA-256; a wrong code burns ~1s so
// brute-forcing 10^10 code space through this path is hopeless.
// ============================================================================
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

import { reportError, withSentry } from '../_shared/sentry.ts';

Deno.serve(withSentry('mfa-recover', async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401);

  let code = '';
  try {
    code = String((await req.json()).code ?? '').trim().toUpperCase();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  if (!/^[0-9A-F]{5}-[0-9A-F]{5}$/.test(code)) return json({ error: 'bad_code_format' }, 400);

  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await svc.auth.getUser(token);
  if (userErr || !userData.user) return json({ error: 'unauthorized' }, 401);
  const uid = userData.user.id;

  const hashBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  const hash = [...new Uint8Array(hashBytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

  const { data: match } = await svc
    .from('backup_codes')
    .select('id')
    .eq('user_id', uid)
    .eq('code_hash', hash)
    .is('used_at', null)
    .maybeSingle();

  if (!match) {
    await new Promise((r) => setTimeout(r, 1000)); // flat cost for wrong codes
    return json({ error: 'invalid_code' }, 403);
  }

  await svc.from('backup_codes').update({ used_at: new Date().toISOString() }).eq('id', match.id);

  // Remove the lost authenticator so the user can enrol a new one.
  const { data: factors, error: listErr } = await svc.auth.admin.mfa.listFactors({ userId: uid });
  if (listErr) {
    reportError(listErr, { fn: 'mfa-recover' });
    return json({ error: 'factor_list_failed' }, 500);
  }
  for (const f of factors?.factors ?? []) {
    const { error: delErr } = await svc.auth.admin.mfa.deleteFactor({ id: f.id, userId: uid });
    if (delErr) reportError(delErr, { fn: 'mfa-recover' });
  }

  return json({ ok: true, factors_removed: (factors?.factors ?? []).length });
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
