import { Directory, File, Paths } from 'expo-file-system';

/**
 * Durable copies of media waiting in an outbox (a post or message written without a
 * connection). The picker/camera hand us files in temporary locations the OS may clear,
 * so anything queued is copied into the app's document directory first and deleted once
 * it has been sent (or the user discards it).
 */

const ROOT = 'outbox';

function folderFor(itemId: string): Directory {
  return new Directory(Paths.document, ROOT, itemId);
}

function extensionOf(uri: string, fallback: string): string {
  const clean = uri.split('?')[0];
  const dot = clean.lastIndexOf('.');
  const ext = dot > clean.lastIndexOf('/') ? clean.slice(dot + 1).toLowerCase() : '';
  return /^[a-z0-9]{2,5}$/.test(ext) ? ext : fallback;
}

/**
 * Copy `uri` into the item's outbox folder and return the new file URI. If the source
 * can't be copied (e.g. a non-file URI), the original URI is returned so the send can
 * still be attempted while the app stays open.
 */
export function keepForOutbox(itemId: string, index: number, uri: string, type: 'image' | 'video'): string {
  try {
    if (!uri.startsWith('file://')) return uri;
    const dir = folderFor(itemId);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const dest = new File(dir, `${index}.${extensionOf(uri, type === 'video' ? 'mp4' : 'jpg')}`);
    if (dest.exists) dest.delete();
    new File(uri).copySync(dest);
    return dest.uri;
  } catch {
    return uri;
  }
}

/** Delete everything kept for this outbox item. Safe to call more than once. */
export function discardOutboxFiles(itemId: string): void {
  try {
    const dir = folderFor(itemId);
    if (dir.exists) dir.delete();
  } catch {
    // best effort — a leftover file only costs a little local space
  }
}

/** Whether a kept file is still on disk (the OS never removes document files, but a
 *  restore from backup or a manual clear could). */
export function outboxFileExists(uri: string): boolean {
  try {
    return uri.startsWith('file://') ? new File(uri).exists : true;
  } catch {
    return false;
  }
}
