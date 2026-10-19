// Build stand-in used when the `lightweight-charts` npm package isn't installed. The app then loads the library at
// runtime (vendored copy first, then a pinned jsDelivr URL) and falls back to the built-in SVG chart if that fails.
export const available = false;
