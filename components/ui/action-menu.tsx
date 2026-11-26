import { useRef } from 'react';
import { Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useTheme } from '@/hooks/use-theme';
import { useAndroidBack } from '@/lib/use-android-back';

export type ActionOption = {
  label: string;
  onPress: () => void;
  destructive?: boolean;
};

/**
 * Bottom-anchored action sheet. Shown in its own transparent Modal so it always sits
 * above the floating tab bar and every other overlay, with room for the home indicator.
 */
export function ActionMenu({
  visible,
  title,
  options,
  onClose,
  emojis,
  onEmoji,
}: {
  visible: boolean;
  title?: string;
  options: ActionOption[];
  onClose: () => void;
  /** One horizontal row of quick reactions at the top (#36) — replaces listing each
   *  emoji as its own full-width option row. */
  emojis?: string[];
  onEmoji?: (emoji: string) => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  useAndroidBack(visible, onClose); // hardware back dismisses the menu, not the screen
  // The chosen action runs once the menu has fully closed: on iOS a sheet, alert or
  // picker opened while this Modal is still dismissing is silently dropped.
  const pending = useRef<(() => void) | null>(null);
  const choose = (fn: () => void) => {
    if (Platform.OS === 'ios') pending.current = fn;
    onClose();
    if (Platform.OS !== 'ios') fn();
  };
  const runPending = () => {
    const fn = pending.current;
    pending.current = null;
    fn?.();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
      onDismiss={runPending}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Dismiss menu" />
        <ThemedView
          style={[styles.menu, { borderColor: theme.border, paddingBottom: insets.bottom + 8 }]}>
          {title ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.title}>
              {title}
            </ThemedText>
          ) : null}
          {emojis && onEmoji ? (
            <View style={styles.emojiRow}>
              {emojis.map((e) => (
                <Pressable
                  key={e}
                  accessibilityRole="button"
                  accessibilityLabel={`React ${e}`}
                  onPress={() => choose(() => onEmoji(e))}
                  style={({ pressed }) => [
                    styles.emojiBtn,
                    pressed && { backgroundColor: theme.backgroundElement },
                  ]}>
                  <ThemedText style={styles.emoji}>{e}</ThemedText>
                </Pressable>
              ))}
            </View>
          ) : null}
          {options.map((o, i) => (
            <Pressable
              key={o.label}
              accessibilityRole="button"
              onPress={() => choose(o.onPress)}
              style={({ pressed }) => [
                styles.option,
                i > 0 && { borderTopColor: theme.border, borderTopWidth: StyleSheet.hairlineWidth },
                pressed && { backgroundColor: theme.backgroundElement },
              ]}>
              <ThemedText
                type="default"
                style={{ color: o.destructive ? theme.danger : theme.text }}>
                {o.label}
              </ThemedText>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={({ pressed }) => [
              styles.cancel,
              { backgroundColor: theme.backgroundElement },
              pressed && { opacity: 0.8 },
            ]}>
            <ThemedText type="default" style={{ fontWeight: '700' }}>
              Cancel
            </ThemedText>
          </Pressable>
        </ThemedView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    zIndex: 50,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  menu: {
    padding: 8,
    gap: 4,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  title: { textAlign: 'center', paddingVertical: 8 },
  emojiRow: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 6 },
  emojiBtn: { padding: 8, borderRadius: 12 },
  emoji: { fontSize: 28, lineHeight: 34 },
  option: { paddingVertical: 16, alignItems: 'center' },
  cancel: { marginTop: 6, paddingVertical: 16, alignItems: 'center', borderRadius: 12 },
});
