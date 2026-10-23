import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev` only. The real site is built by build.mjs (`npm run build`), which Cloudflare Pages and GitHub Pages use.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { 'bagz-lwc': 'lightweight-charts' } },
  define: {
    __BAGZ_PROXY__: JSON.stringify(process.env.BAGZ_PROXY_URL ?? 'https://bagz-api.bf7p7hyp4d.workers.dev'),
    __BAGZ_LIVE_TRADING__: JSON.stringify(process.env.BAGZ_LIVE_TRADING || '0'),
  },
});
