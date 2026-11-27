import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PhixrLockup } from '@/components/brand/phixr-logo';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useTheme } from '@/hooks/use-theme';

type AuthScreenProps = {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Show a back chevron top-left. */
  onBack?: () => void;
  /** Show the phixr lockup centered above the title (entry screens). */
  brand?: boolean;
  /** Sticky footer content (e.g. primary button + links). */
  footer?: ReactNode;
};

/** True while the software keyboard is on screen. */
function useKeyboardVisible() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    // iOS has will-events (no flash); Android only fires did-events.
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(show, () => setVisible(true));
    const b = Keyboard.addListener(hide, () => setVisible(false));
    return () => {
      a.remove();
      b.remove();
    };
  }, []);
  return visible;
}

/** Consistent scaffold for auth screens: safe area, keyboard avoidance, title block. */
export function AuthScreen({ title, subtitle, children, onBack, brand, footer }: AuthScreenProps) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  // While typing, the footer scrolls with the form instead of sticking above the keyboard.
  // Sticky, a tall footer (log in + links + "Create an account") took nearly all the
  // space left above the keyboard and hid the fields under it — on the login screen the
  // password box vanished behind the Log in button (reported 27 Nov).
  const keyboardUp = useKeyboardVisible();
  const footerInline = !!footer && keyboardUp;

  return (
    <ThemedView style={styles.root}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingTop: insets.top + 12, paddingBottom: 24 },
          ]}
          keyboardShouldPersistTaps="handled">
          {onBack ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Go back"
              onPress={onBack}
              hitSlop={10}
              style={styles.back}>
              <Ionicons name="chevron-back" size={26} color={theme.text} />
            </Pressable>
          ) : null}

          {brand ? (
            <View style={styles.brand}>
              <PhixrLockup height={36} />
            </View>
          ) : null}

          <View style={styles.header}>
            <ThemedText type="subtitle">{title}</ThemedText>
            {subtitle ? (
              <ThemedText type="default" themeColor="textSecondary">
                {subtitle}
              </ThemedText>
            ) : null}
          </View>

          <View style={styles.body}>{children}</View>
          {footerInline ? <View style={styles.footerInline}>{footer}</View> : null}
        </ScrollView>

        {footer && !footerInline ? (
          <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>{footer}</View>
        ) : null}
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  content: {
    paddingHorizontal: 24,
    gap: 24,
    flexGrow: 1,
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
  },
  back: { alignSelf: 'flex-start', marginBottom: -8, marginLeft: -6 },
  brand: { alignItems: 'center', paddingTop: 8 },
  header: { gap: 6 },
  body: { gap: 18 },
  footerInline: { gap: 12 },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 12,
    gap: 12,
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
  },
});
