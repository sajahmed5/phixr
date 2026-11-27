import { Ionicons } from '@expo/vector-icons';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

/**
 * Short Instagram-style heart pop over media (#68): a quick scale-in with a
 * touch of overshoot, a beat on screen, then a fade — ~550ms end to end,
 * deliberately not dramatic. Fire it by incrementing `trigger` (0 = never
 * fired). White with a soft shadow so it reads on any photo; ignores touches.
 */
export function HeartBurst({ trigger, size = 72 }: { trigger: number; size?: number }) {
  const scale = useSharedValue(0);
  const opacity = useSharedValue(0);

  useEffect(() => {
    if (trigger === 0) return;
    scale.value = 0;
    opacity.value = withSequence(
      withTiming(1, { duration: 80 }),
      withDelay(220, withTiming(0, { duration: 170, easing: Easing.in(Easing.quad) })),
    );
    scale.value = withSequence(
      withTiming(1.1, { duration: 150, easing: Easing.out(Easing.back(1.8)) }),
      withTiming(1, { duration: 100 }),
    );
  }, [trigger, scale, opacity]);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
      <Animated.View style={style}>
        <Ionicons name="heart" size={size} color="#fff" style={styles.heart} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  heart: {
    textShadowColor: 'rgba(0,0,0,0.35)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },
});
