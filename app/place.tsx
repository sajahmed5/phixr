import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { decodeCell } from '@/lib/location';
import { mediaSource, signMediaPaths } from '@/lib/media';
import { getPlacePosts, type PlacePost } from '@/lib/places';
import { supabase } from '@/lib/supabase';

const PAGE_LIMIT = 60;

type Spot = { lat: number; lon: number; exact: boolean; isBusiness: boolean; category: string | null };

/**
 * Place page (27 Nov, Saj: "I click on the location, and I think, let me take my
 * dog there"). Every picture from one place, a small map and Directions.
 *
 * Two kinds of place:
 *   - a VENUE: exact. Directions go to the door.
 *   - an AREA: a post's coarse location cell (~5km). The pin sits at the cell
 *     centre and Directions go to the area, never to where anyone stood — the
 *     app never stores that.
 */
export default function PlacePage() {
  const { venue, cell, label } = useLocalSearchParams<{ venue?: string; cell?: string; label?: string }>();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const tile = Math.floor((width - 4) / 3);

  const [posts, setPosts] = useState<(PlacePost & { signed: string })[] | null>(null);
  const [spot, setSpot] = useState<Spot | null>(null);
  const title = label || 'This place';

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        if (venue) {
          // venues are readable by any signed-in user (public places).
          const { data } = await supabase
            .from('venues')
            .select('lat, lon, category')
            .eq('id', venue)
            .maybeSingle();
          const { count } = await supabase
            .from('business_venues')
            .select('venue_id', { count: 'exact', head: true })
            .eq('venue_id', venue);
          const v = data as { lat: number | null; lon: number | null; category: string | null } | null;
          if (live && v?.lat != null && v?.lon != null) {
            // A part of a venue (Stage 3: venue + fine cell) — directions go to
            // that part of the park, not the park's single point.
            const part = cell ? decodeCell(cell) : null;
            setSpot({ ...(part ?? { lat: v.lat, lon: v.lon }), exact: true, isBusiness: (count ?? 0) > 0, category: v.category });
          }
        } else if (cell) {
          const c = decodeCell(cell);
          if (live && c) setSpot({ ...c, exact: false, isBusiness: false, category: null });
        }
        const rows = await getPlacePosts({ venueId: venue, cell }, PAGE_LIMIT);
        const signed = await signMediaPaths(rows.map((r) => r.thumbnail_url));
        if (live) setPosts(rows.map((r) => ({ ...r, signed: signed.get(r.thumbnail_url) ?? r.thumbnail_url })));
      } catch {
        if (live) setPosts([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [venue, cell]);

  const people = posts ? new Set(posts.map((p) => p.user_id)).size : 0;
  const count = posts?.length ?? 0;

  const directions = () => {
    if (!spot) return;
    const url = Platform.select({
      ios: `http://maps.apple.com/?daddr=${spot.lat},${spot.lon}&q=${encodeURIComponent(title)}`,
      default: `https://www.google.com/maps/dir/?api=1&destination=${spot.lat},${spot.lon}`,
    });
    void Linking.openURL(url!);
  };

  const kindLine = spot?.exact
    ? spot.isBusiness
      ? 'Business'
      : spot.category
        ? spot.category.replace(/_/g, ' ').replace(/^\w/, (ch) => ch.toUpperCase())
        : 'Place'
    : 'Area';

  return (
    <ThemedView style={{ flex: 1 }}>
      <Stack.Screen options={{ headerShown: true, title }} />
      <FlatList
        data={posts ?? []}
        numColumns={3}
        keyExtractor={(p) => p.id}
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
        ListHeaderComponent={
          <View style={styles.head}>
            <View style={styles.titleRow}>
              <Ionicons
                name={spot?.isBusiness ? 'storefront' : 'location'}
                size={22}
                color={BRAND.accent}
              />
              <View style={{ flex: 1 }}>
                <ThemedText type="subtitle" numberOfLines={2}>
                  {title}
                </ThemedText>
                {posts ? (
                  <ThemedText type="small" themeColor="textSecondary">
                    {kindLine} · {count >= PAGE_LIMIT ? `${PAGE_LIMIT}+` : count} picture
                    {count === 1 ? '' : 's'} · {people} {people === 1 ? 'person' : 'people'}
                  </ThemedText>
                ) : null}
              </View>
            </View>

            {spot ? (
              <View style={[styles.mapBox, { borderColor: theme.border }]}>
                <MapView
                  style={StyleSheet.absoluteFill}
                  initialRegion={{
                    latitude: spot.lat,
                    longitude: spot.lon,
                    // An area is ~5km across — frame it all; a venue gets street zoom.
                    latitudeDelta: spot.exact ? 0.01 : 0.08,
                    longitudeDelta: spot.exact ? 0.01 : 0.08,
                  }}
                  scrollEnabled={false}
                  zoomEnabled={false}
                  rotateEnabled={false}
                  pitchEnabled={false}
                  toolbarEnabled={false}>
                  <Marker coordinate={{ latitude: spot.lat, longitude: spot.lon }}>
                    {spot.exact ? (
                      <Ionicons name="location" size={30} color={BRAND.accent} />
                    ) : (
                      <View style={styles.areaDot} />
                    )}
                  </Marker>
                </MapView>
              </View>
            ) : null}

            {spot ? (
              <>
                <Button title="Directions" variant="secondary" onPress={directions} />
                {!spot.exact ? (
                  <ThemedText type="small" themeColor="textSecondary">
                    Directions go to the area. Exact spots are never stored, so the person who
                    posted can&apos;t be located.
                  </ThemedText>
                ) : null}
              </>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`/post/${item.id}`)}
            style={{ width: tile, height: tile, padding: 1 }}
            accessibilityRole="button"
            accessibilityLabel={`Open a picture from ${title}`}>
            <Image source={mediaSource(item.signed)} style={styles.gridImg} contentFit="cover" recyclingKey={item.id} />
            {item.media_type === 'video' ? (
              <View style={styles.playBadge}>
                <Ionicons name="play" size={12} color="#fff" />
              </View>
            ) : null}
          </Pressable>
        )}
        ListEmptyComponent={
          posts === null ? (
            <ActivityIndicator style={{ padding: 24 }} color={theme.textSecondary} />
          ) : (
            <ThemedText type="default" themeColor="textSecondary" style={styles.empty}>
              No public pictures from here yet.
            </ThemedText>
          )
        }
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  head: { padding: 14, gap: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mapBox: {
    height: 150,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  areaDot: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(245, 81, 14, 0.35)',
    borderWidth: 2,
    borderColor: '#fff',
  },
  gridImg: { flex: 1, borderRadius: 2, backgroundColor: '#222' },
  playBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 999,
    padding: 3,
  },
  empty: { textAlign: 'center', padding: 24 },
});
