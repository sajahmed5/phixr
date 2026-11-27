/**
 * Location helpers for attaching a place to a post.
 *
 * Privacy: we only ever store a COARSE geohash cell (precision 5 ≈ 5 km), never exact
 * coordinates — matching the server's `coarseLocationCell`. The device's precise position
 * is used transiently to (a) find nearby public venues to pick from, and (b) derive that
 * coarse cell; it is never persisted.
 */
import * as Location from 'expo-location';

import { supabase } from '@/lib/supabase';

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const CELL_PRECISION = 5; // ~5km cell, matches the media pipeline

/** Standard geohash encoder (same algorithm as the server). */
export function geohashEncode(lat: number, lon: number, precision: number): string {
  let idx = 0;
  let bit = 0;
  let even = true;
  let hash = '';
  const latR = [-90, 90];
  const lonR = [-180, 180];
  while (hash.length < precision) {
    if (even) {
      const mid = (lonR[0] + lonR[1]) / 2;
      if (lon >= mid) {
        idx = (idx << 1) + 1;
        lonR[0] = mid;
      } else {
        idx = idx << 1;
        lonR[1] = mid;
      }
    } else {
      const mid = (latR[0] + latR[1]) / 2;
      if (lat >= mid) {
        idx = (idx << 1) + 1;
        latR[0] = mid;
      } else {
        idx = idx << 1;
        latR[1] = mid;
      }
    }
    even = !even;
    if (bit < 4) {
      bit++;
    } else {
      hash += BASE32[idx];
      bit = 0;
      idx = 0;
    }
  }
  return hash;
}

/** The coarse cell we may store — never precise coordinates. The `gh5:` prefix
 *  matches the media pipeline and `local_cells()`; without it Local search can
 *  never match the post (feedback #69 — picker-located posts were invisible). */
export function coarseCell(lat: number, lon: number): string {
  return `gh${CELL_PRECISION}:` + geohashEncode(lat, lon, CELL_PRECISION);
}

/**
 * Decode a stored cell ('gh5:gcw2n') back to its centre, for placing cluster
 * pins on the Local map (#71). Inverse of geohashEncode; coarse by design.
 */
export function decodeCell(cell: string): { lat: number; lon: number } | null {
  const hash = cell.includes(':') ? cell.split(':')[1] : cell;
  if (!hash) return null;
  let latLo = -90, latHi = 90, lonLo = -180, lonHi = 180;
  let even = true;
  for (const ch of hash) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) return null;
    for (let bit = 4; bit >= 0; bit--) {
      const on = (idx >> bit) & 1;
      if (even) {
        const mid = (lonLo + lonHi) / 2;
        if (on) lonLo = mid;
        else lonHi = mid;
      } else {
        const mid = (latLo + latHi) / 2;
        if (on) latLo = mid;
        else latHi = mid;
      }
      even = !even;
    }
  }
  return { lat: (latLo + latHi) / 2, lon: (lonLo + lonHi) / 2 };
}

/** Request permission + read the device's current position. Returns null if denied. */
export async function getCurrentCoords(): Promise<{ lat: number; lon: number } | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { lat: pos.coords.latitude, lon: pos.coords.longitude };
  } catch {
    return null;
  }
}

export type NearbyPlace = {
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  /** metres from the search origin, when known. */
  distanceM: number | null;
  /** Provider identity — needed to claim the place as a business (Part 7C)
   *  and to link a post to the venue (Stage 2). */
  provider: string | null;
  provider_place_id: string | null;
  category: string | null;
};

/**
 * Public venues from the places proxy (Google, server-side). With no `query` it returns
 * what's physically nearby; with a `query` it text-searches (a shop, restaurant, city or
 * country), biased toward the origin — this powers the picker's search box.
 */
export async function nearbyPlaces(lat: number, lon: number, query?: string): Promise<NearbyPlace[]> {
  const { data, error } = await supabase.functions.invoke('places', {
    body: { action: 'nearby', lat, lon, ...(query ? { query } : {}), limit: 15 },
  });
  if (error) return [];
  const venues = ((data as { venues?: unknown[] })?.venues ?? []) as {
    name?: string;
    address?: string | null;
    lat?: number | null;
    lon?: number | null;
    distance_m?: number | null;
    provider?: string | null;
    provider_place_id?: string | null;
    category?: string | null;
  }[];
  return venues
    .filter((v) => v.name && v.lat != null && v.lon != null)
    .map((v) => ({
      name: v.name as string,
      address: v.address ?? null,
      lat: v.lat as number,
      lon: v.lon as number,
      distanceM: v.distance_m ?? null,
      provider: v.provider ?? null,
      provider_place_id: v.provider_place_id ?? null,
      category: v.category ?? null,
    }));
}
