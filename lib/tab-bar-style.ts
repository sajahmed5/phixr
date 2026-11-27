import { Platform, type ViewStyle } from 'react-native';

import { TAB_BAR } from '@/constants/config';

/** Home's pill: dark glass over the photo (#77, Option A), in light and dark mode alike. */
export const HOME_TAB_BAR_FILL = 'rgba(18,18,20,0.72)';

/**
 * The floating pill tab bar. Shared by the tabs layout and Home (which swaps the fill and
 * hides it in full view), because a screen's `tabBarStyle` replaces the default outright.
 *
 * Inset with `start`/`end`, NOT `left`/`right`: the tab bar's own base style sets
 * `start: 0, end: 0`, and start/end win over left/right — so `left: 14` was silently
 * ignored and the pill ran edge to edge, where the phone's rounded screen corners cut its
 * ends off (reported on device 27 Nov). Screenshots never showed it: they aren't masked.
 */
export function floatingTabBarStyle(backgroundColor: string): ViewStyle {
  return {
    position: 'absolute',
    start: TAB_BAR.side,
    end: TAB_BAR.side,
    // A fixed gap from the screen edge, level with the iPhone home indicator. Don't
    // derive it from insets.bottom: that floated the pill 19-38pt up.
    bottom: TAB_BAR.bottom,
    height: TAB_BAR.height,
    borderRadius: TAB_BAR.height / 2,
    backgroundColor,
    borderTopWidth: 0,
    paddingHorizontal: 6,
    // The tab bar pads itself by insets.bottom (34pt on iPhone) for a docked bar.
    // Inside a 60pt floating pill that squeezed the icons upward, so turn it off.
    paddingBottom: 0,
    ...Platform.select<ViewStyle>({
      web: { boxShadow: '0px 6px 20px rgba(0,0,0,0.18)' },
      default: {
        shadowColor: '#000',
        shadowOpacity: 0.16,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 5 },
        elevation: 10,
      },
    }),
  };
}
