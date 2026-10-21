// Single-file build: bundles the app with esbuild and inlines JS + CSS into one HTML page.
// Usage: node build.mjs            -> dist/bagz.html (standalone, double-click to open) + docs/index.html (GitHub Pages)
//        BAGZ_PAGE_OUT=/tmp/x.html node build.mjs   -> writes only that page (tests build variants without touching docs/)
import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
const b64 = (f) => 'data:image/png;base64,' + readFileSync(f).toString('base64');

// Use the real `lightweight-charts` package when it is installed (npm install); otherwise the app loads it at runtime.
const lwc = existsSync('node_modules/lightweight-charts') ? 'lightweight-charts' : './src/chart/lwc-none.ts';
console.log('chart library:', lwc === 'lightweight-charts' ? 'bundled from node_modules' : 'runtime load (jsDelivr / docs/vendor)');
const DEMO = process.env.BAGZ_DEMO === '1';
const r = await build({
  entryPoints: [DEMO ? 'src/demo/entry.ts' : 'src/main.tsx'],
  // sql.js only touches these when running under Node; the browser never reaches those branches
  external: DEMO ? ['node:fs', 'node:crypto', 'node:path', 'fs', 'crypto', 'path'] : [], bundle: true, minify: true, write: false, outdir: 'dist',
  alias: { 'bagz-lwc': lwc }, jsx: 'automatic', loader: { '.png': 'dataurl', '.wasm': 'binary', '.sql': 'text' }, target: 'es2020', define: { 'process.env.NODE_ENV': '"production"', __BAGZ_PROXY__: JSON.stringify(process.env.BAGZ_PROXY_URL ?? (process.env.BAGZ_PAGE_OUT ? '' : 'https://bagz-api.bf7p7hyp4d.workers.dev')), __BAGZ_LIVE_TRADING__: JSON.stringify(process.env.BAGZ_LIVE_TRADING || '0') }, logLevel: 'warning',
});
const js = r.outputFiles.find((f) => f.path.endsWith('.js')).text;
const css = r.outputFiles.find((f) => f.path.endsWith('.css')).text;
const fonts = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Figtree:wght@400;500;600;700&family=Martian+Mono:wght@400;500;600&display=swap">';
// Telegram's Mini App script is loaded only when Telegram opened the page (it passes tgWebApp… launch data in the URL,
// and keeps it in sessionStorage across reloads). It must load before the app script, so it is written in synchronously.
const tgLoader = `<script>(function(){try{if(/tgWebApp/.test(location.hash+location.search)||sessionStorage.getItem('__telegram__initParams')){document.write('<script src="https://telegram.org/js/telegram-web-app.js"><\\/script>');}}catch(e){}})();</script>`;
const head = `<title>${DEMO ? 'BAGZ test copy' : 'BAGZ'}</title>\n<meta name="theme-color" content="#090909">\n<link rel="icon" type="image/png" href="${b64('public/favicon.png')}">\n<link rel="apple-touch-icon" href="${b64('public/apple-touch-icon.png')}">\n<meta name="claude:viewport-fit-sides" content="cover">\n<meta name="description" content="Live memecoin charts, a Gem Radar for new launches and a paper-trading desk.">\n${fonts}\n${tgLoader}\n<style>${css}</style>`;
// splash shown while the app script starts (React replaces it); colours are inline so it works before the CSS applies
const boot = `<div class="boot" style="min-height:100vh;display:grid;place-items:center;background:#090909"><img src="${b64('public/boot-badge.png')}" width="72" height="72" alt="BAGZ" style="border-radius:50%"></div>`;
const bodyHtml = `<div id="root">${boot}</div>\n<script>${js.replace(/<\/script/g, '<\\/script')}</script>`;
if (process.env.BAGZ_PAGE_OUT) {
  writeFileSync(process.env.BAGZ_PAGE_OUT, `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${head}</head><body>${bodyHtml}</body></html>\n`);
  console.log('wrote', process.env.BAGZ_PAGE_OUT);
  process.exit(0);
}
mkdirSync('dist', { recursive: true });
// artifact body (the host wraps it in a document skeleton)
writeFileSync('dist/artifact.html', `${head}\n${bodyHtml}\n`);
// standalone file
mkdirSync('docs', { recursive: true });
const page = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${head}</head><body>${bodyHtml}</body></html>\n`;
writeFileSync('docs/index.html', page);
writeFileSync('dist/bagz.html', `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${head}</head><body>${bodyHtml}</body></html>\n`);
console.log('built', (js.length / 1024).toFixed(0) + 'KB js', (css.length / 1024).toFixed(0) + 'KB css');
