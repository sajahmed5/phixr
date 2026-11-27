// ============================================================================
// config.ts — all tunables come from the environment, never magic numbers in
// code and never secrets in code. Thresholds have safe defaults; secrets have
// none (absence is handled explicitly by the pipeline, fail-safe).
//
// Deploy-time configuration (supabase secrets set ...):
//   Secrets (no default):
//     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY   (injected)
//     GOOGLE_VISION_API_KEY            adult scan + labels (Google Cloud Vision)
//   Vision:
//     VISION_PROVIDER                 'google' (default) | 'none'
//   Moderation thresholds (Vision likelihood 0..5:
//       UNKNOWN=0 VERY_UNLIKELY=1 UNLIKELY=2 POSSIBLE=3 LIKELY=4 VERY_LIKELY=5)
//     MODERATION_ADULT_REJECT_AT      default 5  (>= → reject outright)
//     MODERATION_ADULT_FLAG_AT        default 4  (>= → moderation_status flagged)
//     MODERATION_RACY_FLAG_AT         default 5  (racy alone only flags at 5)
//     MODERATION_VIOLENCE_REJECT_AT   default 5
//   Limits:
//     MEDIA_MAX_IMAGE_BYTES           default 15728640  (15 MB)
//     MEDIA_MAX_VIDEO_BYTES           default 104857600 (100 MB)
//     MEDIA_MAX_VIDEO_SECONDS         default 60
//     MEDIA_UPLOADS_PER_HOUR          default 20
//   Tagging:
//     LABEL_MIN_CONFIDENCE            default 0.60
//     LABEL_MAX_SUGGESTIONS           default 10 (after rules; landmarks count)
//     VISION_LANDMARKS                default 'on' | 'off' (Vision LANDMARK_DETECTION)
//     LANDMARK_MIN_CONFIDENCE         default 0.50
//     LANDMARK_MAX_RESULTS            default 2
//     TAG_RULES_CACHE_SECONDS         default 300 (public.tag_label_rules, per isolate)
//     LOCATION_GRID_PRECISION         default 5  (geohash length ≈ ±2.4 km)
//   Images:
//     IMAGE_FORMAT                    default 'webp' | 'jpeg' (stored display + thumbnail)
//     IMAGE_WEBP_QUALITY              default 75 (≈ JPEG 82 quality, 10–15% smaller)
//     IMAGE_WEBP_THUMB_QUALITY        default 70
// ============================================================================

function num(name: string, def: number): number {
  const v = Deno.env.get(name);
  if (v === undefined || v.trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function str(name: string, def: string): string {
  const v = Deno.env.get(name);
  return v === undefined || v.trim() === '' ? def : v.trim();
}

export const config = {
  visionProvider: str('VISION_PROVIDER', 'google') as 'google' | 'none',
  googleVisionApiKey: Deno.env.get('GOOGLE_VISION_API_KEY') ?? '',

  moderation: {
    adultRejectAt: num('MODERATION_ADULT_REJECT_AT', 5),
    adultFlagAt: num('MODERATION_ADULT_FLAG_AT', 4),
    racyFlagAt: num('MODERATION_RACY_FLAG_AT', 5),
    violenceRejectAt: num('MODERATION_VIOLENCE_REJECT_AT', 5),
  },

  limits: {
    maxImageBytes: num('MEDIA_MAX_IMAGE_BYTES', 15 * 1024 * 1024),
    // Decoding to raw RGBA costs ~4 bytes/pixel; a Deno edge isolate cannot hold
    // a full-res phone photo (an 18 MP HEIC → ~73 MB RGBA) plus the encoder heap.
    // Over this budget we reject with guidance (the client downscales, or route
    // to the external worker) rather than crash the isolate. Empirically the
    // Supabase edge isolate handles ~4.5 MP and OOMs by ~6 MP, so 4 leaves margin
    // (HEIC decode via libheif is heavier than JPEG). Tune per memory tier.
    maxImageMegapixels: num('MEDIA_MAX_IMAGE_MEGAPIXELS', 4),
    maxVideoBytes: num('MEDIA_MAX_VIDEO_BYTES', 100 * 1024 * 1024),
    maxVideoSeconds: num('MEDIA_MAX_VIDEO_SECONDS', 60),
    uploadsPerHour: num('MEDIA_UPLOADS_PER_HOUR', 20),
  },

  tagging: {
    labelMinConfidence: num('LABEL_MIN_CONFIDENCE', 0.6),
    labelMaxSuggestions: num('LABEL_MAX_SUGGESTIONS', 10),
    landmarksEnabled: str('VISION_LANDMARKS', 'on') !== 'off',
    landmarkMinConfidence: num('LANDMARK_MIN_CONFIDENCE', 0.5),
    landmarkMaxResults: num('LANDMARK_MAX_RESULTS', 2),
    tagRulesCacheSeconds: num('TAG_RULES_CACHE_SECONDS', 300),
    // Uselessly generic labels that carry no signal — filtered from suggestions.
    // Baseline only: admins tune the rest in public.tag_label_rules (fame-admin).
    genericLabelDenylist: new Set([
      'photograph', 'image', 'photography', 'picture', 'photo', 'screenshot',
      'font', 'material property', 'rectangle', 'still life photography',
    ]),
    locationGridPrecision: num('LOCATION_GRID_PRECISION', 5),
  },

  // Display/thumbnail sizes (longest edge, px). Fixed, sensible defaults.
  // WebP qualities were picked by SSIM against JPEG 82/75 on real uploads
  // (2026-11-27): equal or better quality at 6–18% fewer bytes.
  image: {
    format: (str('IMAGE_FORMAT', 'webp') === 'jpeg' ? 'jpeg' : 'webp') as 'webp' | 'jpeg',
    displayMaxEdge: 1440,
    thumbnailMaxEdge: 400,
    displayQuality: 82,
    thumbnailQuality: 75,
    webpDisplayQuality: num('IMAGE_WEBP_QUALITY', 75),
    webpThumbnailQuality: num('IMAGE_WEBP_THUMB_QUALITY', 70),
  },
} as const;

export type ModerationStatus = 'approved' | 'flagged' | 'pending' | 'removed';
