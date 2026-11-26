// phixr-media — Cloudflare Worker in front of the private R2 bucket `phixr-media`,
// served at https://media.phixrcdn.com.
//
//   GET/HEAD /m/<key>?e=<expiry>&s=<sig>   serve a file. Only with a valid, unexpired
//                                          signature made by public.sign_media() in
//                                          Supabase (same visibility rules as the app).
//   PUT    /u/<key>                        store a file      } server-only: need
//   HEAD   /u/<key>                        exists? + size    } Authorization: Bearer
//   DELETE /u/<key>                        delete a file     } UPLOAD_SECRET
//   DELETE /u?prefix=<uid>/                delete a folder   } (account deletion)
//
// Secrets (wrangler secret put): SIGNING_SECRET, UPLOAD_SECRET. Both also live in
// Supabase Vault (media_signing_secret / media_upload_secret).
//
// Files never change once written (each upload gets a new key), so responses are
// cacheable for a day. Files are cached at the edge by KEY (not by signed URL), but
// the signature is always checked first, so the cache never serves an unsigned request.

// {owner uuid}/{file name}: the only shape the upload pipeline produces.
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9._-]{1,160}$/;
const PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/$/;
const MAX_LINK_AGE_S = 2 * 24 * 3600; // refuse links that claim to last longer than this
const CACHE_MAX_BYTES = 100 * 1024 * 1024;
const CACHE_CONTROL = 'public, max-age=86400, immutable';

const enc = new TextEncoder();
let hmacKey = null; // CryptoKey, imported once per isolate

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') return text('ok', 200);
      if (url.pathname.startsWith('/m/')) return await serve(request, env, ctx, url);
      if (url.pathname === '/u' || url.pathname.startsWith('/u/')) return await admin(request, env, url);
      return text('Not found', 404);
    } catch (err) {
      console.error('phixr-media error', err && err.stack ? err.stack : String(err));
      return text('Error', 500);
    }
  },
};

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------
async function serve(request, env, ctx, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method not allowed', 405);

  const key = decodeKey(url.pathname.slice(3));
  if (!key) return text('Not found', 404);

  const exp = Number(url.searchParams.get('e'));
  const sig = url.searchParams.get('s') || '';
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(exp) || exp < now || exp - now > MAX_LINK_AGE_S) return text('Link expired', 403);
  if (!(await validSignature(env, key, exp, sig))) return text('Forbidden', 403);

  const range = request.headers.get('Range');
  const cache = caches.default;
  const cacheUrl = `https://media.phixrcdn.com/__c/${key}`;

  // Edge cache first (handles Range against a cached full file automatically).
  const cached = await cache.match(new Request(cacheUrl, { headers: range ? { Range: range } : {} }));
  if (cached) return request.method === 'HEAD' ? new Response(null, cached) : cached;

  if (range) {
    // Video players ask for byte ranges. Serve the range from R2 now, and warm the
    // cache with the whole file in the background so later ranges are edge hits.
    const obj = await env.MEDIA.get(key, { range: request.headers });
    if (!obj) return text('Not found', 404);
    ctx.waitUntil(warmCache(env, cache, cacheUrl, key));
    return objectResponse(obj, request.method, true);
  }

  const obj = await env.MEDIA.get(key);
  if (!obj) return text('Not found', 404);
  const response = objectResponse(obj, 'GET', false);
  if (obj.size <= CACHE_MAX_BYTES) ctx.waitUntil(cache.put(cacheUrl, response.clone()));
  return request.method === 'HEAD' ? new Response(null, response) : response;
}

async function warmCache(env, cache, cacheUrl, key) {
  const already = await cache.match(cacheUrl);
  if (already) return;
  const head = await env.MEDIA.head(key);
  if (!head || head.size > CACHE_MAX_BYTES) return;
  const obj = await env.MEDIA.get(key);
  if (obj) await cache.put(cacheUrl, objectResponse(obj, 'GET', false));
}

function objectResponse(obj, method, partial) {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('Cache-Control', CACHE_CONTROL);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Content-Type-Options', 'nosniff');
  let status = 200;
  if (partial && obj.range) {
    const offset = obj.range.offset ?? 0;
    const length = obj.range.length ?? obj.size - offset;
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('Content-Length', String(length));
    status = 206;
  } else {
    headers.set('Content-Length', String(obj.size));
  }
  return new Response(method === 'HEAD' ? null : obj.body, { status, headers });
}

async function validSignature(env, key, exp, sig) {
  if (!env.SIGNING_SECRET || !sig) return false;
  if (!hmacKey) {
    hmacKey = await crypto.subtle.importKey(
      'raw', enc.encode(env.SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
  }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, enc.encode(`${key}:${exp}`)));
  return timingSafeEqualStr(base64url(mac), sig);
}

// ---------------------------------------------------------------------------
// Server-only writes (upload pipeline, backfill, deletions)
// ---------------------------------------------------------------------------
async function admin(request, env, url) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.UPLOAD_SECRET || !timingSafeEqualStr(auth, `Bearer ${env.UPLOAD_SECRET}`)) {
    return text('Forbidden', 403);
  }

  if (url.pathname === '/u') {
    // Folder delete: DELETE /u?prefix=<uid>/
    if (request.method !== 'DELETE') return text('Method not allowed', 405);
    const prefix = url.searchParams.get('prefix') || '';
    if (!PREFIX_RE.test(prefix)) return text('Bad prefix', 400);
    let deleted = 0;
    let cursor;
    do {
      const page = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
      const keys = page.objects.map((o) => o.key);
      if (keys.length) {
        await env.MEDIA.delete(keys);
        await purge(keys);
        deleted += keys.length;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return json({ deleted });
  }

  const key = decodeKey(url.pathname.slice(3));
  if (!key) return text('Bad key', 400);

  if (request.method === 'PUT') {
    const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
    if (!request.headers.get('Content-Length')) return text('Content-Length required', 411);
    const obj = await env.MEDIA.put(key, request.body, { httpMetadata: { contentType } });
    return json({ key, bytes: obj.size, etag: obj.etag });
  }
  if (request.method === 'HEAD') {
    const head = await env.MEDIA.head(key);
    return new Response(null, { status: head ? 200 : 404, headers: head ? { 'X-Size': String(head.size) } : {} });
  }
  if (request.method === 'DELETE') {
    await env.MEDIA.delete(key);
    await purge([key]);
    return json({ deleted: 1 });
  }
  return text('Method not allowed', 405);
}

async function purge(keys) {
  const cache = caches.default;
  await Promise.all(keys.map((k) => cache.delete(`https://media.phixrcdn.com/__c/${k}`)));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function decodeKey(raw) {
  let key;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return KEY_RE.test(key) ? key : null;
}

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqualStr(a, b) {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

function text(body, status) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

function json(obj) {
  return new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
}
