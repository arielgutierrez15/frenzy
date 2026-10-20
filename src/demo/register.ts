/** TEST COPY ONLY: plugs the in-page server into the app before it starts (see server.ts). */
import { DEMO_BASE, demoFetch, demoAvatar, subscribePics, picVersion, resetTestCopy } from './server';
(globalThis as any).__BAGZ_DEMO__ = { base: DEMO_BASE, fetch: demoFetch, avatar: demoAvatar, subscribe: subscribePics, version: picVersion, reset: resetTestCopy };
