// Single-file build: bundles the app with esbuild and inlines JS + CSS into one HTML page.
// Usage: node build.mjs            -> dist/frenzy.html (standalone, double-click to open)
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';

const r = await build({
  entryPoints: ['src/main.tsx'], bundle: true, minify: true, write: false, outdir: 'dist',
  jsx: 'automatic', target: 'es2020', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning',
});
const js = r.outputFiles.find((f) => f.path.endsWith('.js')).text;
const css = r.outputFiles.find((f) => f.path.endsWith('.css')).text;
const fonts = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Figtree:wght@400;500;600;700&family=Martian+Mono:wght@400;500;600&display=swap">';
const head = `<title>Frenzy</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<meta name="description" content="Paper-trade memecoins with a live social feed and a Gem Radar for new launches.">\n${fonts}\n<style>${css}</style>`;
const bodyHtml = `<div id="root"></div>\n<script>${js.replace(/<\/script/g, '<\\/script')}</script>`;
mkdirSync('dist', { recursive: true });
// artifact body (the host wraps it in a document skeleton)
writeFileSync('dist/artifact.html', `${head}\n${bodyHtml}\n`);
// standalone file
writeFileSync('dist/frenzy.html', `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${head}</head><body>${bodyHtml}</body></html>\n`);
console.log('built', (js.length / 1024).toFixed(0) + 'KB js', (css.length / 1024).toFixed(0) + 'KB css');
