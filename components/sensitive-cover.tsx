import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';

/**
 * "Sensitive content, tap to view" cover (brief 6B). Adults only — the server
 * never sends sensitive posts to under-18s, so if this renders, the viewer is
 * allowed to reveal it. A near-opaque cover (no native blur module: adding one
 * would change the runtime fingerprint and orphan OTA updates — and covering
 * fully is the safer treatment anyway). Absolute-fill: place inside a
 * relatively-positioned media container.
 */
export function SensitiveCover({ onReveal }: { onReveal: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Sensitive content. Tap to view."
      onPress={onReveal}
      style={styles.fill}>
      <Ionicons name="eye-off-outline" size={34} color="#fff" />
      <ThemedText type="subtitle" style={styles.text}>
        Sensitive content
      </ThemedText>
      <ThemedText type="small" style={styles.sub}>
        Tap to view
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 20,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(12,12,14,0.96)',
  },
  text: { color: '#fff' },
  sub: { color: 'rgba(255,255,255,0.8)' },
});
