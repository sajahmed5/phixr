import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import MapView, { Marker, type Region } from 'react-native-maps';

import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { getVenueBusiness, recordBusinessInsight, type VenueBusiness } from '@/lib/business';
import { signMediaPaths } from '@/lib/media';
import { getMapVenues, getVenuePosts, type MapVenue, type VenuePost } from '@/lib/search';

/**
 * Local Map view (brief 7B): pins only ever at VENUES (public business
 * locations) — never where a person was. Simple grid clustering keyed to the
 * current zoom so it stays smooth on older phones (no native cluster dep).
 * Tapping a pin opens the place card: name, category, distance, best-liked
 * posts, like rate and directions.
 */

type Cluster = { lat: number; lon: number; venues: MapVenue[] };

function clusterVenues(venues: MapVenue[], region: Region): Cluster[] {
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

export function LocalMap() {
  const theme = useTheme();
  const router = useRouter();
  const mapRef = useRef<MapView>(null);
  const [venues, setVenues] = useState<MapVenue[] | null>(null);
  const [region, setRegion] = useState<Region | null>(null);
  const [selected, setSelected] = useState<MapVenue | null>(null);
  const [cardPosts, setCardPosts] = useState<(VenuePost & { signed: string })[] | null>(null);
  // Part 13E: the verified claiming business's hours, links and offers.
  const [cardBiz, setCardBiz] = useState<VenueBusiness | null>(null);

  useEffect(() => {
    void getMapVenues()
      .then((vs) => {
        setVenues(vs);
        if (vs.length > 0) {
          const lats = vs.map((v) => v.lat);
          const lons = vs.map((v) => v.lon);
          const latDelta = Math.max(0.02, (Math.max(...lats) - Math.min(...lats)) * 1.4);
          const lonDelta = Math.max(0.02, (Math.max(...lons) - Math.min(...lons)) * 1.4);
          setRegion({
            latitude: (Math.max(...lats) + Math.min(...lats)) / 2,
            longitude: (Math.max(...lons) + Math.min(...lons)) / 2,
            latitudeDelta: latDelta,
            longitudeDelta: lonDelta,
          });
        }
      })
      .catch(() => setVenues([]));
  }, []);

  const openCard = useCallback(async (v: MapVenue) => {
    setSelected(v);
    setCardPosts(null);
    setCardBiz(null);
    void getVenueBusiness(v.id)
      .then((b) => {
        setCardBiz(b);
        if (b) {
          if (b.offers.length > 0) recordBusinessInsight(b.business_id, 'offer_view');
          if (b.business_hours) recordBusinessInsight(b.business_id, 'hours_view');
        }
      })
      .catch(() => {});
    try {
      const posts = await getVenuePosts(v.id);
      const signed = await signMediaPaths(posts.map((p) => p.thumbnail_url));
      setCardPosts(posts.map((p) => ({ ...p, signed: signed.get(p.thumbnail_url) ?? p.thumbnail_url })));
    } catch {
      setCardPosts([]);
    }
  }, []);

  const clusters = useMemo(
    () => (venues && region ? clusterVenues(venues, region) : []),
    [venues, region],
  );

  const directions = (v: MapVenue) => {
    const url = Platform.select({
      ios: `http://maps.apple.com/?daddr=${v.lat},${v.lon}&q=${encodeURIComponent(v.name)}`,
      default: `https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lon}`,
    });
    void Linking.openURL(url!);
  };

  if (venues === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.textSecondary} />
      </View>
    );
  }
  if (venues.length === 0) {
    return (
      <View style={styles.center}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
          No places with posts in your area yet — posts tagged at a venue show up here.
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
              <View style={styles.clusterPin}>
                <ThemedText type="smallBold" style={styles.clusterText}>
                  {c.venues.length}
                </ThemedText>
              </View>
            </Marker>
          ) : (
            <Marker
              key={c.venues[0].id}
              coordinate={{ latitude: c.venues[0].lat, longitude: c.venues[0].lon }}
              onPress={() => void openCard(c.venues[0])}>
              <View style={styles.pin}>
                <Ionicons name="location" size={26} color={BRAND.accent} />
              </View>
            </Marker>
          ),
        )}
      </MapView>

      {/* Place card */}
      {selected ? (
        <View style={[styles.card, { backgroundColor: theme.background, borderColor: theme.border }]}>
          <View style={styles.cardHead}>
            <View style={styles.cardTitle}>
              <ThemedText type="subtitle" numberOfLines={1}>
                {selected.name}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {selected.category ? selected.category.replace(/_/g, ' ') + ' · ' : ''}
                {formatDistance(selected.distance_m)}
                {selected.like_rate != null
                  ? ` · ${Math.round(selected.like_rate * 100)}% liked`
                  : ''}
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
              {cardPosts.map((p) => (
                <Pressable key={p.id} onPress={() => router.push(`/post/${p.id}`)} style={styles.thumbWrap}>
                  <Image source={{ uri: p.signed }} style={styles.thumb} contentFit="cover" />
                </Pressable>
              ))}
            </View>
          )}
          <View style={styles.actionRow}>
            <View style={styles.actionBtn}>
              <Button title="Directions" variant="secondary" onPress={() => directions(selected)} />
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
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  centerText: { textAlign: 'center' },
  pin: { alignItems: 'center' },
  clusterPin: {
    minWidth: 30,
    height: 30,
    borderRadius: 15,
    paddingHorizontal: 8,
    backgroundColor: BRAND.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clusterText: { color: '#fff' },
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
