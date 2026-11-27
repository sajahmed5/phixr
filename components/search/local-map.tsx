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
import {
  getCellPosts,
  getMapPins,
  getVenuePosts,
  type MapPin,
  type SearchCategory,
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
 */

type VenuePin = MapPin & { lat: number; lon: number };
type CellPin = MapPin & { centre: { lat: number; lon: number } };
type Selected =
  | { kind: 'venue'; pin: VenuePin }
  | { kind: 'cell'; pin: CellPin };
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

export function LocalMap({ query, category }: { query: string; category: SearchCategory }) {
  const theme = useTheme();
  const router = useRouter();
  const mapRef = useRef<MapView>(null);
  const [pins, setPins] = useState<MapPin[] | null>(null);
  const [region, setRegion] = useState<Region | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [cardPosts, setCardPosts] = useState<CardPost[] | null>(null);
  // Part 13E: the verified claiming business's hours, links and offers.
  const [cardBiz, setCardBiz] = useState<VenueBusiness | null>(null);

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
        }
      })
      .catch(() => alive && setPins([]));
    return () => {
      alive = false;
    };
  }, [query, category]);

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

  const clusters = useMemo(
    () => (region ? clusterVenues(venuePins, region) : []),
    [venuePins, region],
  );

  const directions = (pin: VenuePin) => {
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
  if (venuePins.length === 0 && cellPins.length === 0) {
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
        toolbarEnabled={false}>
        {clusters.map((c, i) =>
          c.venues.length > 1 ? (
            <Marker
              key={`c-${i}-${c.venues.length}`}
              coordinate={{ latitude: c.lat, longitude: c.lon }}
              onPress={() =>
                mapRef.current?.animateToRegion(
                  {
                    latitude: c.lat,
                    longitude: c.lon,
                    latitudeDelta: (region?.latitudeDelta ?? 0.1) / 3,
                    longitudeDelta: (region?.longitudeDelta ?? 0.1) / 3,
                  },
                  250,
                )
              }>
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

      {/* Place / area card */}
      {selected ? (
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
