import { getClientSettings, settingNumber } from '@/lib/settings';
import { supabase } from '@/lib/supabase';
import type { DeckCard } from '@/lib/deck';

const MEDIA_BUCKET = 'media';
const SIGNED_URL_TTL = 60 * 60 * 2; // 2 hours — comfortably longer than a deck session

/**
 * A post's media_url / thumbnail_url is an object KEY in the private `media` bucket
 * (set by the upload pipeline). Seed/legacy rows may instead hold a full http URL.
 * This tells them apart so we only sign the ones that need it.
 */
export function isStoragePath(value: string): boolean {
  return !!value && !/^https?:\/\//i.test(value) && !value.startsWith('data:');
}

/**
 * Batch-sign object keys. Returns a key→signed-URL map; unreadable keys are omitted.
 *
 * With the server's `media_cdn_enabled` switch on, keys already copied to Cloudflare R2
 * get links on media.phixrcdn.com (sign_media: same visibility rules, 24h links, no
 * download fees). Anything else — not copied yet, or R2 switched off — is signed by
 * Supabase Storage exactly as before, so nothing breaks mid-move.
 */
export async function signMediaPaths(paths: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(paths.filter(isStoragePath))];
  if (unique.length === 0) return map;

  if (await mediaCdnEnabled()) {
    const { data } = await supabase.rpc('sign_media', { _keys: unique });
    for (const row of (data ?? []) as { key: string; url: string }[]) {
      if (row.key && row.url) map.set(row.key, row.url);
    }
  }

  const rest = unique.filter((k) => !map.has(k));
  if (rest.length === 0) return map;
  const { data, error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .createSignedUrls(rest, SIGNED_URL_TTL);
  if (error || !data) return map;
  for (const row of data) {
    if (row.signedUrl && row.path) map.set(row.path, row.signedUrl);
  }
  return map;
}

async function mediaCdnEnabled(): Promise<boolean> {
  try {
    return settingNumber(await getClientSettings(), 'media_cdn_enabled', 0) >= 1;
  } catch {
    return false;
  }
}

/**
 * Resolve a deck batch's media for display: sign any storage-key media_url /
 * thumbnail_url in one round-trip, leaving already-absolute URLs untouched. RLS on
 * the bucket mirrors post visibility, so signing only succeeds for media the caller
 * is allowed to see.
 */
export async function resolveDeckMedia(cards: DeckCard[]): Promise<DeckCard[]> {
  if (cards.length === 0) return cards;
  const paths: string[] = [];
  for (const c of cards) {
    if (isStoragePath(c.media_url)) paths.push(c.media_url);
    if (isStoragePath(c.thumbnail_url)) paths.push(c.thumbnail_url);
  }
  // Signing the covers and loading the carousel extras are independent — run them
  // together so carousels cost no extra latency on the deck's critical path.
  const [signed, extrasMap] = await Promise.all([
    paths.length ? signMediaPaths(paths) : Promise.resolve(new Map<string, string>()),
    carouselExtras(cards.map((c) => c.id)),
  ]);
  return cards.map((c) => {
    const media_url = signed.get(c.media_url) ?? c.media_url;
    const extras = extrasMap.get(c.id);
    return {
      ...c,
      media_url,
      thumbnail_url: signed.get(c.thumbnail_url) ?? c.thumbnail_url,
      media_count: 1 + (extras?.length ?? 0),
      // Cover first, then the extras in position order — what the deck pages through.
      carousel: extras?.length
        ? [{ media_url, media_type: c.media_type }, ...extras]
        : undefined,
    };
  });
}

// .../storage/v1/object/sign/media/<path>?token=...  (Supabase Storage)
// https://media.phixrcdn.com/m/<path>?e=...&s=...    (Cloudflare R2)
const SIGNED_MEDIA_RE = /(?:\/storage\/v1\/object\/sign\/media\/|^https:\/\/media\.phixrcdn\.com\/m\/)([^?]+)/;

/** The bucket path behind a signed media URL (or the value unchanged if it isn't one). */
export function storagePathFromUrl(url: string): string {
  const m = url.match(SIGNED_MEDIA_RE);
  if (!m) return url;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/**
 * Fresh links for cards whose signed URLs may have expired — e.g. a deck saved on the
 * phone and reopened hours later. Same signing (and the same visibility rules) as a
 * normal batch.
 */
export async function resignDeckMedia(cards: DeckCard[]): Promise<DeckCard[]> {
  return resolveDeckMedia(
    cards.map((c) => ({
      ...c,
      media_url: storagePathFromUrl(c.media_url),
      thumbnail_url: storagePathFromUrl(c.thumbnail_url),
      carousel: undefined,
      media_count: undefined,
    })),
  );
}

type CarouselItem = { media_url: string; media_type: 'image' | 'video' };

/**
 * The extra (position >= 1) media for each post, signed and in order. Never throws —
 * if the query fails the cards simply render as single-media rather than failing.
 */
async function carouselExtras(ids: string[]): Promise<Map<string, CarouselItem[]>> {
  const out = new Map<string, CarouselItem[]>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase
    .from('post_media')
    .select('post_id, position, media_url, media_type')
    .in('post_id', ids)
    .order('position', { ascending: true });
  if (error || !data) return out;
  const rows = data as { post_id: string; media_url: string; media_type: 'image' | 'video' }[];
  if (rows.length === 0) return out;
  const signed = await signMediaPaths(rows.map((r) => r.media_url).filter(isStoragePath));
  for (const r of rows) {
    const list = out.get(r.post_id) ?? [];
    list.push({ media_url: signed.get(r.media_url) ?? r.media_url, media_type: r.media_type });
    out.set(r.post_id, list);
  }
  return out;
}
