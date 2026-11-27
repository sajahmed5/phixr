import type { Href } from 'expo-router';

import { supabase } from '@/lib/supabase';

/**
 * Where a post was, as far as the app may say (27 Nov, Saj: "I see this image,
 * I click on the location, and I think let me take my dog there").
 *
 * The label comes from get_post_places: the place the poster picked, else the
 * tagged venue's name, else the photo's own place tags ("Lymm, England").
 * A place resolves to a VENUE (exact) or an AREA cell (~5km, never finer).
 */
export type PostPlace = {
  label: string;
  venueId: string | null;
  cell: string | null;
  isBusiness: boolean;
};

type PlaceRow = {
  post_id: string;
  label: string | null;
  venue_id: string | null;
  cell: string | null;
  is_business: boolean;
};

/** Places for a batch of posts, keyed by post id. Posts with nothing to say are absent. */
export async function getPostPlaces(ids: string[]): Promise<Map<string, PostPlace>> {
  const out = new Map<string, PostPlace>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase.rpc('get_post_places', { _ids: ids });
  if (error) throw error;
  for (const r of (data ?? []) as PlaceRow[]) {
    // A label with nowhere to go (no venue, no cell) still informs, but a
    // place page needs one of the two to load anything.
    if (r.label) {
      out.set(r.post_id, {
        label: r.label,
        venueId: r.venue_id,
        cell: r.cell,
        isBusiness: !!r.is_business,
      });
    }
  }
  return out;
}

/** True when the place page has something to show for this place. */
export function isOpenablePlace(p: PostPlace): boolean {
  return !!(p.venueId || p.cell);
}

/** Route to the place page. Venue wins over area: it is exact. */
export function placeHref(p: PostPlace): Href {
  return {
    pathname: '/place',
    params: p.venueId
      ? { venue: p.venueId, label: p.label }
      : { cell: p.cell ?? '', label: p.label },
  };
}

/** Route to one part of a venue (Stage 3): its posts in that ~300m square. */
export function venuePartHref(venueId: string, cell: string, label: string): Href {
  return { pathname: '/place', params: { venue: venueId, cell, label } };
}

export type PlacePost = {
  id: string;
  user_id: string;
  thumbnail_url: string;
  media_type: 'image' | 'video';
  like_count: number;
  created_at: string;
};

export async function getPlacePosts(
  where: { venueId?: string | null; cell?: string | null },
  limit = 60,
): Promise<PlacePost[]> {
  const { data, error } = await supabase.rpc('get_place_posts', {
    _venue_id: where.venueId ?? null,
    _cell: where.venueId ? null : (where.cell ?? null),
    _limit: limit,
    _offset: 0,
  });
  if (error) throw error;
  return (data ?? []) as PlacePost[];
}

/** "27 November", plus the year when it isn't this year. The posted date (Saj's choice). */
export function formatPostDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}
