import { supabase } from '@/lib/supabase';

/**
 * Client-visible platform settings (Part 1A). The server exposes ONLY keys
 * marked client_visible through get_client_settings(); tuning values the app
 * must not know (bot thresholds etc.) never arrive here.
 *
 * Cached in memory with a TTL so the app reads settings roughly once per
 * launch, not per screen. Falls back to the shipped defaults offline.
 */
export type ClientSettings = Record<string, unknown>;

/** Shipped fallbacks, used before the first fetch or when offline. */
const DEFAULTS: ClientSettings = {
  view_event_batch_size: 10,
  view_event_flush_ms: 15000,
};

const TTL_MS = 5 * 60 * 1000;

let cache: { value: ClientSettings; fetchedAt: number } | null = null;
let inFlight: Promise<ClientSettings> | null = null;

export async function getClientSettings(): Promise<ClientSettings> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.value;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const { data, error } = await supabase.rpc('get_client_settings');
      if (error) throw error;
      const value = { ...DEFAULTS, ...((data ?? {}) as ClientSettings) };
      cache = { value, fetchedAt: Date.now() };
      return value;
    } catch {
      // Offline / error: serve the stale cache if any, else defaults.
      return cache?.value ?? DEFAULTS;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Read one numeric setting, tolerating missing/odd values. */
export function settingNumber(
  settings: ClientSettings,
  key: string,
  fallback: number,
): number {
  const v = settings[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
