// ============================================================================
// api — the Phixr Publishing API (stage 1: connect + posting).
//
// Public base URL: https://<project>.supabase.co/functions/v1/api
// Deployed WITHOUT Supabase JWT verification (--no-verify-jwt): callers present
// Phixr API tokens, not app logins. Every check (token, scope, business account,
// test mode, rate limit) happens in the database (api_authenticate); this file
// only parses HTTP and maps results.
//
//   POST   /oauth/token          authorization_code (PKCE) | refresh_token
//   POST   /oauth/revoke         RFC 7009
//   GET    /v1/me                account:read
//   POST   /v1/media             posts:write   multipart "file" | JSON {"url"}
//   POST   /v1/posts             posts:write   create / schedule / draft
//   GET    /v1/posts             posts:read    list this app's posts
//   GET    /v1/posts/:id         posts:read
//   PATCH  /v1/posts/:id         posts:write   caption / alt_text / publish_at
//   DELETE /v1/posts/:id         posts:write   cancel or take down
//
// The consent screen ("authorize") is a page in the Phixr web app:
//   https://joinphixr.com/oauth/authorize?response_type=code&client_id=…
// Reference: docs/publishing-api.md.
// ============================================================================
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

import { config } from '../media-pipeline/config.ts';
import { processUpload } from '../media-pipeline/process.ts';
import { reportError, withSentry } from '../_shared/sentry.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, idempotency-key',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

type Json = Record<string, unknown> | unknown[];

function reply(body: Json | null, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json', ...extra },
  });
}

function fail(status: number, error: string, message?: string, extra: Record<string, string> = {}): Response {
  return reply({ error, ...(message ? { message } : {}) }, status, extra);
}

function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
}

// Database error codes (raised as exceptions, or returned as {"error": code}) → HTTP.
const KNOWN: Record<string, { status: number; message: string }> = {
  invalid_token: { status: 401, message: 'The access token is missing, expired or revoked.' },
  insufficient_scope: { status: 403, message: 'This connection was not given permission for that.' },
  rate_limited: { status: 429, message: 'Too many requests. Slow down and try again in a minute.' },
  app_suspended: { status: 403, message: 'This app has been suspended by Phixr.' },
  app_in_test_mode: {
    status: 403,
    message: 'This app is in test mode and can only act for its developer and named testers.',
  },
  not_business: { status: 403, message: 'This account is no longer a business account.' },
  not_found: { status: 404, message: 'Not found.' },
  invalid_client: { status: 401, message: 'Unknown client or wrong client secret.' },
  invalid_grant: { status: 400, message: 'The code or refresh token is invalid, expired or already used.' },
};

function dbError(err: { message?: string; code?: string } | null): Response {
  const msg = err?.message ?? 'error';
  const known = KNOWN[msg];
  if (known) {
    const extra: Record<string, string> = {};
    if (msg === 'invalid_token') extra['WWW-Authenticate'] = 'Bearer error="invalid_token"';
    if (msg === 'insufficient_scope') extra['WWW-Authenticate'] = 'Bearer error="insufficient_scope"';
    if (msg === 'rate_limited') extra['Retry-After'] = '60';
    return fail(known.status, msg, known.message, extra);
  }
  // A RAISE in our SQL is a validation message meant for the developer.
  if (err?.code === 'P0001') return fail(400, 'invalid_request', msg);
  console.error('[api] database error', err);
  return fail(500, 'server_error', 'Something went wrong on our side.');
}

type Grant = { grant_id: string; client: string; client_name: string; business_id: string; test: boolean };

async function authenticate(
  svc: SupabaseClient, req: Request, scope: string,
): Promise<{ grant: Grant } | { response: Response }> {
  const h = req.headers.get('Authorization') ?? '';
  if (!h.startsWith('Bearer ')) {
    return {
      response: fail(401, 'invalid_token', 'Send "Authorization: Bearer <access token>".', {
        'WWW-Authenticate': 'Bearer',
      }),
    };
  }
  const { data, error } = await svc.rpc('api_authenticate', { _access_token: h.slice(7).trim(), _scope: scope });
  if (error) return { response: dbError(error) };
  if (data?.error) return { response: dbError({ message: data.error }) };
  return { grant: data as Grant };
}

// ---------------------------------------------------------------------------
// OAuth token + revoke
// ---------------------------------------------------------------------------
async function readParams(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const b = await req.json().catch(() => ({}));
    return Object.fromEntries(Object.entries(b ?? {}).map(([k, v]) => [k, String(v)]));
  }
  const text = await req.text();
  return Object.fromEntries(new URLSearchParams(text));
}

function clientCredentials(req: Request, p: Record<string, string>): { id?: string; secret?: string } {
  const h = req.headers.get('Authorization') ?? '';
  if (h.startsWith('Basic ')) {
    try {
      const [id, ...rest] = atob(h.slice(6).trim()).split(':');
      return { id: decodeURIComponent(id), secret: decodeURIComponent(rest.join(':')) };
    } catch {
      return {};
    }
  }
  return { id: p.client_id, secret: p.client_secret || undefined };
}

async function oauthToken(svc: SupabaseClient, req: Request): Promise<Response> {
  const p = await readParams(req);
  const c = clientCredentials(req, p);
  const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };
  if (!c.id) return fail(401, 'invalid_client', 'client_id is required.', noStore);

  let result;
  if (p.grant_type === 'authorization_code') {
    result = await svc.rpc('api_exchange_code', {
      _client_id: c.id, _client_secret: c.secret ?? null, _code: p.code ?? '',
      _redirect_uri: p.redirect_uri ?? '', _code_verifier: p.code_verifier ?? null,
    });
  } else if (p.grant_type === 'refresh_token') {
    result = await svc.rpc('api_refresh', {
      _client_id: c.id, _client_secret: c.secret ?? null, _refresh_token: p.refresh_token ?? '',
    });
  } else {
    return fail(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.', noStore);
  }
  if (result.error) {
    const r = dbError(result.error);
    r.headers.set('Cache-Control', 'no-store');
    return r;
  }
  if (result.data?.error) return dbError({ message: result.data.error });
  return reply(result.data, 200, noStore);
}

async function oauthRevoke(svc: SupabaseClient, req: Request): Promise<Response> {
  const p = await readParams(req);
  const c = clientCredentials(req, p);
  if (!c.id) return fail(401, 'invalid_client', 'client_id is required.');
  const { error } = await svc.rpc('api_revoke_token', {
    _client_id: c.id, _client_secret: c.secret ?? null, _token: p.token ?? '',
  });
  if (error) return dbError(error);
  return reply({ revoked: true });
}

// ---------------------------------------------------------------------------
// Media: multipart upload, or fetch from a public https URL (how Metricool,
// Buffer and Zapier hand over media). Either way the bytes go through the full
// media pipeline for the connected business.
// ---------------------------------------------------------------------------
function blockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h.includes('.')) return true;
  if (/^[0-9.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return true; // IP literals
  return h === 'localhost' || /\.(localhost|local|internal|lan|home|arpa)$/.test(h) ||
    h.endsWith('.supabase.internal');
}

function privateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') ||
      v.startsWith('::ffff:') || v === '::';
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function resolvesPrivate(host: string): Promise<boolean> {
  try {
    const v4 = await Deno.resolveDns(host, 'A').catch(() => [] as string[]);
    const v6 = await Deno.resolveDns(host, 'AAAA').catch(() => [] as string[]);
    return [...v4, ...v6].some(privateIp);
  } catch {
    return false; // resolver unavailable in this runtime: host-name checks still apply
  }
}

async function fetchMedia(raw: string, maxBytes: number): Promise<Uint8Array | { error: string; message: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'invalid_request', message: 'url is not a valid URL.' };
  }
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
      return { error: 'invalid_request', message: 'Media URLs must be public https:// links.' };
    }
    if (blockedHost(url.hostname) || await resolvesPrivate(url.hostname)) {
      return { error: 'invalid_request', message: 'That media URL is not reachable from Phixr.' };
    }
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!res) return { error: 'media_fetch_failed', message: 'Could not download the media URL.' };
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url);
      await res.body?.cancel();
      continue;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      return { error: 'media_fetch_failed', message: `The media URL answered ${res.status}.` };
    }
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > maxBytes) {
      await res.body.cancel();
      return { error: 'too_large', message: `Max ${Math.round(maxBytes / 1048576)} MB.` };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        return { error: 'too_large', message: `Max ${Math.round(maxBytes / 1048576)} MB.` };
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
  return { error: 'media_fetch_failed', message: 'Too many redirects.' };
}

async function uploadMedia(svc: SupabaseClient, req: Request, g: Grant): Promise<Response> {
  const maxBytes = Math.max(config.limits.maxVideoBytes, config.limits.maxImageBytes);
  let bytes: Uint8Array;
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('multipart/form-data')) {
    try {
      const form = await req.formData();
      const file = form.get('file');
      if (!(file instanceof File)) return fail(400, 'invalid_request', 'Send the file in a "file" field.');
      if (file.size > maxBytes) return fail(413, 'too_large', `Max ${Math.round(maxBytes / 1048576)} MB.`);
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      return fail(400, 'invalid_request', 'Could not read the multipart upload.');
    }
  } else {
    const b = await req.json().catch(() => null) as { url?: string } | null;
    if (!b?.url) return fail(400, 'invalid_request', 'Send multipart/form-data with "file", or JSON {"url": "https://…"}.');
    const got = await fetchMedia(b.url, maxBytes);
    if (!(got instanceof Uint8Array)) return fail(got.error === 'too_large' ? 413 : 400, got.error, got.message);
    bytes = got;
  }

  const { data: allowed, error: rlErr } = await svc.rpc('api_claim_upload_slot', {
    _grant: g.grant_id, _max: config.limits.uploadsPerHour, _window_seconds: 3600,
  });
  if (rlErr) return dbError(rlErr);
  if (!allowed) return fail(429, 'rate_limited', 'Upload limit reached for this account. Try again later.', { 'Retry-After': '600' });

  const result = await processUpload(svc, g.business_id, bytes);
  if (result.status !== 200) {
    await svc.rpc('_api_log', {
      _client: g.client, _grant: g.grant_id, _business: g.business_id, _actor: null,
      _action: 'media_rejected', _object: null,
      _detail: { status: result.status, error: result.body.error ?? null, reason: result.body.reason ?? null },
    });
    // Never pass internals (bucket paths, configuration hints) to outside apps.
    const e = String(result.body.error ?? 'processing_failed');
    const message = e === 'rejected'
      ? 'This media breaks the Phixr Community Guidelines and was not accepted.'
      : e === 'processing_failed' || e === 'video_not_configured'
      ? 'We could not process this media. Try again later.'
      : String(result.body.message ?? e);
    return fail(result.status === 501 ? 503 : result.status, e, message);
  }
  const b = result.body as {
    media_type: string; media_url: string; thumbnail_url: string; moderation_status: string;
    width?: number; height?: number; duration_seconds?: number;
  };
  const { data, error } = await svc.rpc('api_record_media', {
    _grant: g.grant_id, _media_url: b.media_url, _thumbnail_url: b.thumbnail_url, _media_type: b.media_type,
    _moderation_status: b.moderation_status, _width: b.width ?? null, _height: b.height ?? null,
    _duration: b.duration_seconds ?? null,
  });
  if (error) return dbError(error);
  return reply(data, 201);
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------
type PostBody = {
  media_ids?: string[]; kind?: string; caption?: string; alt_text?: string; visibility?: string;
  publish_at?: string | null; draft?: boolean;
};

function isoOrNull(v: unknown): string | null | 'bad' {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? 'bad' : d.toISOString();
}

async function createPost(svc: SupabaseClient, req: Request, g: Grant): Promise<Response> {
  const b = await req.json().catch(() => null) as PostBody | null;
  if (!b) return fail(400, 'invalid_request', 'Send a JSON body.');
  const when = isoOrNull(b.publish_at);
  if (when === 'bad') return fail(400, 'invalid_request', 'publish_at must be an ISO 8601 date-time.');
  const key = req.headers.get('Idempotency-Key');
  if (key && key.length > 200) return fail(400, 'invalid_request', 'Idempotency-Key is too long.');
  const { data, error } = await svc.rpc('api_create_post', {
    _grant: g.grant_id,
    _media_ids: Array.isArray(b.media_ids) ? b.media_ids : [],
    _kind: b.kind ?? 'post',
    _caption: b.caption ?? null,
    _alt_text: b.alt_text ?? null,
    _visibility: b.visibility ?? 'public',
    _publish_at: when,
    _as_draft: b.draft === true,
    _idempotency_key: key,
  });
  if (error) return dbError(error);
  return reply(data, data?.idempotent_replay ? 200 : 201);
}

async function updatePost(svc: SupabaseClient, req: Request, g: Grant, id: string): Promise<Response> {
  const b = await req.json().catch(() => null) as PostBody | null;
  if (!b) return fail(400, 'invalid_request', 'Send a JSON body.');
  const when = isoOrNull(b.publish_at);
  if (when === 'bad') return fail(400, 'invalid_request', 'publish_at must be an ISO 8601 date-time.');
  const { data, error } = await svc.rpc('api_update_post', {
    _grant: g.grant_id, _id: id, _caption: b.caption ?? null, _alt_text: b.alt_text ?? null, _publish_at: when,
  });
  if (error) return dbError(error);
  return reply(data);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['draft', 'scheduled', 'held', 'publishing', 'published', 'failed']);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
Deno.serve(withSentry('api', async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  // Path arrives as /api/... (or /functions/v1/api/... locally); keep what follows "api".
  const path = url.pathname.replace(/^.*?\/api(?=\/|$)/, '') || '/';
  const parts = path.split('/').filter(Boolean);
  const svc = serviceClient();

  try {
    if (parts.length === 0 || (parts.length === 1 && parts[0] === 'v1')) {
      return reply({ name: 'Phixr Publishing API', version: 'v1', docs: 'https://joinphixr.com/developers' });
    }

    if (parts[0] === 'oauth') {
      if (req.method !== 'POST') return fail(405, 'method_not_allowed');
      if (parts[1] === 'token') return await oauthToken(svc, req);
      if (parts[1] === 'revoke') return await oauthRevoke(svc, req);
      return fail(404, 'not_found');
    }

    if (parts[0] !== 'v1') return fail(404, 'not_found');
    const [, resource, id, ...extra] = parts;
    if (extra.length) return fail(404, 'not_found');

    if (resource === 'me' && !id) {
      if (req.method !== 'GET') return fail(405, 'method_not_allowed');
      const a = await authenticate(svc, req, 'account:read');
      if ('response' in a) return a.response;
      const { data, error } = await svc.rpc('api_me', { _grant: a.grant.grant_id });
      if (error) return dbError(error);
      return reply({ ...data, test_mode: a.grant.test });
    }

    if (resource === 'media' && !id) {
      if (req.method !== 'POST') return fail(405, 'method_not_allowed');
      const a = await authenticate(svc, req, 'posts:write');
      if ('response' in a) return a.response;
      return await uploadMedia(svc, req, a.grant);
    }

    if (resource === 'posts') {
      if (id && !UUID.test(id)) return fail(404, 'not_found', 'Not found.');
      if (!id && req.method === 'POST') {
        const a = await authenticate(svc, req, 'posts:write');
        if ('response' in a) return a.response;
        return await createPost(svc, req, a.grant);
      }
      if (!id && req.method === 'GET') {
        const a = await authenticate(svc, req, 'posts:read');
        if ('response' in a) return a.response;
        const status = url.searchParams.get('status');
        if (status && !STATUSES.has(status)) return fail(400, 'invalid_request', 'Unknown status filter.');
        const before = isoOrNull(url.searchParams.get('before'));
        if (before === 'bad') return fail(400, 'invalid_request', 'before must be an ISO 8601 date-time.');
        const { data, error } = await svc.rpc('api_list_posts', {
          _grant: a.grant.grant_id, _status: status, _limit: Number(url.searchParams.get('limit') ?? 20) || 20,
          _before: before,
        });
        if (error) return dbError(error);
        return reply({ data });
      }
      if (id && req.method === 'GET') {
        const a = await authenticate(svc, req, 'posts:read');
        if ('response' in a) return a.response;
        const { data, error } = await svc.rpc('api_get_post', { _grant: a.grant.grant_id, _id: id });
        if (error) return dbError(error);
        return reply(data);
      }
      if (id && req.method === 'PATCH') {
        const a = await authenticate(svc, req, 'posts:write');
        if ('response' in a) return a.response;
        return await updatePost(svc, req, a.grant, id);
      }
      if (id && req.method === 'DELETE') {
        const a = await authenticate(svc, req, 'posts:write');
        if ('response' in a) return a.response;
        const { error } = await svc.rpc('api_delete_post', { _grant: a.grant.grant_id, _id: id });
        if (error) return dbError(error);
        return reply(null, 204);
      }
      return fail(405, 'method_not_allowed');
    }

    return fail(404, 'not_found');
  } catch (e) {
    console.error('[api] failed:', e);
    await reportError(e, { path });
    return fail(500, 'server_error', 'Something went wrong on our side.');
  }
}));
