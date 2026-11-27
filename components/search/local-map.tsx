import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import MapView, { Marker, type Region } from 'react-native-maps';

import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { getVenueBusiness, recordBusinessInsight, type VenueBusiness } from '@/lib/business';
import { decodeCell } from '@/lib/location';
import { mediaSource, signMediaPaths } from '@/lib/media';
import { setPendingPlace } from '@/lib/pending-place';
import { placeHref } from '@/lib/places';
import {
  getCellPosts,
  getMapPins,
  getMySearchCentre,
  getPlaceSuggestions,
  getVenuePosts,
  recordSponsoredClick,
  type MapBounds,
  type MapPin,
  type PlaceSuggestion,
  type SearchCategory,
  type SponsoredResult,
} from '@/lib/search';

/**
 * Local Map view (brief 7B, reworked for #71/#72/#73): the map browses the SAME
 * result set as the grid — pins respond to the live query and category chip, so
 * searching "dog" never pins a café (#71's inverse). Three pin kinds:
 *   - business venues (claimed places): brand-coloured, named, slightly larger;
 *   - customer-tagged venues (the hidden gems): named, neutral;
 *   - cell clusters: located posts with NO venue, merged into their coarse
 *     ~5km cell — pins only ever at venues or cell centres, never at a person.
 * Tapping any pin opens its photos, so browsing is place-first (Saj's ask).
 *
 * Stage 1 of the places plan (agreed 2026-11-27): a strict pin budget so the
 * map never becomes a wall of pins. At most PIN_BUDGET venue chips per
 * viewport, ranked purely by what users did there (pinScore); everything past
 * the budget folds into "+N" bubbles that zoom in on tap, so nothing matching
 * the search ever disappears — zooming re-allocates the budget to the smaller
 * area (the Apple Photos model). Up to SPONSORED_SLOTS of the budget are
 * reserved for sponsored placements (the existing get_sponsored_results
 * system), always labelled. The grid view stays the uncapped catalogue.
 *
 * Stage 2: at street zoom, real places matching the search (Apple Maps, via
 * the `places` function) fill whatever budget the photo pins leave — at most
 * MAX_SUGGESTED, drawn hollow and grey so photo pins stay the loud ones.
 * Zoomed out they vanish. Tapping one offers "be the first": the next post
 * starts tagged at that place, and once it lands the place becomes a photo
 * pin (the server links suggestions to known venues, so it never shows twice).
 * As content grows it fills the budget and hollow pins stop appearing.
 */

/** Stage 1 budget: at most this many venue pins in view at once. */
const PIN_BUDGET = 20;
/** Of which at most this many are sponsored placements (server also caps at 2). */
const SPONSORED_SLOTS = 2;
/** Below this latitudeDelta (~4.4km tall viewport) Apple's own POI labels are
 *  hidden, so at street zoom Phixr pins are the only pins. */
const STREET_ZOOM_DELTA = 0.04;
/** Stage 2: at most this many hollow "be the first" pins, and only in budget
 *  slots the photo pins leave free. */
const MAX_SUGGESTED = 8;
/** Suggestion viewports snap outward to this grid (degrees), so small pans
 *  reuse the same request — here and in the server's cache. */
const SUGGEST_GRID = 0.005;

type VenuePin = MapPin & { lat: number; lon: number };
type CellPin = MapPin & { centre: { lat: number; lon: number } };
type Selected =
  | { kind: 'venue'; pin: VenuePin }
  | { kind: 'cell'; pin: CellPin }
  | { kind: 'suggestion'; place: PlaceSuggestion };

function snapBounds(r: Region): MapBounds {
  const g = SUGGEST_GRID;
  const snap = (n: number, up: boolean) => Number(((up ? Math.ceil(n / g) : Math.floor(n / g)) * g).toFixed(4));
  return {
    north: snap(r.latitude + r.latitudeDelta / 2, true),
    south: snap(r.latitude - r.latitudeDelta / 2, false),
    east: snap(r.longitude + r.longitudeDelta / 2, true),
    west: snap(r.longitude - r.longitudeDelta / 2, false),
  };
}
type CardPost = { id: string; thumbnail_url: string; signed: string };

type Cluster = { lat: number; lon: number; venues: VenuePin[] };

function clusterVenues(venues: VenuePin[], region: Region): Cluster[] {
  // Bucket venues into a ~9-column grid of the visible region: markers in the
  // same bucket merge. At street zoom the buckets are tiny, so pins separate.
  const cellW = region.longitudeDelta / 9;
  const cellH = region.latitudeDelta / 9;
  const buckets = new Map<string, Cluster>();
  for (const v of venues) {
    const key = `${Math.round(v.lon / cellW)}:${Math.round(v.lat / cellH)}`;
    const b = buckets.get(key);
    if (b) {
      b.venues.push(v);
      b.lat = (b.lat * (b.venues.length - 1) + v.lat) / b.venues.length;
      b.lon = (b.lon * (b.venues.length - 1) + v.lon) / b.venues.length;
    } else {
      buckets.set(key, { lat: v.lat, lon: v.lon, venues: [v] });
    }
  }
  return [...buckets.values()];
}

/**
 * Stage 1 ranking — purely user-driven (Saj's sign-off): post volume (damped),
 * bot-cleaned like rate, and how recently anyone posted there. Deliberately NO
 * signal from the venue owner's own app activity — a dormant business whose
 * customers still post and like it keeps earning its pin.
 */
function pinScore(v: VenuePin): number {
  const volume = Math.log1p(v.post_count);
  const quality = v.like_rate ?? 0.5; // neutral prior until anyone swipes
  const ageDays = v.last_post_at
    ? Math.max(0, (Date.now() - Date.parse(v.last_post_at)) / 86_400_000)
    : 365;
  const recency = Math.exp(-ageDays / 30); // fades over ~a month
  return volume * (0.5 + quality) + recency;
}

/** Inside the visible region, with a 20% margin so edge pins don't pop late. */
function inRegion(lat: number, lon: number, r: Region): boolean {
  return (
    Math.abs(lat - r.latitude) <= r.latitudeDelta * 0.6 &&
    Math.abs(lon - r.longitude) <= r.longitudeDelta * 0.6
  );
}

function todayHours(b: VenueBusiness): string | null {
  if (!b.business_hours) return null;
  const key = (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const)[new Date().getDay()];
  return b.business_hours[key] ?? null;
}

function formatDistance(m: number): string {
  if (m < 1000) {
    const walkMin = Math.max(1, Math.round(m / 80)); // ~80 m/min walking
    return `${walkMin} min walk`;
  }
  return `${(m / 1609.34).toFixed(1)} miles`;
}

export function LocalMap({
  query,
  category,
  sponsored,
}: {
  query: string;
  category: SearchCategory;
  /** Passed down from the search screen's single fetch, so map + grid share
   *  one impression count per search. */
  sponsored?: SponsoredResult[];
}) {
  const theme = useTheme();
  const router = useRouter();
  const mapRef = useRef<MapView>(null);
  const [pins, setPins] = useState<MapPin[] | null>(null);
  const [region, setRegion] = useState<Region | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [cardPosts, setCardPosts] = useState<CardPost[] | null>(null);
  // Part 13E: the verified claiming business's hours, links and offers.
  const [cardBiz, setCardBiz] = useState<VenueBusiness | null>(null);
  // Stage 2: suggested places per (search, snapped viewport) — kept for the
  // session so panning back costs nothing.
  const [suggestCache, setSuggestCache] = useState<Record<string, PlaceSuggestion[]>>({});
  const wantsSuggestions = !!(query.trim() || category);

  const venuePins = useMemo(
    () => (pins ?? []).filter((p): p is VenuePin => p.kind === 'venue' && p.lat != null && p.lon != null),
    [pins],
  );
  const cellPins = useMemo(
    () =>
      (pins ?? [])
        .map((p) => (p.kind === 'cell' && p.cell ? { ...p, centre: decodeCell(p.cell) } : null))
        .filter((p): p is CellPin => !!p && !!p.centre),
    [pins],
  );

  useEffect(() => {
    let alive = true;
    void getMapPins(query, category)
      .then((ps) => {
        if (!alive) return;
        setSelected(null); // a new search invalidates the open card
        setPins(ps);
        const coords = [
          ...ps.filter((p) => p.lat != null && p.lon != null).map((p) => ({ lat: p.lat!, lon: p.lon! })),
          ...ps
            .filter((p) => p.kind === 'cell' && p.cell)
            .map((p) => decodeCell(p.cell!))
            .filter((c): c is { lat: number; lon: number } => !!c),
        ];
        if (coords.length > 0) {
          const lats = coords.map((c) => c.lat);
          const lons = coords.map((c) => c.lon);
          setRegion({
            latitude: (Math.max(...lats) + Math.min(...lats)) / 2,
            longitude: (Math.max(...lons) + Math.min(...lons)) / 2,
            latitudeDelta: Math.max(0.02, (Math.max(...lats) - Math.min(...lats)) * 1.4),
            longitudeDelta: Math.max(0.02, (Math.max(...lons) - Math.min(...lons)) * 1.4),
          });
        } else if (query.trim() || category) {
          // No photos match yet: still open the map at the search centre, at
          // street zoom, so the real places matching the search can show.
          void getMySearchCentre().then((c) => {
            if (alive && c) setRegion({ latitude: c.lat, longitude: c.lon, latitudeDelta: 0.02, longitudeDelta: 0.02 });
          });
        }
      })
      .catch(() => alive && setPins([]));
    return () => {
      alive = false;
    };
  }, [query, category]);

  // Stage 2: fetch suggested places for the settled street-zoom viewport.
  const suggestKey = useMemo(() => {
    if (!region || !wantsSuggestions || region.latitudeDelta >= STREET_ZOOM_DELTA) return null;
    const b = snapBounds(region);
    return { key: `${query.trim().toLowerCase()}|${category ?? ''}|${b.north},${b.east},${b.south},${b.west}`, bounds: b };
  }, [region, wantsSuggestions, query, category]);

  useEffect(() => {
    if (!suggestKey || suggestCache[suggestKey.key]) return;
    const { key, bounds } = suggestKey;
    const t = setTimeout(() => {
      void getPlaceSuggestions(query, category, bounds)
        .then((places) => setSuggestCache((c) => ({ ...c, [key]: places })))
        .catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [suggestKey, suggestCache, query, category]);

  const suggestions = useMemo(
    () => (suggestKey ? (suggestCache[suggestKey.key] ?? []) : []),
    [suggestKey, suggestCache],
  );

  const openVenue = async (pin: VenuePin) => {
    setSelected({ kind: 'venue', pin });
    setCardPosts(null);
    setCardBiz(null);
    void getVenueBusiness(pin.id)
      .then((b) => {
        setCardBiz(b);
        if (b) {
          if (b.offers.length > 0) recordBusinessInsight(b.business_id, 'offer_view');
          if (b.business_hours) recordBusinessInsight(b.business_id, 'hours_view');
        }
      })
      .catch(() => {});
    try {
      const posts = await getVenuePosts(pin.id);
      const signed = await signMediaPaths(posts.map((p) => p.thumbnail_url));
      setCardPosts(posts.map((p) => ({ ...p, signed: signed.get(p.thumbnail_url) ?? p.thumbnail_url })));
    } catch {
      setCardPosts([]);
    }
  };

  const openCell = async (pin: CellPin) => {
    setSelected({ kind: 'cell', pin });
    setCardPosts(null);
    setCardBiz(null);
    try {
      const posts = await getCellPosts(pin.id, query, category);
      const signed = await signMediaPaths(posts.map((p) => p.thumbnail_url));
      setCardPosts(posts.map((p) => ({ ...p, signed: signed.get(p.thumbnail_url) ?? p.thumbnail_url })));
    } catch {
      setCardPosts([]);
    }
  };

  // Sponsored placements (max SPONSORED_SLOTS): the only guaranteed pins,
  // always labelled. Where the venue also has an organic pin we reuse it (its
  // post count and like rate are real); otherwise we build a bare pin from the
  // venue's public coordinates.
  const sponsoredPins = useMemo<{ sp: SponsoredResult; pin: VenuePin }[]>(
    () =>
      (sponsored ?? [])
        .filter((sp) => sp.venue_lat != null && sp.venue_lon != null)
        .slice(0, SPONSORED_SLOTS)
        .map((sp) => ({
          sp,
          pin:
            venuePins.find((v) => v.id === sp.venue_id) ??
            ({
              kind: 'venue',
              id: sp.venue_id,
              name: sp.venue_name,
              category_group: null,
              lat: sp.venue_lat!,
              lon: sp.venue_lon!,
              post_count: 0,
              is_business: true,
              like_rate: null,
              distance_m: sp.distance_m,
              cell: null,
              last_post_at: null,
            } satisfies VenuePin),
        })),
    [sponsored, venuePins],
  );
  const sponsoredIds = useMemo(() => new Set(sponsoredPins.map((s) => s.pin.id)), [sponsoredPins]);

  // Stage 1 budget: rank the organic venues visible right now and keep the
  // top of the list; the rest fold into "+N" bubbles below. Re-runs on every
  // pan/zoom, so zooming in re-allocates the budget to the smaller area.
  const { budgeted, overflow, freeSlots } = useMemo(() => {
    if (!region) return { budgeted: [] as VenuePin[], overflow: [] as VenuePin[], freeSlots: 0 };
    const visible = venuePins.filter((v) => !sponsoredIds.has(v.id) && inRegion(v.lat, v.lon, region));
    const scored = [...visible].sort((a, b) => pinScore(b) - pinScore(a) || a.id.localeCompare(b.id));
    const sponsoredVisible = sponsoredPins.filter((s) => inRegion(s.pin.lat, s.pin.lon, region)).length;
    const slots = Math.max(0, PIN_BUDGET - sponsoredVisible);
    return {
      budgeted: scored.slice(0, slots),
      overflow: scored.slice(slots),
      freeSlots: Math.max(0, slots - scored.length),
    };
  }, [venuePins, sponsoredPins, sponsoredIds, region]);

  // Stage 2: hollow pins take only the slots photo and sponsored pins leave,
  // never a place already on the map as a photo pin. Places Phixr already
  // has photos of (that just don't match this search) go first.
  const hollowPins = useMemo(() => {
    if (!region || region.latitudeDelta >= STREET_ZOOM_DELTA) return [];
    const onMap = new Set([...venuePins.map((v) => v.id), ...sponsoredIds]);
    return suggestions
      .filter((s) => !(s.venue_id && onMap.has(s.venue_id)) && inRegion(s.lat, s.lon, region))
      .map((s, i) => ({ s, i }))
      .sort((a, b) => b.s.post_count - a.s.post_count || a.i - b.i)
      .slice(0, Math.min(MAX_SUGGESTED, freeSlots))
      .map(({ s }) => s);
  }, [suggestions, venuePins, sponsoredIds, region, freeSlots]);

  const openSuggestion = (place: PlaceSuggestion) => {
    setSelected({ kind: 'suggestion', place });
    setCardPosts(null);
    setCardBiz(null);
  };

  const beTheFirst = (place: PlaceSuggestion) => {
    setPendingPlace({
      name: place.name,
      lat: place.lat,
      lon: place.lon,
      ref: { provider: place.provider, provider_place_id: place.provider_place_id },
    });
    router.push('/camera');
  };

  const clusters = useMemo(
    () => (region ? clusterVenues(budgeted, region) : []),
    [budgeted, region],
  );
  const overflowClusters = useMemo(
    () => (region ? clusterVenues(overflow, region) : []),
    [overflow, region],
  );

  const zoomInto = (c: Cluster) =>
    mapRef.current?.animateToRegion(
      {
        latitude: c.lat,
        longitude: c.lon,
        latitudeDelta: (region?.latitudeDelta ?? 0.1) / 3,
        longitudeDelta: (region?.longitudeDelta ?? 0.1) / 3,
      },
      250,
    );

  const directions = (pin: { lat: number; lon: number; name: string | null }) => {
    const url = Platform.select({
      ios: `http://maps.apple.com/?daddr=${pin.lat},${pin.lon}&q=${encodeURIComponent(pin.name ?? '')}`,
      default: `https://www.google.com/maps/dir/?api=1&destination=${pin.lat},${pin.lon}`,
    });
    void Linking.openURL(url!);
  };

  if (pins === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.textSecondary} />
      </View>
    );
  }
  const noPhotoPins = venuePins.length === 0 && cellPins.length === 0;
  if (noPhotoPins && !region) {
    return (
      <View style={styles.center}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
          {query.trim() || category
            ? 'Nothing matching this search has a location yet.'
            : 'No located posts in your area yet — pictures tagged with a place show up here.'}
        </ThemedText>
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <MapView
        ref={mapRef}
        style={styles.fill}
        initialRegion={region ?? undefined}
        onRegionChangeComplete={setRegion}
        showsUserLocation={false}
        // Stage 1: at street zoom Apple's own POI labels disappear, so Phixr
        // pins are the only pins on the map.
        showsPointsOfInterests={(region?.latitudeDelta ?? 1) >= STREET_ZOOM_DELTA}
        toolbarEnabled={false}>
        {/* Stage 2: real places with no matching photos yet — hollow, grey,
            and drawn first so photo pins always sit on top. */}
        {hollowPins.map((s) => (
          <Marker
            key={`sg-${s.provider_place_id}`}
            coordinate={{ latitude: s.lat, longitude: s.lon }}
            onPress={() => openSuggestion(s)}>
            <View style={styles.pinCol}>
              <View style={styles.hollowPin}>
                <Ionicons name="location-outline" size={11} color={HOLLOW_INK} />
                <ThemedText type="small" style={styles.hollowText} numberOfLines={1}>
                  {s.name}
                </ThemedText>
              </View>
              <View style={[styles.pinStem, { backgroundColor: HOLLOW_LINE }]} />
            </View>
          </Marker>
        ))}
        {clusters.map((c, i) =>
          c.venues.length > 1 ? (
            <Marker
              key={`c-${i}-${c.venues.length}`}
              coordinate={{ latitude: c.lat, longitude: c.lon }}
              onPress={() => zoomInto(c)}>
              <View style={styles.mergePin}>
                <ThemedText type="smallBold" style={styles.pinText}>
                  {c.venues.length}
                </ThemedText>
              </View>
            </Marker>
          ) : (
            // #72: named pins; a claimed business reads bolder than a
            // customer-tagged place, so the two are tellable at a glance.
            <Marker
              key={c.venues[0].id}
              coordinate={{ latitude: c.venues[0].lat, longitude: c.venues[0].lon }}
              onPress={() => void openVenue(c.venues[0])}>
              <View style={styles.pinCol}>
                <View style={[styles.venuePin, c.venues[0].is_business ? styles.bizPin : styles.gemPin]}>
                  <Ionicons
                    name={c.venues[0].is_business ? 'storefront' : 'location'}
                    size={c.venues[0].is_business ? 14 : 12}
                    color="#fff"
                  />
                  <ThemedText
                    type={c.venues[0].is_business ? 'smallBold' : 'small'}
                    style={styles.pinText}
                    numberOfLines={1}>
                    {c.venues[0].name} · {c.venues[0].post_count}
                  </ThemedText>
                </View>
                <View style={[styles.pinStem, { backgroundColor: c.venues[0].is_business ? BRAND.accent : PIN_DARK }]} />
              </View>
            </Marker>
          ),
        )}
        {/* Stage 1 overflow: venues past the budget, folded into "+N" bubbles
            that zoom in on tap — nothing matching the search disappears. */}
        {overflowClusters.map((c, i) => (
          <Marker
            key={`of-${i}-${c.venues.length}`}
            coordinate={{ latitude: c.lat, longitude: c.lon }}
            onPress={() => zoomInto(c)}>
            <View style={styles.overflowPin}>
              <ThemedText type="smallBold" style={styles.pinText}>
                +{c.venues.length}
              </ThemedText>
            </View>
          </Marker>
        ))}
        {/* Sponsored placements: guaranteed, and always labelled. */}
        {sponsoredPins.map(({ sp, pin }) => (
          <Marker
            key={`sp-${sp.id}`}
            coordinate={{ latitude: pin.lat, longitude: pin.lon }}
            onPress={() => {
              recordSponsoredClick(sp.id);
              void openVenue(pin);
            }}>
            <View style={styles.pinCol}>
              <View style={[styles.venuePin, styles.bizPin]}>
                <Ionicons name="storefront" size={14} color="#fff" />
                <ThemedText type="smallBold" style={styles.pinText} numberOfLines={1}>
                  {pin.name}
                </ThemedText>
                <View style={styles.adChip}>
                  <ThemedText style={styles.adChipText}>Sponsored</ThemedText>
                </View>
              </View>
              <View style={[styles.pinStem, { backgroundColor: BRAND.accent }]} />
            </View>
          </Marker>
        ))}
        {cellPins.map((p) => (
          <Marker
            key={p.id}
            coordinate={{ latitude: p.centre.lat, longitude: p.centre.lon }}
            onPress={() => void openCell(p)}>
            <View style={styles.cellPin}>
              <ThemedText type="smallBold" style={styles.pinText}>
                {p.post_count}
              </ThemedText>
            </View>
          </Marker>
        ))}
      </MapView>

      {noPhotoPins && !selected ? (
        <View style={[styles.hint, { backgroundColor: theme.background, borderColor: theme.border }]}>
          <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
            {region && region.latitudeDelta < STREET_ZOOM_DELTA
              ? 'No photos match yet — these are places nearby. Be the first to post one.'
              : 'No photos match yet — zoom in to see places nearby.'}
          </ThemedText>
        </View>
      ) : null}

      {/* Stage 2: a suggested place — "be the first", or its photos when Phixr
          has some that just don't match this search. */}
      {selected?.kind === 'suggestion' ? (
        <View style={[styles.card, { backgroundColor: theme.background, borderColor: theme.border }]}>
          <View style={styles.cardHead}>
            <View style={styles.cardTitle}>
              <ThemedText type="subtitle" numberOfLines={1} style={styles.cardName}>
                {selected.place.name}
              </ThemedText>
              {selected.place.address ? (
                <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                  {selected.place.address}
                </ThemedText>
              ) : null}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close place card" hitSlop={8} onPress={() => setSelected(null)}>
              <Ionicons name="close" size={22} color={theme.textSecondary} />
            </Pressable>
          </View>
          <ThemedText type="small">
            {selected.place.venue_id && selected.place.post_count > 0
              ? `${selected.place.post_count} photo${selected.place.post_count === 1 ? '' : 's'} here, none matching this search.`
              : 'No photos here yet — be the first to post one.'}
          </ThemedText>
          <View style={styles.actionRow}>
            <View style={styles.actionBtn}>
              {selected.place.venue_id && selected.place.post_count > 0 ? (
                <Button
                  title="See photos"
                  onPress={() =>
                    router.push(
                      placeHref({ label: selected.place.name, venueId: selected.place.venue_id, cell: null, isBusiness: false }),
                    )
                  }
                />
              ) : (
                <Button title="Post a photo here" onPress={() => beTheFirst(selected.place)} />
              )}
            </View>
            <View style={styles.actionBtn}>
              <Button title="Directions" variant="secondary" onPress={() => directions(selected.place)} />
            </View>
          </View>
        </View>
      ) : null}

      {/* Place / area card */}
      {selected && selected.kind !== 'suggestion' ? (
        <View style={[styles.card, { backgroundColor: theme.background, borderColor: theme.border }]}>
          <View style={styles.cardHead}>
            <View style={styles.cardTitle}>
              <View style={styles.cardTitleRow}>
                <ThemedText type="subtitle" numberOfLines={1} style={styles.cardName}>
                  {selected.kind === 'venue' ? selected.pin.name : (selected.pin.name ?? 'This area')}
                </ThemedText>
                {selected.kind === 'venue' && selected.pin.is_business ? (
                  <View style={styles.bizBadge}>
                    <ThemedText type="small" style={styles.bizBadgeText}>
                      BUSINESS
                    </ThemedText>
                  </View>
                ) : null}
                {selected.kind === 'venue' && sponsoredIds.has(selected.pin.id) ? (
                  <View style={styles.bizBadge}>
                    <ThemedText type="small" style={styles.bizBadgeText}>
                      SPONSORED
                    </ThemedText>
                  </View>
                ) : null}
              </View>
              <ThemedText type="small" themeColor="textSecondary">
                {selected.kind === 'venue'
                  ? [
                      selected.pin.category_group && selected.pin.category_group !== 'other'
                        ? selected.pin.category_group
                        : null,
                      selected.pin.distance_m != null ? formatDistance(selected.pin.distance_m) : null,
                      selected.pin.like_rate != null
                        ? `${Math.round(selected.pin.like_rate * 100)}% liked`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : `${selected.pin.post_count} picture${selected.pin.post_count === 1 ? '' : 's'} around here`}
              </ThemedText>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close place card" hitSlop={8} onPress={() => setSelected(null)}>
              <Ionicons name="close" size={22} color={theme.textSecondary} />
            </Pressable>
          </View>
          {cardBiz ? (
            <View style={styles.bizBlock}>
              {todayHours(cardBiz) ? (
                <ThemedText type="small" themeColor="textSecondary">
                  Open today {todayHours(cardBiz)}
                </ThemedText>
              ) : null}
              {cardBiz.offers.slice(0, 2).map((o) => (
                <Pressable
                  key={o.id}
                  accessibilityRole="button"
                  onPress={() => {
                    recordBusinessInsight(cardBiz.business_id, 'offer_click');
                    router.push(`/u/${cardBiz.handle}`);
                  }}
                  style={[styles.offerPill, { borderColor: BRAND.accent }]}>
                  <Ionicons name="pricetag" size={14} color={BRAND.accent} />
                  <ThemedText type="small" numberOfLines={1} style={styles.offerText}>
                    {o.title}
                  </ThemedText>
                </Pressable>
              ))}
            </View>
          ) : null}
          {cardPosts === null ? (
            <ActivityIndicator color={theme.textSecondary} />
          ) : (
            <View style={styles.thumbRow}>
              {cardPosts.slice(0, 4).map((p) => (
                <Pressable key={p.id} onPress={() => router.push(`/post/${p.id}`)} style={styles.thumbWrap}>
                  <Image source={mediaSource(p.signed)} style={styles.thumb} contentFit="cover" />
                </Pressable>
              ))}
            </View>
          )}
          {selected.kind === 'venue' ? (
            <View style={styles.actionRow}>
              <View style={styles.actionBtn}>
                <Button title="Directions" variant="secondary" onPress={() => directions(selected.pin)} />
              </View>
              {cardBiz?.menu_url ? (
                <View style={styles.actionBtn}>
                  <Button
                    title="Menu"
                    variant="secondary"
                    onPress={() => {
                      recordBusinessInsight(cardBiz.business_id, 'menu_click');
                      void Linking.openURL(cardBiz.menu_url!);
                    }}
                  />
                </View>
              ) : null}
              {cardBiz?.booking_url ? (
                <View style={styles.actionBtn}>
                  <Button
                    title="Book"
                    variant="secondary"
                    onPress={() => {
                      recordBusinessInsight(cardBiz.business_id, 'booking_click');
                      void Linking.openURL(cardBiz.booking_url!);
                    }}
                  />
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Neutral pin colour for customer-tagged (unclaimed) places. */
const PIN_DARK = '#2A2A28';
/** Stage 2 hollow pins: outline and text, quieter than any photo pin. */
const HOLLOW_LINE = '#8C8984';
const HOLLOW_INK = '#5F5C57';

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  centerText: { textAlign: 'center' },
  pinCol: { alignItems: 'center' },
  venuePin: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: '#fff',
    maxWidth: 180,
  },
  bizPin: { backgroundColor: BRAND.accent, paddingHorizontal: 10, paddingVertical: 5 },
  gemPin: { backgroundColor: PIN_DARK, paddingHorizontal: 8, paddingVertical: 4 },
  pinStem: { width: 2, height: 6 },
  cellPin: {
    minWidth: 28,
    height: 28,
    borderRadius: 14,
    paddingHorizontal: 7,
    backgroundColor: 'rgba(245, 81, 14, 0.8)',
    borderWidth: 2,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mergePin: {
    minWidth: 30,
    height: 30,
    borderRadius: 15,
    paddingHorizontal: 8,
    backgroundColor: BRAND.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Beyond-the-budget "+N" bubble: visually quieter than the accent merge
  // bubble, so the budgeted chips stay the loudest thing on the map.
  overflowPin: {
    minWidth: 30,
    height: 30,
    borderRadius: 15,
    paddingHorizontal: 8,
    backgroundColor: 'rgba(42, 42, 40, 0.85)',
    borderWidth: 2,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hollowPin: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: HOLLOW_LINE,
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    paddingHorizontal: 7,
    paddingVertical: 3,
    maxWidth: 150,
  },
  hollowText: { color: HOLLOW_INK, fontSize: 12, lineHeight: 15 },
  hint: {
    position: 'absolute',
    top: 10,
    left: 12,
    right: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  adChip: {
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderRadius: 6,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  adChipText: { color: '#fff', fontSize: 9, fontWeight: '700', lineHeight: 12 },
  pinText: { color: '#fff' },
  card: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    gap: 10,
  },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  cardTitle: { flex: 1, gap: 2 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardName: { flexShrink: 1 },
  bizBadge: {
    backgroundColor: 'rgba(245, 81, 14, 0.12)',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  bizBadgeText: { color: BRAND.accent, fontSize: 10, fontWeight: '700' },
  thumbRow: { flexDirection: 'row', gap: 6 },
  bizBlock: { gap: 6 },
  offerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  offerText: { flexShrink: 1 },
  actionRow: { flexDirection: 'row', gap: 8 },
  actionBtn: { flex: 1 },
  thumbWrap: { flex: 1, aspectRatio: 1, borderRadius: 8, overflow: 'hidden' },
  thumb: { width: '100%', height: '100%' },
});
