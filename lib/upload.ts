import { File } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { Platform } from 'react-native';
import { Video } from 'react-native-compressor';

import { isOnline } from '@/lib/connectivity';
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from '@/lib/supabase';
import { findOrCreateTag } from '@/lib/tags';
import type { VideoOverlay } from '@/lib/video-overlays';

// The pipeline's in-edge decode budget (see media-pipeline config). Downscale images
// past this before upload so full-res phone photos aren't rejected. Note: re-encoding
// here drops EXIF, so GPS suggestions are only available for images already within
// budget; larger images upload successfully but without a location suggestion.
const CLIENT_MAX_EDGE = 2048; // longest edge → ≤ ~4 MP for typical aspect ratios
const CLIENT_MAX_PIXELS = 4_000_000;

// Videos are shrunk on the phone before upload: phone clips are often 4K/60fps at
// 40+ Mbps (a 60 s clip can be 100–400 MB), but the pipeline can only take ~45 MB
// (storage upload limit + edge memory). 1080p at 5 Mbps keeps a 60 s clip ≈ 40 MB,
// and the server re-encodes to its own 1080p/30fps/6 Mbps ceiling anyway, so nothing
// visible is lost. Metadata (incl. GPS) is dropped on the device.
const VIDEO_MAX_EDGE = 1920;
const VIDEO_BITRATE = 5_000_000;
// Matches MEDIA_MAX_VIDEO_BYTES in the media pipeline.
const CLIENT_MAX_VIDEO_BYTES = 45 * 1024 * 1024;
// Share of the progress bar spent compressing (the rest is the upload).
const COMPRESS_SHARE = 0.4;

// Shape returned by the media-pipeline Edge Function.
export type TagSuggestion = {
  name: string;
  confidence?: number;
  source: 'vision' | 'geo';
  tag_id: string | null;
};

export type PipelineResult = {
  media_type: 'image' | 'video';
  media_url: string; // object key in the private `media` bucket
  thumbnail_url: string;
  moderation_status: 'approved' | 'flagged' | 'pending' | 'removed';
  width: number;
  height: number;
  duration_seconds?: number;
  suggestions: {
    gps: { latitude: number; longitude: number } | null;
    taken_at: string | null;
    location_cell: string | null;
    labels: TagSuggestion[];
    places: TagSuggestion[];
  };
};

export type PickedMedia = {
  uri: string;
  type: 'image' | 'video';
  mime: string;
  fileName?: string;
  width?: number;
  height?: number;
};

function fileSize(uri: string): number | null {
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? uri : `file://${uri}`;
    return new File(withScheme).size;
  } catch {
    return null;
  }
}

/**
 * Get media ready for the pipeline. Oversized images are downscaled to fit its decode
 * budget (EXIF is dropped by the re-encode). Videos are compressed to 1080p / 5 Mbps on
 * the device and must then fit CLIENT_MAX_VIDEO_BYTES. Small images pass through.
 */
export async function prepareForUpload(
  media: PickedMedia,
  onProgress?: (fraction: number) => void,
): Promise<PickedMedia> {
  if (media.type === 'video') return prepareVideo(media, onProgress);
  const pixels = (media.width ?? 0) * (media.height ?? 0);
  const longest = Math.max(media.width ?? 0, media.height ?? 0);
  if (pixels && pixels <= CLIENT_MAX_PIXELS && longest <= CLIENT_MAX_EDGE) return media;

  const ctx = ImageManipulator.ImageManipulator.manipulate(media.uri);
  ctx.resize(
    media.width && media.height && media.width >= media.height
      ? { width: CLIENT_MAX_EDGE }
      : { height: CLIENT_MAX_EDGE },
  );
  const ref = await ctx.renderAsync();
  const out = await ref.saveAsync({ compress: 0.9, format: ImageManipulator.SaveFormat.JPEG });
  return { ...media, uri: out.uri, mime: 'image/jpeg', fileName: 'upload.jpg' };
}

async function prepareVideo(
  media: PickedMedia,
  onProgress?: (fraction: number) => void,
): Promise<PickedMedia> {
  // The browser build has no native compressor; the server's size check still applies.
  if (Platform.OS === 'web') return media;
  let out = media;
  try {
    const uri = await Video.compress(
      media.uri,
      { compressionMethod: 'manual', maxSize: VIDEO_MAX_EDGE, bitrate: VIDEO_BITRATE, preserveMetadata: false },
      (p) => onProgress?.(Math.min(1, Math.max(0, p))),
    );
    out = { ...media, uri, mime: 'video/mp4', fileName: 'upload.mp4' };
  } catch {
    // Compression failed: fall back to the original if it's small enough to send.
  }
  const size = fileSize(out.uri);
  if (size != null && size > CLIENT_MAX_VIDEO_BYTES) {
    throw new UploadFailed(
      `This video is too large to upload (max ${Math.round(CLIENT_MAX_VIDEO_BYTES / 1048576)} MB). Try a shorter clip.`,
      false,
    );
  }
  return out;
}

// A rejection by the adult-content scan is a normal outcome, not a thrown error.
export class UploadRejected extends Error {}
// Everything else. `retryable` is true for no-connection / timeout / server hiccups (worth
// trying again later, e.g. from the outbox) and false when the server refused the file
// itself (too large, unsupported) — retrying that would fail the same way forever.
export class UploadFailed extends Error {
  retryable: boolean;
  constructor(message: string, retryable = true) {
    super(message);
    this.retryable = retryable;
  }
}

/**
 * Upload media to the processing pipeline via XHR so we get real upload progress
 * (fetch gives none). Resolves with the pipeline result, throws UploadRejected for a
 * content-scan rejection, or UploadFailed for anything retryable.
 */
export function uploadToPipeline(
  media: PickedMedia,
  onProgress: (fraction: number) => void,
  signal?: { aborted: boolean; onAbort: (cb: () => void) => void },
): Promise<PipelineResult> {
  return new Promise(async (resolve, reject) => {
    // Fail fast with no signal rather than waiting out the 2-minute upload timeout.
    if (!isOnline()) return reject(new UploadFailed('No connection.'));
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return reject(new UploadFailed('Not signed in.'));

    // Videos spend the first part of the progress bar compressing on the device.
    const share = media.type === 'video' && Platform.OS !== 'web' ? COMPRESS_SHARE : 0;
    let prepared: PickedMedia;
    try {
      prepared = await prepareForUpload(media, (f) => onProgress(f * share));
    } catch (e) {
      if (e instanceof UploadFailed) return reject(e);
      return reject(
        new UploadFailed(`Could not prepare the ${media.type === 'video' ? 'video' : 'image'} for upload.`),
      );
    }

    const filename = prepared.fileName ?? `upload.${prepared.type === 'video' ? 'mp4' : 'jpg'}`;
    const form = new FormData();
    if (Platform.OS === 'web') {
      // Browser FormData needs a real Blob/File — the RN {uri,name,type} object doesn't
      // carry bytes. Fetch the picked blob:/data: URL into a Blob and append that.
      try {
        const blob = await fetch(prepared.uri).then((r) => r.blob());
        form.append('file', blob, filename);
      } catch {
        return reject(new UploadFailed('Could not read the selected file.'));
      }
    } else {
      // React Native FormData file part.
      form.append('file', {
        uri: prepared.uri,
        name: filename,
        type: prepared.mime,
      } as unknown as Blob);
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${SUPABASE_URL}/functions/v1/media-pipeline`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.min(0.99, share + (1 - share) * (e.loaded / e.total)));
    };
    xhr.onload = () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // fall through to status handling
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve(body as unknown as PipelineResult);
      } else if (xhr.status === 422 && body.error === 'rejected') {
        reject(new UploadRejected(String(body.reason ?? 'content_policy')));
      } else if (xhr.status === 413) {
        reject(new UploadFailed(String(body.message ?? 'That file is too large to process.'), false));
      } else {
        // 4xx (other than auth/rate limits) means the server refused this file for good.
        const permanent =
          xhr.status >= 400 && xhr.status < 500 && ![401, 408, 429].includes(xhr.status);
        reject(new UploadFailed(String(body.message ?? `Upload failed (${xhr.status}).`), !permanent));
      }
    };
    xhr.onerror = () => reject(new UploadFailed('Network error during upload.'));
    xhr.ontimeout = () => reject(new UploadFailed('Upload timed out.'));
    xhr.timeout = 120000;
    signal?.onAbort(() => xhr.abort());
    xhr.send(form);
  });
}

export type CreatePostInput = {
  /** Client-generated post id. Set by the offline outbox so a retry after a lost response
   *  finds the post it already created instead of publishing a second copy. */
  id?: string;
  result: PipelineResult;
  /** Carousel extras (already pipeline-processed), in display order after the cover. */
  extras?: PipelineResult[];
  caption: string;
  altText: string;
  visibility: 'public' | 'private' | 'groups';
  /** Required when visibility is 'groups': the audience groups to share with. */
  groupIds?: string[];
  attachLocation: boolean;
  /** Coarse cell chosen client-side (device GPS / picked venue). Falls back to the
   *  pipeline's EXIF-derived cell when null. */
  locationCell?: string | null;
  /** Display name of the picked place ("Camden Market"); shown on the post (#61/#65).
   *  Stored only when attachLocation is on, like the cell. */
  locationLabel?: string | null;
  // Tags the user confirmed, split by provenance. Names are raw; resolved here.
  tags: { name: string; source: 'user' | 'vision' | 'geo' }[];
  /** Video overlays (normalised); stored as jsonb and drawn at playback. */
  overlays?: VideoOverlay[];
};

/**
 * Persist the post the pipeline already processed: insert the row with the media keys,
 * resolve/attach tags with their provenance, and store the coarse location cell only if
 * the user opted in. The post's moderation_status is NOT set here — the client can't set
 * it; a BEFORE-INSERT trigger stamps the pipeline's verdict (see the
 * post_moderation_verdict migration). Returns the new post id.
 */
export async function createPost(input: CreatePostInput): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error('Not signed in.');

  const { result } = input;
  // With a client id, every step below is one atomic insert; a unique violation on retry
  // means that step already landed on an earlier attempt, so it is skipped.
  const alreadyDone = (e: { code?: string } | null) => !!input.id && e?.code === '23505';
  const { data: post, error } = await supabase
    .from('posts')
    .insert({
      ...(input.id ? { id: input.id } : {}),
      user_id: uid,
      media_url: result.media_url,
      thumbnail_url: result.thumbnail_url,
      media_type: result.media_type,
      caption: input.caption.trim() || null,
      alt_text: input.altText.trim() || null,
      visibility: input.visibility,
      // Only the coarse cell, only if opted in — never raw coordinates. Prefer the
      // client-chosen cell (device GPS / picked venue), else the EXIF-derived one.
      location_cell: input.attachLocation
        ? (input.locationCell ?? result.suggestions.location_cell ?? null)
        : null,
      location_label: input.attachLocation ? (input.locationLabel?.trim() || null) : null,
      overlays: input.overlays ?? [],
    })
    .select('id')
    .single();
  if (error && !alreadyDone(error)) throw error;
  const postId = input.id ?? (post as { id: string }).id;

  // Group audience: attach the chosen groups right away. Until these rows land
  // a 'groups' post is visible to nobody but the owner (safe failure mode).
  if (input.visibility === 'groups') {
    if (!input.groupIds?.length) throw new Error('Pick at least one group.');
    const { setPostGroups } = await import('@/lib/groups');
    try {
      await setPostGroups(postId, input.groupIds);
    } catch (e) {
      if (!alreadyDone(e as { code?: string })) throw e;
    }
  }

  // Carousel extras: one row per additional media item. Each consumed its own
  // pipeline verdict via the post_media trigger (a bad extra downgrades the post).
  if (input.extras?.length) {
    const { error: mediaErr } = await supabase.from('post_media').insert(
      input.extras.map((r, i) => ({
        post_id: postId,
        position: i + 1,
        media_url: r.media_url,
        thumbnail_url: r.thumbnail_url,
        media_type: r.media_type,
      })),
    );
    if (mediaErr && !alreadyDone(mediaErr)) throw mediaErr;
  }

  // Resolve tag names → ids (find-or-create), then attach with provenance.
  const resolved = await Promise.all(
    input.tags.map(async (t) => ({ tag: await findOrCreateTag(t.name), source: t.source })),
  );
  const rows = dedupeByTag(resolved).map((r) => ({
    post_id: postId,
    tag_id: r.tag.id,
    source: r.source,
  }));
  if (rows.length) {
    const { error: tagErr } = await supabase.from('post_tags').insert(rows);
    if (tagErr && !alreadyDone(tagErr)) throw tagErr;
  }
  return postId;
}

function dedupeByTag(items: { tag: { id: string }; source: 'user' | 'vision' | 'geo' }[]) {
  const seen = new Set<string>();
  const out: typeof items = [];
  for (const it of items) {
    if (seen.has(it.tag.id)) continue;
    seen.add(it.tag.id);
    out.push(it);
  }
  return out;
}
