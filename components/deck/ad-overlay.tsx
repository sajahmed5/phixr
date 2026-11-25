import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { BRAND } from '@/constants/config';
import { hideAd, recordAdClick } from '@/lib/ads';
import { reportPost } from '@/lib/posts';
import type { DeckCard } from '@/lib/deck';

/**
 * Ad furniture on a deck card (Part 8C): the always-visible "Sponsored"
 * label, the CTA button, and the ⋯ menu — Hide this ad, Report, and
 * "Why am I seeing this ad?" (the server's plain-English reason). The card
 * itself stays swipeable exactly like a post.
 */
export function AdOverlay({ card, isActive }: { card: DeckCard; isActive: boolean }) {
  const [hidden, setHidden] = useState(false);

  const openCta = () => {
    if (!card.cta_url) return;
    if (card.ad_id) recordAdClick(card.ad_id);
    void Linking.openURL(card.cta_url);
  };

  const menu = () => {
    Alert.alert('About this ad', undefined, [
      {
        text: 'Why am I seeing this ad?',
        onPress: () =>
          Alert.alert('Why this ad', card.ad_reason ?? 'This ad is shown broadly to people on Phixr.'),
      },
      {
        text: 'Hide this ad',
        onPress: async () => {
          if (card.ad_id) {
            try {
              await hideAd(card.ad_id);
              setHidden(true);
            } catch {
              // next deal simply may not include it
            }
          }
        },
      },
      {
        text: 'Report ad',
        style: 'destructive',
        onPress: () => {
          reportPost(card.id, 'Inappropriate ad')
            .then(() => Alert.alert('Reported', "Thanks — we'll take a look."))
            .catch(() => Alert.alert("Couldn't report", 'Please try again.'));
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  if (hidden) {
    return (
      <View style={styles.hiddenFill}>
        <Ionicons name="eye-off-outline" size={28} color="#fff" />
        <ThemedText type="smallBold" style={styles.hiddenText}>
          Ad hidden
        </ThemedText>
        <ThemedText type="small" style={styles.hiddenSub}>
          You won&apos;t see this ad again. Swipe to continue.
        </ThemedText>
      </View>
    );
  }

  return (
    <>
      {/* Always-on label + menu (top-left, clear of the action rail). */}
      <View style={styles.topRow} pointerEvents="box-none">
        <View style={styles.sponsoredChip}>
          <ThemedText type="small" style={styles.sponsoredText}>
            Sponsored
          </ThemedText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="About this ad"
          hitSlop={10}
          disabled={!isActive}
          onPress={menu}
          style={styles.menuBtn}>
          <Ionicons name="ellipsis-horizontal" size={18} color="#fff" />
        </Pressable>
      </View>
      {/* CTA above the caption area. */}
      {card.cta_url ? (
        <Pressable
          accessibilityRole="button"
          disabled={!isActive}
          onPress={openCta}
          style={styles.cta}>
          <ThemedText type="smallBold" style={styles.ctaText}>
            {card.cta_label ?? 'Learn more'}
          </ThemedText>
          <Ionicons name="open-outline" size={16} color={BRAND.onAccent} />
        </Pressable>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  topRow: {
    position: 'absolute',
    top: 56,
    left: 14,
    right: 70,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 15,
  },
  sponsoredChip: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  sponsoredText: { color: '#fff', fontWeight: '700' },
  menuBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cta: {
    position: 'absolute',
    bottom: 170,
    left: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: BRAND.accent,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 9,
    zIndex: 15,
  },
  ctaText: { color: BRAND.onAccent },
  hiddenFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 25,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(12,12,14,0.96)',
  },
  hiddenText: { color: '#fff' },
  hiddenSub: { color: 'rgba(255,255,255,0.7)' },
});
