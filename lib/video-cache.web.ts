/**
 * Web build of the deck video cache: there is no app cache directory on the web
 * (expo-file-system's Directory throws at import time there, which blanked the whole
 * site), and the browser already caches media itself. Videos simply stream.
 */

export function cachedVideoUri(url: string): string {
  return url;
}

export function prefetchVideo(_url: string): void {
  // no-op on web
}
