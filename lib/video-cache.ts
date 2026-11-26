import { Directory, File, Paths } from 'expo-file-system';

import { isSimulatingOffline, isUnmeteredConnection } from '@/lib/connectivity';
import { storagePathFromUrl } from '@/lib/media';

/**
 * Upcoming deck videos, downloaded ahead of time on Wi-Fi so swiping stays smooth and
 * they still play if the signal drops afterwards. On mobile data nothing is downloaded
 * ahead — videos stream when they reach the top, as before — to respect people's data.
 *
 * Files are keyed by the media's bucket path, not the signed link (links change every
 * time they're re-signed), and kept in the OS cache directory with a small cap, so the
 * OS can reclaim the space if it needs to.
 */

const MAX_FILES = 20; // ~250 MB at the transcoder's typical clip size
const dir = new Directory(Paths.cache, 'deck-videos');
const inflight = new Set<string>();
/** bucket-path key -> file name ("<savedAtMs>__<key>.mp4"); built from disk on first use. */
let index: Map<string, string> | null = null;

function keyFor(url: string): string {
  const path = storagePathFromUrl(url.split('?')[0]);
  return path.replace(/[^a-zA-Z0-9]/g, '_').slice(-120);
}

function loadIndex(): Map<string, string> {
  if (index) return index;
  index = new Map();
  try {
    if (!dir.exists) return index;
    for (const entry of dir.list()) {
      if (!(entry instanceof File) || !entry.name.endsWith('.mp4')) continue;
      const sep = entry.name.indexOf('__');
      if (sep > 0) index.set(entry.name.slice(sep + 2, -4), entry.name);
    }
  } catch {
    // unreadable cache: start empty
  }
  return index;
}

/** A local file:// URI for this video if it has been downloaded, else the original URL. */
export function cachedVideoUri(url: string): string {
  if (!url || !/^https?:/i.test(url)) return url;
  const name = loadIndex().get(keyFor(url));
  if (!name) return url;
  try {
    const f = new File(dir, name);
    if (f.exists && f.size > 0) return f.uri;
  } catch {
    // fall through to streaming
  }
  index?.delete(keyFor(url));
  return url;
}

/** Download a video ahead of time — only on Wi-Fi, never twice, never beyond the cap. */
export function prefetchVideo(url: string): void {
  if (!url || !/^https?:/i.test(url)) return;
  if (isSimulatingOffline() || !isUnmeteredConnection()) return;
  const key = keyFor(url);
  if (loadIndex().has(key) || inflight.has(key)) return;
  inflight.add(key);
  void (async () => {
    const name = `${Date.now()}__${key}.mp4`;
    const part = new File(dir, `${name}.part`);
    try {
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
      if (part.exists) part.delete();
      await File.downloadFileAsync(url, part);
      // Only a complete download is ever played: rename once it has fully arrived.
      part.move(new File(dir, name));
      loadIndex().set(key, name);
      prune();
    } catch {
      try {
        if (part.exists) part.delete();
      } catch {
        // ignore
      }
    } finally {
      inflight.delete(key);
    }
  })();
}

function prune(): void {
  const idx = loadIndex();
  if (idx.size <= MAX_FILES) return;
  const oldestFirst = [...idx.entries()].sort(
    (a, b) => Number(a[1].split('__')[0]) - Number(b[1].split('__')[0]),
  );
  for (const [key, name] of oldestFirst.slice(0, idx.size - MAX_FILES)) {
    try {
      const f = new File(dir, name);
      if (f.exists) f.delete();
    } catch {
      // ignore
    }
    idx.delete(key);
  }
}
