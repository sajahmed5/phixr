// ============================================================================
// image.ts — PIPELINE STEP 3 (EXIF STRIP) + STEP 6 (transcode/resize) for images.
//
// STRIP MECHANISM: we decode the image to raw pixels and RE-ENCODE it. A
// re-encode carries over pixel data only — every ancillary block (EXIF, XMP,
// ICC, MakerNotes, thumbnails) is dropped by construction. This is stronger
// than asking a library to "remove EXIF", which can miss XMP/ICC-embedded
// location. We then VERIFY the output really is clean (verifyStripped) rather
// than trusting the encoder.
//
// All codecs are WASM (jSquash) so this runs unchanged in the Deno edge runtime
// and in a local `deno run` harness (see scripts/verify-exif-strip.ts).
// ============================================================================
import { decode as decodeJpeg, encode as encodeJpeg } from 'npm:@jsquash/jpeg@1.6.0';
import { decode as decodePng } from 'npm:@jsquash/png@3.1.1';
import { decode as decodeWebp, encode as encodeWebp } from 'npm:@jsquash/webp@1.5.0';
import resize from 'npm:@jsquash/resize@2.1.0';
import heicDecode from 'npm:heic-decode@2.0.0';
import exifr from 'npm:exifr@7.1.3';

import { config } from './config.ts';

export type ProcessedImage = {
  display: Uint8Array; // stripped, resized display image (WebP or JPEG per config)
  thumbnail: Uint8Array; // stripped, resized thumbnail, same format
  width: number; // display dimensions
  height: number;
  mime: 'image/webp' | 'image/jpeg';
  ext: 'webp' | 'jpg';
};

async function decodeAny(bytes: Uint8Array, mime: string): Promise<ImageData> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  if (mime === 'image/jpeg') return await decodeJpeg(buf);
  if (mime === 'image/png') return await decodePng(buf);
  if (mime === 'image/webp') return await decodeWebp(buf);
  if (mime === 'image/heic') {
    // iPhone HEIC → RGBA via libheif (WASM). Re-encoded to JPEG below, so the
    // HEIC's EXIF/GPS never survives into the stored file.
    const { width, height, data } = await heicDecode({ buffer: bytes });
    return { data: new Uint8ClampedArray(data), width, height, colorSpace: 'srgb' } as ImageData;
  }
  throw new Error(`image decode: unsupported mime ${mime}`);
}

function fit(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

async function encodeSized(
  img: ImageData,
  maxEdge: number,
  format: 'webp' | 'jpeg',
  quality: number,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const target = fit(img.width, img.height, maxEdge);
  const sized = target.width === img.width && target.height === img.height
    ? img
    : await resize(img, { width: target.width, height: target.height });
  const out = format === 'webp'
    ? await encodeWebp(sized, { quality })
    : await encodeJpeg(sized, { quality });
  return { bytes: new Uint8Array(out), width: sized.width, height: sized.height };
}

/** Decode → strip (via re-encode) → produce display + thumbnail (WebP by default). */
export async function processImage(bytes: Uint8Array, mime: string): Promise<ProcessedImage> {
  const decoded = await decodeAny(bytes, mime);
  const c = config.image;
  const webp = c.format === 'webp';
  const display = await encodeSized(decoded, c.displayMaxEdge, c.format, webp ? c.webpDisplayQuality : c.displayQuality);
  const thumb = await encodeSized(decoded, c.thumbnailMaxEdge, c.format, webp ? c.webpThumbnailQuality : c.thumbnailQuality);
  return {
    display: display.bytes,
    thumbnail: thumb.bytes,
    width: display.width,
    height: display.height,
    mime: webp ? 'image/webp' : 'image/jpeg',
    ext: webp ? 'webp' : 'jpg',
  };
}

/** True if a WebP file carries any metadata chunk (EXIF, XMP or ICC profile). */
function webpHasMetadata(b: Uint8Array): boolean {
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (b.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return false;
  for (let o = 12; o + 8 <= b.length;) {
    const id = tag(o);
    if (id === 'EXIF' || id === 'XMP ' || id === 'ICCP') return true;
    const size = b[o + 4] | (b[o + 5] << 8) | (b[o + 6] << 16) | (b[o + 7] << 24);
    o += 8 + size + (size & 1);
  }
  return false;
}

/**
 * STEP 3 VERIFICATION — assert the processed bytes carry no recoverable
 * metadata. Throws if any GPS/EXIF/XMP survives, so a failure aborts the
 * pipeline (fail-closed) instead of serving a leaky file.
 */
export async function verifyStripped(bytes: Uint8Array): Promise<void> {
  if (webpHasMetadata(bytes)) {
    throw new Error('strip verification failed: metadata chunk present in WebP output');
  }
  const gps = await exifr.gps(bytes).catch(() => null);
  if (gps && (gps.latitude != null || gps.longitude != null)) {
    throw new Error('strip verification failed: GPS still present after re-encode');
  }
  const parsed = await exifr.parse(bytes, true).catch(() => null);
  if (parsed && (parsed.latitude != null || parsed.GPSLatitude != null ||
      parsed.Make != null || parsed.Model != null || parsed.DateTimeOriginal != null)) {
    throw new Error('strip verification failed: EXIF tags still present after re-encode');
  }
}
