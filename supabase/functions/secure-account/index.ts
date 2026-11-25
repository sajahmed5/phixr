// ============================================================================
// secure-account — "This wasn't me" on a new-login alert (Part 14C).
// Requires the user's own JWT (verify_jwt). It:
//   1. signs the user out of EVERY session/device (global),
//   2. emails a password-reset link, so whoever controls the inbox — the
//      real owner — is the only one who can get back in.
// The attacker's session dies in step 1; nothing here needs their input.
// ============================================================================
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

import { reportError, withSentry } from '../_shared/sentry.ts';

Deno.serve(withSentry('secure-account', async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401);

  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const { data: userData, error: userErr } = await svc.auth.getUser(token);
  if (userErr || !userData.user) return json({ error: 'unauthorized' }, 401);
  const user = userData.user;

  // 1. Kill every session everywhere (this request's included).
  const { error: outErr } = await svc.auth.admin.signOut(token, 'global');
  if (outErr) {
    reportError(outErr, { fn: 'secure-account' });
    return json({ error: 'signout_failed' }, 500);
  }

  // 2. Password reset to the account email — the recovery path owns the account.
  if (user.email) {
    const { error: resetErr } = await svc.auth.resetPasswordForEmail(user.email);
    if (resetErr) reportError(resetErr, { fn: 'secure-account' }); // signed out regardless
  }

  return json({ ok: true, signed_out: true, reset_sent: !!user.email });
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
