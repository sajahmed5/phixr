import { Ionicons } from '@expo/vector-icons';
import { Canvas, LinearGradient, Rect, vec } from '@shopify/react-native-skia';
import { useFocusEffect, useIsFocused, useNavigation, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PhixrLockup } from '@/components/brand/phixr-logo';
import { DeckView } from '@/components/deck/deck-view';
import { RAIL_ICON, RAIL_TINT } from '@/components/deck/swipe-card';
import { ErrorBoundary } from '@/components/error-boundary';
import { TeenWellbeingBanner } from '@/components/teen-wellbeing-banner';
import { ThemedView } from '@/components/themed-view';
import { useTheme } from '@/hooks/use-theme';
import { fetchDeck } from '@/lib/deck';
import { floatingTabBarStyle, HOME_TAB_BAR_FILL } from '@/lib/tab-bar-style';

/** Height of Home's overlay bar below the status bar (logo + search). */
const BAR_HEIGHT = 48;

/**
 * Home — the worldwide, ranked feed, full screen (#78): the photo runs to the top edge and
 * the phixr lockup + search sit on it. Pinch a photo for the full view (#79): the whole
 * uncropped photo with only the logo left; a tap or the start of a swipe brings the info
 * back.
 */
export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const [fullView, setFullView] = useState(false);
  const topInset = insets.top + BAR_HEIGHT;

  // The tab bar is part of "everything but the logo" — hide it in full view.
  useEffect(() => {
    navigation.setOptions({
      tabBarStyle: fullView ? { display: 'none' } : floatingTabBarStyle(HOME_TAB_BAR_FILL),
    });
  }, [fullView, navigation]);

  // Leaving Home (another tab, a pushed screen) always returns it to the normal view.
  useFocusEffect(useCallback(() => () => setFullView(false), []));

  return (
    <ThemedView style={{ flex: 1 }}>
      <ErrorBoundary label="The feed">
        <DeckView
          fetchBatch={fetchDeck}
          persistKey="home"
          topInset={topInset}
          fullView={fullView}
          onFullViewChange={setFullView}
          topBar={({ onMedia }) => <HomeTopBar onMedia={onMedia} fullView={fullView} />}
        />
      </ErrorBoundary>
      {/* Gentle quiet-hours / screen-time nudges for under-18s (brief 6A), just under the bar. */}
      {fullView ? null : (
        <View style={[styles.banner, { top: topInset }]} pointerEvents="box-none">
          <TeenWellbeingBanner />
        </View>
      )}
    </ThemedView>
  );
}

function HomeTopBar({ onMedia, fullView }: { onMedia: boolean; fullView: boolean }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const theme = useTheme();
  const router = useRouter();
  const focused = useIsFocused();
  const height = insets.top + BAR_HEIGHT;
  const tint = onMedia ? RAIL_TINT : theme.text;

  return (
    <View style={[styles.bar, { height, paddingTop: insets.top }]} pointerEvents="box-none">
      {focused && onMedia ? <StatusBar style="light" /> : null}
      {/* Soft top fade so the white logo, search and status bar read on bright skies. */}
      {onMedia && !fullView ? (
        <Canvas style={[StyleSheet.absoluteFill, { height: height + 24 }]} pointerEvents="none">
          <Rect x={0} y={0} width={width} height={height + 24}>
            <LinearGradient
              start={vec(0, 0)}
              end={vec(0, height + 24)}
              colors={['rgba(0,0,0,0.38)', 'rgba(0,0,0,0)']}
            />
          </Rect>
        </Canvas>
      ) : null}
      <View style={styles.barRow} pointerEvents="box-none">
        <PhixrLockup height={24} onMedia={onMedia} />
        {fullView ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Search"
            hitSlop={10}
            onPress={() => router.push('/search')}
            style={({ pressed }) => pressed && { opacity: 0.5 }}>
            <Ionicons name="search" size={RAIL_ICON} color={tint} style={onMedia ? styles.iconShadow : null} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', top: 0, left: 0, right: 0 },
  barRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    // The search icon's centre lines up with the rail's icons below it (right: 12).
    paddingLeft: 16,
    paddingRight: 12,
  },
  banner: { position: 'absolute', left: 0, right: 0 },
  iconShadow: Platform.select({
    web: { textShadow: '0px 1px 3px rgba(0,0,0,0.6)' },
    default: {
      textShadowColor: 'rgba(0,0,0,0.6)',
      textShadowRadius: 4,
      textShadowOffset: { width: 0, height: 1 },
    },
  }) as object,
});
