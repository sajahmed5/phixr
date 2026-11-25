import { Platform } from 'react-native';

import { getClientSettings, settingNumber } from '@/lib/settings';
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from '@/lib/supabase';

/**
 * In-app purchases for boosts (Part 10 / Part 5 follow-up).
 *
 * expo-iap is a NATIVE module: it does not exist in Expo Go, so it is only
 * ever loaded lazily, and only when the server-side `iap_enabled` setting is
 * on (0 until Saj creates the store products and sets the validation keys).
 * The purchase itself buys nothing directly — the store receipt goes to the
 * iap-validate edge function, which verifies it with Apple/Google and
 * creates the boost server-side (replay-protected).
 *
 * Products (consumables, same IDs in both stores):
 *   phixr.boost.1day / phixr.boost.3day / phixr.boost.7day
 */

export const BOOST_PRODUCTS: Record<string, number> = {
  'phixr.boost.1day': 1,
  'phixr.boost.3day': 3,
  'phixr.boost.7day': 7,
};

export type BoostProduct = { id: string; days: number; displayPrice: string };

type IapModule = typeof import('expo-iap');

let mod: IapModule | null = null;
let connected = false;

/** True when the server says IAP is live AND the native module exists. */
export async function iapAvailable(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  const enabled = settingNumber(await getClientSettings(), 'iap_enabled', 0) >= 1;
  if (!enabled) return false;
  try {
    mod = mod ?? (await import('expo-iap'));
    return true;
  } catch {
    return false; // Expo Go / module missing — points-paid boosts only.
  }
}

async function iap(): Promise<IapModule> {
  if (!mod) mod = await import('expo-iap');
  if (!connected) {
    await mod.initConnection();
    connected = true;
  }
  return mod;
}

/** Store products with localised prices, in day order. */
export async function getBoostProducts(): Promise<BoostProduct[]> {
  const m = await iap();
  const products = await m.fetchProducts({ skus: Object.keys(BOOST_PRODUCTS), type: 'in-app' });
  return (products as { id: string; displayPrice?: string }[])
    .filter((p) => BOOST_PRODUCTS[p.id])
    .map((p) => ({ id: p.id, days: BOOST_PRODUCTS[p.id], displayPrice: p.displayPrice ?? '' }))
    .sort((a, b) => a.days - b.days);
}

export type BoostTargeting = {
  age_bands: string[];
  region_label: string | null;
  tag_ids: string[];
};

/**
 * Buy a boost with money: purchase the consumable, send the receipt to
 * iap-validate (which creates the boost), then finish/consume the
 * transaction. Resolves with the boost id.
 */
export function buyBoost(postId: string, productId: string, targeting: BoostTargeting): Promise<string> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const m = await iap();
      const subs: { remove: () => void }[] = [];
      const cleanup = () => subs.forEach((s) => s.remove());

      subs.push(
        m.purchaseUpdatedListener((purchase) => {
          void (async () => {
            try {
              const p = purchase as unknown as Record<string, unknown>;
              if (p.productId !== productId) return;
              // Unified field in expo-iap v6; legacy fallbacks kept defensively.
              const receipt =
                (p.purchaseToken as string | undefined) ??
                (p.transactionReceipt as string | undefined) ??
                '';
              if (!receipt) throw new Error('No receipt on the purchase.');

              const { data: session } = await supabase.auth.getSession();
              const res = await fetch(`${SUPABASE_URL}/functions/v1/iap-validate`, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${session.session?.access_token}`,
                  apikey: SUPABASE_ANON_KEY,
                  'content-type': 'application/json',
                },
                body: JSON.stringify({
                  platform: Platform.OS === 'ios' ? 'apple' : 'google',
                  productId,
                  receipt,
                  boost: { post_id: postId, ...targeting },
                }),
              });
              const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
              if (!res.ok) throw new Error(String(body.error ?? `Validation failed (${res.status}).`));

              // Server accepted → consume so the product can be bought again.
              await m.finishTransaction({ purchase, isConsumable: true } as never);
              cleanup();
              resolve(String(body.boost_id));
            } catch (e) {
              cleanup();
              reject(e instanceof Error ? e : new Error('Purchase failed.'));
            }
          })();
        }),
      );
      subs.push(
        m.purchaseErrorListener((e: { message?: string }) => {
          cleanup();
          reject(new Error(e?.message ?? 'Purchase cancelled.'));
        }),
      );

      await m.requestPurchase({
        request: { apple: { sku: productId }, google: { skus: [productId] } },
        type: 'in-app',
      } as never);
    })().catch((e) => reject(e instanceof Error ? e : new Error('Purchase failed.')));
  });
}
