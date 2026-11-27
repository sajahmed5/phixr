// ============================================================================
// places — venue/place backend. See docs/venue-tagging-design.md and the Local
// map Stage 2 plan (agreed 2026-11-27).
//
// Actions, all authenticated + rate-limited:
//   nearby  { lat, lon, query?, limit? } → nearby public venues (picker proxy)
//   geocode { query, limit? }            → cities/areas for the search centre
//   attach  { postId, provider?, provider_place_id } → find-or-create the venue
//           from authoritative place details and set posts.venue_id
//   suggest { query?, category?, north, south, east, west } → real places in a
//           street-zoom viewport for the Local map's hollow "be the first" pins,
//           each linked to an existing venue (and its photo count) when one exists
//
// Provider: the map's `suggest` is always Apple (Maps Server API). The picker,
// geocode and business claiming follow PLACES_PROVIDER: builds before Stage 2
// claim places without naming a provider (it defaults to 'google'), so flip
// PLACES_PROVIDER to 'apple' only once those builds are retired. `attach`
// takes the provider the client names. Keys stay SERVER-SIDE.
// We store the public venue, never the caller's raw GPS. Venue tagging is
// refused for minors (also a DB trigger backstop).
// ============================================================================
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

import { reportError, withSentry } from '../_shared/sentry.ts';

const GOOGLE_KEY = Deno.env.get('GOOGLE_PLACES_API_KEY') ?? '';
const APPLE_TEAM_ID = Deno.env.get('APPLE_MAPS_TEAM_ID') ?? '';
const APPLE_KEY_ID = Deno.env.get('APPLE_MAPS_KEY_ID') ?? '';
const APPLE_PRIVATE_KEY = Deno.env.get('APPLE_MAPS_PRIVATE_KEY') ?? '';
const APPLE_READY = !!(APPLE_TEAM_ID && APPLE_KEY_ID && APPLE_PRIVATE_KEY);
const PROVIDER = Deno.env.get('PLACES_PROVIDER') ?? (APPLE_READY ? 'apple' : 'google');
const RATE_MAX = Number(Deno.env.get('PLACES_CALLS_PER_HOUR') ?? 120);
const GEOHASH_PRECISION = 5;
/** Suggest results are reused this long per (query, snapped viewport). */
const SUGGEST_CACHE_MS = 6 * 60 * 60 * 1000;
/** Widest viewport `suggest` serves — street zoom only, by design. */
const SUGGEST_MAX_SPAN_DEG = 0.1;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  // apikey / x-client-info are sent by supabase-js in the browser; allow them so the web
  // client's CORS preflight passes.
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'content-type': 'application/json' } });

type Bounds = { north: number; south: number; east: number; west: number };
type Candidate = {
  provider: string; provider_place_id: string; name: string; category: string | null; address: string | null;
  lat: number | null; lon: number | null; distance_m: number | null;
  /** The place's real area (Apple displayMapRegion / Google viewport), when known. */
  extent?: Bounds | null;
};

// ---- Apple Maps Server API -------------------------------------------------
// A developer token (ES256 JWT signed with the MapKit key) is exchanged for a
// 30-minute access token, cached per isolate.
let appleToken: { value: string; expiresAt: number } | null = null;

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function appleAccessToken(): Promise<string> {
  if (appleToken && appleToken.expiresAt > Date.now() + 60_000) return appleToken.value;
  const pem = APPLE_PRIVATE_KEY.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64url(JSON.stringify({ alg: 'ES256', kid: APPLE_KEY_ID, typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: APPLE_TEAM_ID, iat: now, exp: now + 600 }))}`;
  // WebCrypto ECDSA signatures are already raw r||s, which is what JWS ES256 wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input)));
  const res = await fetch('https://maps-api.apple.com/v1/token', { headers: { Authorization: `Bearer ${input}.${b64url(sig)}` } });
  if (!res.ok) throw new Error(`apple token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  appleToken = { value: String(j.accessToken), expiresAt: Date.now() + Number(j.expiresInSeconds ?? 1800) * 1000 };
  return appleToken.value;
}

async function appleGet(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const url = `https://maps-api.apple.com${path}?${new URLSearchParams({ lang: 'en-GB', ...params })}`;
  const call = async () => fetch(url, { headers: { Authorization: `Bearer ${await appleAccessToken()}` } });
  let res = await call();
  if (res.status === 401) {
    appleToken = null;
    res = await call();
  }
  if (!res.ok) throw new Error(`apple ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.json();
}

type AppleResult = {
  id?: string;
  alternateIds?: string[];
  name?: string;
  coordinate?: { latitude?: number; longitude?: number };
  displayMapRegion?: { northLatitude?: number; southLatitude?: number; eastLongitude?: number; westLongitude?: number };
  formattedAddressLines?: string[];
  poiCategory?: string;
};

// Apple's poiCategory is PascalCase ("NationalPark"); the DB's category groups
// (venue_category_group) match Google-style snake_case types, which most Apple
// categories become directly. These are the ones that don't.
const APPLE_CATEGORY: Record<string, string> = {
  Nightlife: 'night_club',
  FoodMarket: 'grocery_store',
  FitnessCenter: 'gym',
  Theater: 'event_venue',
  Beach: 'tourist_attraction',
  Landmark: 'tourist_attraction',
  Castle: 'tourist_attraction',
  Fortress: 'tourist_attraction',
  Planetarium: 'tourist_attraction',
};
function appleCategory(c: string | undefined): string | null {
  if (!c) return null;
  return APPLE_CATEGORY[c] ?? c.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Some Apple results pack several address lines into one string with newlines. */
const addressLines = (r: AppleResult) =>
  (r.formattedAddressLines ?? []).flatMap((l) => l.split('\n')).map((l) => l.trim()).filter(Boolean);

function mapApple(r: AppleResult, fromLat: number | null, fromLon: number | null): Candidate {
  const lat = r.coordinate?.latitude ?? null, lon = r.coordinate?.longitude ?? null;
  const lines = addressLines(r);
  return {
    provider: 'apple',
    provider_place_id: String(r.id ?? ''),
    name: String(r.name ?? ''),
    category: appleCategory(r.poiCategory),
    // Apple repeats the place name as the first line for some POIs.
    address: (lines[0] === r.name ? lines.slice(1) : lines).join(', ') || null,
    lat, lon,
    distance_m: fromLat != null && fromLon != null && lat != null && lon != null ? Math.round(haversine(fromLat, fromLon, lat, lon)) : null,
    extent: appleExtent(r),
  };
}

function appleExtent(r: AppleResult): Bounds | null {
  const d = r.displayMapRegion;
  if (!d || !isNum(d.northLatitude) || !isNum(d.southLatitude) || !isNum(d.eastLongitude) || !isNum(d.westLongitude)) return null;
  return { north: d.northLatitude, south: d.southLatitude, east: d.eastLongitude, west: d.westLongitude };
}

const appleResults = (j: Record<string, unknown>) => ((j.results ?? []) as AppleResult[]);

/** "northLat,eastLon,southLat,westLon" — Apple's searchRegion order. */
const regionParam = (b: Bounds) => `${b.north},${b.east},${b.south},${b.west}`;

async function appleNearby(lat: number, lon: number, query: string | undefined, limit: number): Promise<Candidate[]> {
  if (query) {
    // Free text can be a shop, restaurant, city or country — no POI-only filter.
    const j = await appleGet('/v1/search', { q: query, searchLocation: `${lat},${lon}` });
    return appleResults(j).map((r) => mapApple(r, lat, lon)).slice(0, limit);
  }
  // Apple search needs a query, so "what's around me" is a few broad POI
  // searches inside a ~450m box, merged and sorted by distance.
  const d = 0.004;
  const region = regionParam({ north: lat + d, south: lat - d, east: lon + d * 1.6, west: lon - d * 1.6 });
  const batches = await Promise.all(
    ['food', 'shop', 'park'].map((q) =>
      appleGet('/v1/search', { q, searchRegion: region, resultTypeFilter: 'Poi' }).catch(() => ({ results: [] })),
    ),
  );
  const seen = new Set<string>();
  return batches
    .flatMap((j) => appleResults(j))
    .map((r) => mapApple(r, lat, lon))
    .filter((c) => c.provider_place_id && !seen.has(c.provider_place_id) && seen.add(c.provider_place_id))
    .sort((a, b) => (a.distance_m ?? 1e9) - (b.distance_m ?? 1e9))
    .slice(0, limit);
}

async function appleGeocode(query: string, limit: number): Promise<{ label: string; lat: number; lon: number }[]> {
  // Address search, not /v1/geocode: geocode returns nothing for smaller
  // places ("Didsbury") unless given a location hint, which we don't send.
  const j = await appleGet('/v1/search', { q: query, resultTypeFilter: 'Address' });
  return appleResults(j)
    .filter((r) => r.coordinate?.latitude != null && r.coordinate?.longitude != null)
    .slice(0, limit)
    .map((r) => {
      const lines = addressLines(r);
      const label = lines.length ? lines.join(', ') : String(r.name ?? '');
      return { label, lat: r.coordinate!.latitude!, lon: r.coordinate!.longitude! };
    });
}

async function appleDetails(placeId: string): Promise<Candidate | null> {
  try {
    const j = await appleGet(`/v1/place/${encodeURIComponent(placeId)}`, {});
    const c = mapApple(j as AppleResult, null, null);
    if (!c.provider_place_id || !c.name) return null;
    // Place lookup omits poiCategory; without it the venue falls outside every
    // category chip, so recover it from a name search at the same spot.
    if (!c.category && c.lat != null && c.lon != null) {
      const s = await appleGet('/v1/search', { q: c.name, searchLocation: `${c.lat},${c.lon}`, resultTypeFilter: 'Poi' }).catch(() => ({ results: [] }));
      const same = appleResults(s).find(
        (r) => r.id === c.provider_place_id || (r.alternateIds ?? []).includes(c.provider_place_id),
      );
      // Only real places carry an Apple id (cities and areas have none), so an
      // unrecovered category is still a venue, just an uncategorised one.
      c.category = appleCategory(same?.poiCategory) ?? 'point_of_interest';
    }
    return c;
  } catch {
    return null;
  }
}

/** Query text for a category chip when the user typed nothing. "Things to
 *  do" has no single good query ("attraction" alone found one allotment). */
const CATEGORY_QUERY: Record<string, string[]> = {
  food: ['food'],
  drink: ['bar', 'cafe'],
  shops: ['shop'],
  todo: ['park', 'attraction', 'museum'],
};

async function appleSuggest(queries: string[], b: Bounds): Promise<Candidate[]> {
  const cLat = (b.north + b.south) / 2, cLon = (b.east + b.west) / 2;
  const batches = await Promise.all(
    queries.map((q) => appleGet('/v1/search', { q, searchRegion: regionParam(b), resultTypeFilter: 'Poi' })),
  );
  const seen = new Set<string>();
  return batches
    .flatMap((j) => appleResults(j))
    .map((r) => mapApple(r, cLat, cLon))
    // Apple may return a few places outside the region; the map only wants this viewport.
    .filter((c) => c.provider_place_id && c.name && c.lat != null && c.lon != null
      && c.lat <= b.north && c.lat >= b.south && c.lon <= b.east && c.lon >= b.west
      && !seen.has(c.provider_place_id) && !!seen.add(c.provider_place_id));
}

// ---- Google Places (New) — fallback provider -------------------------------
const FIELD_MASK = 'places.id,places.displayName,places.primaryType,places.formattedAddress,places.location';

async function googleNearby(lat: number, lon: number, query: string | undefined, limit: number): Promise<Candidate[]> {
  let res: Response;
  if (query) {
    res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_KEY, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify({ textQuery: query, maxResultCount: limit, locationBias: { circle: { center: { latitude: lat, longitude: lon }, radius: 3000 } } }),
    });
  } else {
    res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_KEY, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify({ maxResultCount: limit, locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius: 2000 } } }),
    });
  }
  if (!res.ok) throw new Error(`places search ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.places ?? []).map((p: Record<string, never>) => mapGoogle(p, lat, lon));
}

async function googleGeocode(query: string, limit: number): Promise<{ label: string; lat: number; lon: number }[]> {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_KEY, 'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location' },
    body: JSON.stringify({ textQuery: query, maxResultCount: limit }),
  });
  if (!res.ok) throw new Error(`geocode ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.places ?? [])
    .map((p: Record<string, never>) => {
      const loc = (p as { location?: { latitude?: number; longitude?: number } }).location ?? {};
      const name = (p as { displayName?: { text?: string } }).displayName?.text ?? '';
      const addr = (p as { formattedAddress?: string }).formattedAddress ?? '';
      return { label: [name, addr].filter(Boolean).join(' · '), lat: loc.latitude ?? null, lon: loc.longitude ?? null };
    })
    .filter((p: { lat: number | null; lon: number | null }) => p.lat != null && p.lon != null);
}

async function googleDetails(placeId: string): Promise<Candidate | null> {
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { 'X-Goog-Api-Key': GOOGLE_KEY, 'X-Goog-FieldMask': 'id,displayName,primaryType,types,formattedAddress,location,viewport' },
  });
  if (!res.ok) return null;
  const j = await res.json();
  const c = mapGoogle(j, null, null);
  const v = (j as { viewport?: { low?: { latitude?: number; longitude?: number }; high?: { latitude?: number; longitude?: number } } }).viewport;
  if (v && isNum(v.high?.latitude) && isNum(v.low?.latitude) && isNum(v.high?.longitude) && isNum(v.low?.longitude)) {
    c.extent = { north: v.high.latitude, south: v.low.latitude, east: v.high.longitude, west: v.low.longitude };
  }
  // Cities, regions and addresses aren't venues: as one they'd become a pin
  // at the city centre ("Manchester · 3"). Apple gives those no place id.
  const types = (j as { types?: string[] }).types ?? [];
  if (types.some((t) => GOOGLE_NON_VENUE.has(t))) c.category = null;
  else if (!c.category && types.some((t) => t === 'establishment' || t === 'point_of_interest')) c.category = 'point_of_interest';
  return c;
}

const GOOGLE_NON_VENUE = new Set([
  'locality', 'sublocality', 'political', 'country', 'postal_code', 'neighborhood', 'route',
  'street_address', 'premise', 'administrative_area_level_1', 'administrative_area_level_2',
  'administrative_area_level_3', 'colloquial_area', 'geocode',
]);

function mapGoogle(p: Record<string, never>, fromLat: number | null, fromLon: number | null): Candidate {
  const loc = (p as { location?: { latitude?: number; longitude?: number } }).location ?? {};
  const lat = loc.latitude ?? null, lon = loc.longitude ?? null;
  return {
    provider: 'google',
    provider_place_id: String((p as { id?: string }).id ?? ''),
    name: String((p as { displayName?: { text?: string } }).displayName?.text ?? ''),
    category: ((p as { primaryType?: string }).primaryType ?? null),
    address: ((p as { formattedAddress?: string }).formattedAddress ?? null),
    lat, lon,
    distance_m: fromLat != null && fromLon != null && lat != null && lon != null ? Math.round(haversine(fromLat, fromLon, lat, lon)) : null,
  };
}

// ---- helpers ---------------------------------------------------------------
function haversine(a1: number, o1: number, a2: number, o2: number): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(a2 - a1), dLon = toRad(o2 - o1);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a1)) * Math.cos(toRad(a2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
function geohash(lat: number, lon: number, precision: number): string {
  let idx = 0, bit = 0, even = true, hash = '';
  const latR = [-90, 90], lonR = [-180, 180];
  while (hash.length < precision) {
    if (even) { const m = (lonR[0] + lonR[1]) / 2; if (lon >= m) { idx = (idx << 1) + 1; lonR[0] = m; } else { idx <<= 1; lonR[1] = m; } }
    else { const m = (latR[0] + latR[1]) / 2; if (lat >= m) { idx = (idx << 1) + 1; latR[0] = m; } else { idx <<= 1; latR[1] = m; } }
    even = !even;
    if (++bit === 5) { hash += BASE32[idx]; bit = 0; idx = 0; }
  }
  return hash;
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

// ---- fine cells (Stage 3) --------------------------------------------------
// A fixed ~300m grid: rows every FINE_STEP degrees of latitude; within a row,
// columns are FINE_STEP / cos(row latitude) degrees wide so squares stay
// ~300m east-west too. Same maths as lib/location.ts fineCell/decodeCell.
const FINE_STEP = 0.0027;
const FINE_RE = /^f300:(-?\d{1,6}):(-?\d{1,6})$/;

function decodeFine(cell: string): { lat: number; lon: number } | null {
  const m = FINE_RE.exec(cell);
  if (!m) return null;
  const lat = (Number(m[1]) + 0.5) * FINE_STEP;
  const lonStep = FINE_STEP / Math.cos((lat * Math.PI) / 180);
  return { lat, lon: (Number(m[2]) + 0.5) * lonStep };
}

/**
 * Keep a post's fine cell only if it lies inside the venue: within the venue's
 * stored area (padded by half a cell for edge squares), else within 250m of its
 * point. Stops a photo taken at home and tagged "Heaton Park" from publishing
 * the home's 300m square.
 */
function fineCellInsideVenue(cell: string, v: { lat: number | null; lon: number | null; extent?: Bounds | null }): boolean {
  const c = decodeFine(cell);
  if (!c) return false;
  const e = v.extent;
  if (e) {
    const padLat = FINE_STEP / 2, padLon = FINE_STEP / 2 / Math.cos((c.lat * Math.PI) / 180);
    return c.lat <= e.north + padLat && c.lat >= e.south - padLat && c.lon <= e.east + padLon && c.lon >= e.west - padLon;
  }
  return v.lat != null && v.lon != null && haversine(c.lat, c.lon, v.lat, v.lon) <= 250;
}

// ---- clients ---------------------------------------------------------------
function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
}
function userClient(jwt: string): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

Deno.serve(withSentry('places', async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const configured = PROVIDER === 'apple' ? APPLE_READY : PROVIDER === 'google' ? !!GOOGLE_KEY : false;
  if (!configured) return json({ error: 'places_not_configured' }, 501);

  // auth
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401);
  const jwt = auth.slice(7);
  const uclient = userClient(jwt);
  const { data: userData, error: authErr } = await uclient.auth.getUser();
  const uid = userData?.user?.id;
  if (authErr || !uid) return json({ error: 'unauthorized' }, 401);

  let body: {
    action?: string; lat?: number; lon?: number; query?: string; limit?: number; postId?: string;
    provider?: string; provider_place_id?: string; category?: string; fine_cell?: string;
    north?: number; south?: number; east?: number; west?: number;
  };
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }

  const svc = serviceClient();
  const claimSlot = async () => {
    const { data: allowed } = await uclient.rpc('claim_places_slot', { _max: RATE_MAX, _window_seconds: 3600 });
    return !!allowed;
  };

  try {
    if (body.action === 'suggest') {
      const { north, south, east, west } = body;
      if (!isNum(north) || !isNum(south) || !isNum(east) || !isNum(west) || north <= south || east <= west) {
        return json({ error: 'bounds_required' }, 400);
      }
      if (north - south > SUGGEST_MAX_SPAN_DEG || east - west > SUGGEST_MAX_SPAN_DEG) return json({ places: [] });
      const category = body.category && CATEGORY_QUERY[body.category] ? body.category : null;
      const typed = (body.query ?? '').trim().slice(0, 80);
      const queries = typed ? [typed] : category ? CATEGORY_QUERY[category] : [];
      if (!queries.length || !APPLE_READY) return json({ places: [] });
      const b: Bounds = { north, south, east, west };

      // Cache first (no API call, no rate-limit slot); the client snaps its
      // viewport to a grid so nearby pans share a key.
      const key = `apple:suggest:${queries.join('+').toLowerCase()}:${[north, east, south, west].map((n) => n.toFixed(4)).join(',')}`;
      const { data: hit } = await svc.from('place_search_cache').select('results, fetched_at').eq('key', key).maybeSingle();
      let cands: Candidate[];
      if (hit && Date.now() - Date.parse(hit.fetched_at) < SUGGEST_CACHE_MS) {
        cands = hit.results as Candidate[];
      } else {
        if (!(await claimSlot())) return json({ error: 'rate_limited' }, 429);
        cands = await appleSuggest(queries, b);
        await svc.from('place_search_cache').upsert({ key, results: cands, fetched_at: new Date().toISOString() });
        if (Math.random() < 0.05) {
          await svc.from('place_search_cache').delete().lt('fetched_at', new Date(Date.now() - 2 * SUGGEST_CACHE_MS).toISOString());
        }
      }

      // Link to existing venues fresh every time — photo counts change.
      const { data: matches, error: mErr } = await svc.rpc('match_place_suggestions', { _cands: cands });
      if (mErr) throw mErr;
      type Match = { idx: number; venue_id: string | null; post_count: number; category_group: string };
      const byIdx = new Map(((matches ?? []) as Match[]).map((m) => [m.idx, m] as const));
      const places = cands
        .map((c, i) => {
          const m = byIdx.get(i);
          return { ...c, venue_id: m?.venue_id ?? null, post_count: m?.post_count ?? 0, category_group: m?.category_group ?? 'other' };
        })
        // With a chip on, keep only places in that group — same rule as the photo pins.
        .filter((p) => !category || p.category_group === category);
      return json({ places });
    }

    if (!(await claimSlot())) return json({ error: 'rate_limited' }, 429);

    if (body.action === 'nearby') {
      if (typeof body.lat !== 'number' || typeof body.lon !== 'number') return json({ error: 'lat_lon_required' }, 400);
      const limit = Math.min(Math.max(body.limit ?? 12, 1), 20);
      const venues = PROVIDER === 'apple'
        ? await appleNearby(body.lat, body.lon, body.query, limit)
        : await googleNearby(body.lat, body.lon, body.query, limit);
      return json({ venues: venues.filter((v) => v.provider_place_id && v.name) });
    }

    if (body.action === 'geocode') {
      if (!body.query || typeof body.query !== 'string') return json({ error: 'query_required' }, 400);
      const limit = Math.min(Math.max(body.limit ?? 8, 1), 12);
      return json({ places: PROVIDER === 'apple' ? await appleGeocode(body.query, limit) : await googleGeocode(body.query, limit) });
    }

    if (body.action === 'attach') {
      const { postId, provider_place_id } = body;
      const provider = body.provider === 'google' || body.provider === 'apple' ? body.provider : PROVIDER;
      if (!postId || !provider_place_id) return json({ error: 'missing_fields' }, 400);

      // ownership + minor gate (server-side)
      const { data: post } = await svc.from('posts').select('user_id').eq('id', postId).maybeSingle();
      if (!post || post.user_id !== uid) return json({ error: 'not_your_post' }, 403);
      const { data: prof } = await svc.from('profiles').select('age_band').eq('id', uid).maybeSingle();
      if (prof?.age_band === 'minor') return json({ error: 'not_available', message: 'Place tagging isn’t available on your account.' }, 403);

      // authoritative details (server-side key), never the client's word for it
      const details = provider === 'apple'
        ? (APPLE_READY ? await appleDetails(provider_place_id) : null)
        : (GOOGLE_KEY ? await googleDetails(provider_place_id) : null);
      if (!details) return json({ error: 'place_not_found' }, 404);
      // A venue is a place people go: no category means a city, area or
      // address (see googleDetails), which must not become a pin.
      if (!details.category) return json({ error: 'not_a_venue' }, 422);
      const cell = details.lat != null && details.lon != null ? 'gh5:' + geohash(details.lat, details.lon, GEOHASH_PRECISION) : null;
      const ext = details.extent ?? null;

      const { data: venue, error: upErr } = await svc.from('venues').upsert({
        provider: details.provider, provider_place_id: details.provider_place_id,
        name: details.name, category: details.category, lat: details.lat, lon: details.lon,
        address: details.address, location_cell: cell, updated_at: new Date().toISOString(),
        extent_north: ext?.north ?? null, extent_south: ext?.south ?? null,
        extent_east: ext?.east ?? null, extent_west: ext?.west ?? null,
      }, { onConflict: 'provider,provider_place_id' }).select('id, name, category, address').single();
      if (upErr || !venue) return json({ error: 'venue_upsert_failed' }, 500);

      // Stage 3: the photo's ~300m square, only if it's inside this venue.
      const fine = typeof body.fine_cell === 'string' && fineCellInsideVenue(body.fine_cell, details) ? body.fine_cell : null;
      const { error: setErr } = await svc.from('posts').update({ venue_id: venue.id, location_fine: fine }).eq('id', postId);
      if (setErr) return json({ error: 'attach_failed' }, 500);
      return json({ venue, fine_cell: fine });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('[places] error', e);
    await reportError(e);
    return json({ error: 'places_error', message: String(e instanceof Error ? e.message : e) }, 502);
  }
}));
