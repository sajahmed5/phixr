// iap-validate — verifies a store purchase and creates the paid boost.
//
// The client NEVER creates a paid boost: it sends the store receipt here, we
// verify it with Apple / Google, then call create_boost_from_iap (service
// role; replay-protected by the transaction id). Until the store keys are
// configured (APPLE_SHARED_SECRET / GOOGLE_PLAY_SA_JSON env), the function
// answers 503 iap_not_configured and the app keeps the purchase UI hidden
// via the iap_enabled setting.
//
// Products (consumables): phixr.boost.1day / phixr.boost.3day / phixr.boost.7day
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

import { withSentry } from '../_shared/sentry.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}

const PRODUCT_DAYS: Record<string, number> = {
  'phixr.boost.1day': 1,
  'phixr.boost.3day': 3,
  'phixr.boost.7day': 7,
};

type Body = {
  platform: 'apple' | 'google';
  productId: string;
  /** Apple: the base64 app receipt. Google: the purchase token. */
  receipt: string;
  boost: {
    post_id: string;
    age_bands?: string[];
    region_label?: string | null;
    tag_ids?: string[];
  };
};

/** Apple verifyReceipt (production first, 21007 → sandbox), per Apple docs. */
async function verifyApple(receipt: string, productId: string) {
  const secret = Deno.env.get('APPLE_SHARED_SECRET');
  if (!secret) return { configured: false as const };
  const payload = { 'receipt-data': receipt, password: secret, 'exclude-old-transactions': true };
  let res = await fetch('https://buy.itunes.apple.com/verifyReceipt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => r.json());
  if (res.status === 21007) {
    res = await fetch('https://sandbox.itunes.apple.com/verifyReceipt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((r) => r.json());
  }
  if (res.status !== 0) return { configured: true as const, ok: false as const, detail: `status ${res.status}` };
  const txns = (res.latest_receipt_info ?? res.receipt?.in_app ?? []) as Record<string, string>[];
  const txn = txns.find((t) => t.product_id === productId);
  if (!txn) return { configured: true as const, ok: false as const, detail: 'product not in receipt' };
  return {
    configured: true as const,
    ok: true as const,
    transactionId: String(txn.transaction_id),
    raw: { environment: res.environment, purchase_date_ms: txn.purchase_date_ms },
  };
}

/** Google Play purchases.products.get via a service account. */
async function verifyGoogle(purchaseToken: string, productId: string) {
  const saJson = Deno.env.get('GOOGLE_PLAY_SA_JSON');
  if (!saJson) return { configured: false as const };
  const sa = JSON.parse(saJson);
  // Mint an access token for androidpublisher via the JWT grant.
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = btoa(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claims}`.replace(/=+/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const keyData = sa.private_key.replace(/-----[A-Z ]+-----|\n/g, '');
  const key = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(atob(keyData), (c) => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=+/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')}`;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  }).then((r) => r.json());
  if (!tokenRes.access_token) return { configured: true as const, ok: false as const, detail: 'auth failed' };

  const pkg = Deno.env.get('ANDROID_PACKAGE') ?? 'com.phixr.app';
  const res = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}/purchases/products/${productId}/tokens/${purchaseToken}`,
    { headers: { Authorization: `Bearer ${tokenRes.access_token}` } },
  ).then((r) => r.json());
  // purchaseState 0 = purchased.
  if (res.purchaseState !== 0) return { configured: true as const, ok: false as const, detail: `state ${res.purchaseState}` };
  return {
    configured: true as const,
    ok: true as const,
    transactionId: String(res.orderId ?? purchaseToken),
    raw: { purchaseTimeMillis: res.purchaseTimeMillis, acknowledged: res.acknowledgementState },
  };
}

Deno.serve(
  withSentry('iap-validate', async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'unauthorized' }, 401);
    const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: userData, error: authErr } = await svc.auth.getUser(token);
    if (authErr || !userData.user) return json({ error: 'unauthorized' }, 401);
    const uid = userData.user.id;

    const body = (await req.json().catch(() => null)) as Body | null;
    const days = body ? PRODUCT_DAYS[body.productId] : undefined;
    if (!body || !body.receipt || !body.boost?.post_id || !days || !['apple', 'google'].includes(body.platform)) {
      return json({ error: 'bad_request' }, 400);
    }

    const verdict =
      body.platform === 'apple'
        ? await verifyApple(body.receipt, body.productId)
        : await verifyGoogle(body.receipt, body.productId);
    if (!verdict.configured) return json({ error: 'iap_not_configured' }, 503);
    if (!verdict.ok) return json({ error: 'receipt_invalid', detail: verdict.detail }, 402);

    const { data: boostId, error } = await svc.rpc('create_boost_from_iap', {
      _user_id: uid,
      _post_id: body.boost.post_id,
      _days: days,
      _age_bands: body.boost.age_bands ?? [],
      _region_label: body.boost.region_label ?? null,
      _tag_ids: body.boost.tag_ids ?? [],
      _provider: body.platform,
      _transaction_id: `${body.platform}:${verdict.transactionId}`,
      _product_id: body.productId,
      _amount_pence: null, // store price is in the store's report; recorded when webhooks land
      _currency: null,
      _raw: verdict.raw,
    });
    if (error) {
      const already = error.message.includes('already redeemed');
      return json({ error: already ? 'already_redeemed' : 'boost_failed', detail: error.message }, already ? 409 : 422);
    }
    return json({ boost_id: boostId });
  }),
);
