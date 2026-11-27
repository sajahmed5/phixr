import { coarseCell } from '@/lib/location';

/**
 * "Be the first to post here" (Local map Stage 2): the map hands a place to
 * the next composition, which starts with it already tagged. In-memory and
 * short-lived, so a place picked and then abandoned never lands on an
 * unrelated post later.
 */
export type PlaceRef = { provider: string; provider_place_id: string };

type Pending = { name: string; lat: number; lon: number; ref: PlaceRef; at: number };

const TTL_MS = 10 * 60 * 1000;
let pending: Pending | null = null;

export function setPendingPlace(p: { name: string; lat: number; lon: number; ref: PlaceRef }): void {
  pending = { ...p, at: Date.now() };
}

/** Consume the pending place as draft location fields, or null if none/expired. */
export function takePendingPlace(): {
  attachLocation: true;
  locationCell: string;
  locationLabel: string;
  placeRef: PlaceRef;
} | null {
  const p = pending;
  pending = null;
  if (!p || Date.now() - p.at > TTL_MS) return null;
  return { attachLocation: true, locationCell: coarseCell(p.lat, p.lon), locationLabel: p.name, placeRef: p.ref };
}
