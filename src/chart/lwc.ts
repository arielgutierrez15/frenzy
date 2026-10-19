import * as bundled from 'bagz-lwc';
import type { LwcModule } from './lwc-types';

/** Pinned release. The vendored copy (docs/vendor/) is tried first so the app can run without a CDN. */
export const LWC_VERSION = '4.2.0';
const SOURCES = [
  './vendor/lightweight-charts.standalone.production.js',
  `https://cdn.jsdelivr.net/npm/lightweight-charts@${LWC_VERSION}/dist/lightweight-charts.standalone.production.js`,
];

let pending: Promise<LwcModule | null> | null = null;

function inject(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => { s.remove(); resolve(false); };
    document.head.appendChild(s);
  });
}

/** Resolves to the Lightweight Charts module, or null when it can't be loaded (the UI then shows the basic chart). */
export function getLwc(): Promise<LwcModule | null> {
  if ((bundled as any)?.createChart) return Promise.resolve(bundled as unknown as LwcModule);
  const w = window as any;
  if (w.LightweightCharts?.createChart) return Promise.resolve(w.LightweightCharts as LwcModule);
  if (!pending) {
    pending = (async () => {
      for (const src of SOURCES) {
        if (await inject(src) && w.LightweightCharts?.createChart) return w.LightweightCharts as LwcModule;
      }
      pending = null; // allow a retry on the next chart that opens
      return null;
    })();
  }
  return pending;
}
