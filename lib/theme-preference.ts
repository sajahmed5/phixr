/**
 * App-wide appearance preference: Light (the default), Dark, or Match system.
 * Persisted across sessions. Applied through Appearance.setColorScheme(), which every
 * useColorScheme() in the app already reacts to, so themed components, the navigation
 * chrome and the status bar all follow without further wiring.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance } from 'react-native';

export type ThemePreference = 'light' | 'dark' | 'system';

const KEY = 'fame.theme';

let pref: ThemePreference = 'light';
const listeners = new Set<(p: ThemePreference) => void>();

function apply(p: ThemePreference) {
  try {
    // 'unspecified' = follow the OS again. Optional-called: react-native-web builds
    // that predate setColorScheme simply keep following the browser.
    Appearance.setColorScheme?.(p === 'system' ? 'unspecified' : p);
  } catch {
    // Static rendering on web has no Appearance backing; the client applies it.
  }
}

// Default is light: applied at import time so the very first frame renders light,
// then corrected below if a stored choice says otherwise.
apply(pref);

/** Load the persisted value once (call at startup, alongside the other preferences). */
export async function loadThemePreference(): Promise<void> {
  const v = await AsyncStorage.getItem(KEY).catch(() => null);
  if (v === 'dark' || v === 'system') {
    pref = v;
    apply(v);
    listeners.forEach((l) => l(v));
  }
}

export function getThemePreference(): ThemePreference {
  return pref;
}

export function setThemePreference(next: ThemePreference): void {
  pref = next;
  apply(next);
  listeners.forEach((l) => l(next));
  void AsyncStorage.setItem(KEY, next).catch(() => {});
}

export function subscribeThemePreference(fn: (p: ThemePreference) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
