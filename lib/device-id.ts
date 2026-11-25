import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

/**
 * Part 11 ban-evasion signal: a RANDOM install id kept in the keychain (no
 * hardware ids, no fingerprinting). The server only ever receives its
 * SHA-256 hash, written per-account to a moderator-only table. Other users
 * can never query it; it exists solely so fame-admin can surface "these
 * accounts shared a device" when investigating ban evasion.
 */

const KEY = 'phixr.device-id.v1';

async function deviceId(): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  try {
    let id = await SecureStore.getItemAsync(KEY);
    if (!id) {
      id = Crypto.randomUUID();
      await SecureStore.setItemAsync(KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

/** Best-effort: record that the CURRENT account is used on this device. */
export async function recordDevicePresence(): Promise<void> {
  const id = await deviceId();
  if (!id) return;
  try {
    const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, id);
    await supabase.rpc('record_device_presence', {
      _device_hash: hash.toLowerCase(),
      _platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
    });
  } catch {
    // Signal only — never block sign-in on it.
  }
}
