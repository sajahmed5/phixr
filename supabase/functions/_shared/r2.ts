// ============================================================================
// r2.ts — server-side access to the Cloudflare R2 media copy, through the
// phixr-media Worker (https://media.phixrcdn.com). No R2 access keys live in
// Supabase: writes use the Worker's UPLOAD_SECRET, read from Vault via the
// service-role-only RPC get_media_upload_secret().
//
// Supabase Storage stays the source of truth while media moves to R2, so every
// function here is BEST EFFORT: failures are logged and swallowed. The r2-sync
// job copies anything that was missed, and the app falls back to Supabase links
// for keys not yet recorded in public.r2_objects.
// ============================================================================
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

export const MEDIA_ORIGIN = 'https://media.phixrcdn.com';

let cachedSecret: string | null = null;

async function uploadSecret(svc: SupabaseClient): Promise<string | null> {
  if (cachedSecret) return cachedSecret;
  const { data, error } = await svc.rpc('get_media_upload_secret');
  if (error || typeof data !== 'string' || !data) return null;
  cachedSecret = data;
  return data;
}

function keyPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/** Store one object in R2 and record it in r2_objects. Returns true on success. */
export async function r2Put(
  svc: SupabaseClient,
  key: string,
  body: Uint8Array | ReadableStream<Uint8Array>,
  contentType: string,
  length: number,
): Promise<boolean> {
  try {
    const secret = await uploadSecret(svc);
    if (!secret) return false;
    const res = await fetch(`${MEDIA_ORIGIN}/u/${keyPath(key)}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': contentType,
        'Content-Length': String(length),
      },
      body: body as BodyInit,
    });
    if (!res.ok) {
      console.error(`[r2] put ${key}: ${res.status} ${await res.text().catch(() => '')}`);
      return false;
    }
    const { error } = await svc
      .from('r2_objects')
      .upsert({ key, bytes: length, content_type: contentType, synced_at: new Date().toISOString() });
    if (error) console.error(`[r2] record ${key}: ${error.message}`);
    return !error;
  } catch (e) {
    console.error(`[r2] put ${key} failed:`, e);
    return false;
  }
}

/**
 * Copy an object that is already in Supabase Storage (bucket `media`) to R2,
 * streaming it rather than holding a whole video in memory.
 */
export async function r2CopyFromStorage(
  svc: SupabaseClient,
  key: string,
  contentType?: string | null,
): Promise<boolean> {
  try {
    const { data, error } = await svc.storage.from('media').createSignedUrl(key, 600);
    if (error || !data?.signedUrl) {
      console.error(`[r2] sign ${key}: ${error?.message}`);
      return false;
    }
    const src = await fetch(data.signedUrl);
    const length = Number(src.headers.get('content-length'));
    if (!src.ok || !src.body || !Number.isFinite(length) || length <= 0) {
      console.error(`[r2] download ${key}: ${src.status}`);
      await src.body?.cancel();
      return false;
    }
    const type = contentType || src.headers.get('content-type') || 'application/octet-stream';
    return await r2Put(svc, key, src.body, type, length);
  } catch (e) {
    console.error(`[r2] copy ${key} failed:`, e);
    return false;
  }
}

/** Delete objects from R2 and forget them in r2_objects. Never throws. */
export async function r2Delete(svc: SupabaseClient, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    const secret = await uploadSecret(svc);
    if (secret) {
      await Promise.all(
        keys.map((key) =>
          fetch(`${MEDIA_ORIGIN}/u/${keyPath(key)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${secret}` },
          }).then((r) => {
            if (!r.ok) console.error(`[r2] delete ${key}: ${r.status}`);
          }),
        ),
      );
    }
    await svc.from('r2_objects').delete().in('key', keys);
  } catch (e) {
    console.error('[r2] delete failed:', e);
  }
}

/** Delete everything under `{uid}/` in R2 (account deletion). Never throws. */
export async function r2DeleteFolder(svc: SupabaseClient, uid: string): Promise<number> {
  try {
    const secret = await uploadSecret(svc);
    let deleted = 0;
    if (secret) {
      const res = await fetch(`${MEDIA_ORIGIN}/u?prefix=${encodeURIComponent(`${uid}/`)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${secret}` },
      });
      if (res.ok) deleted = ((await res.json()) as { deleted?: number }).deleted ?? 0;
      else console.error(`[r2] folder delete ${uid}: ${res.status}`);
    }
    await svc.from('r2_objects').delete().like('key', `${uid}/%`);
    return deleted;
  } catch (e) {
    console.error('[r2] folder delete failed:', e);
    return 0;
  }
}
