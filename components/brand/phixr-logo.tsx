import { SvgXml } from 'react-native-svg';

import { useColorScheme } from '@/hooks/use-color-scheme';

import { LOCKUP_DARK, LOCKUP_LIGHT, MARK } from './phixr-svg';

const LOCKUP_RATIO = 1020 / 300; // lockup viewBox aspect

/**
 * The phixr lockup: the tumbling-cards mark + "phixr" wordmark. Theme-aware — the
 * wordmark is the orange gradient on light backgrounds and white on dark ones.
 * Size it by `height`; width is derived from the lockup's aspect ratio.
 */
export function PhixrLockup({ height = 28, onMedia = false }: { height?: number; onMedia?: boolean }) {
  const scheme = useColorScheme();
  // On a photo (Home's full-screen feed) the white wordmark reads on any image.
  const xml = onMedia || scheme === 'dark' ? LOCKUP_DARK : LOCKUP_LIGHT;
  return (
    <SvgXml
      xml={xml}
      width={Math.round(height * LOCKUP_RATIO)}
      height={height}
      accessibilityRole="image"
      accessibilityLabel="phixr"
    />
  );
}

/** Just the tumbling-cards mark (the app icon glyph), square. */
export function PhixrMark({ size = 32 }: { size?: number }) {
  return <SvgXml xml={MARK} width={size} height={size} accessibilityRole="image" accessibilityLabel="phixr" />;
}
