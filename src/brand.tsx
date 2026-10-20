import wordmark from './assets/bagz-wordmark.png';
import emblem from './assets/bagz-emblem.png';
import badge from './assets/bagz-badge.png';
import mark from './assets/bagz-mark.png';

export const BRAND_NAME = 'BAGZ';
export const BRAND_TAGLINE = 'memecoin desk';

/** The uploaded BAGZ wordmark (the gorilla sits inside the "b"). */
export function Wordmark({ className = 'brand-mark' }: { className?: string }) {
  return <img className={className} src={wordmark} alt="BAGZ" draggable={false} />;
}
/** The uploaded BAGZ app emblem (rounded square with the gorilla). */
export function Emblem({ className = 'brand-emblem' }: { className?: string }) {
  return <img className={className} src={emblem} alt="BAGZ" draggable={false} />;
}
/** The round gorilla on hot pink (favicon, loading, avatars, empty states). */
export function Badge({ className = 'brand-badge' }: { className?: string }) {
  return <img className={className} src={badge} alt="" aria-hidden="true" draggable={false} />;
}
/** The gorilla head alone, transparent (for pink or light backgrounds and the trading card). */
export function Mark({ className = 'brand-mark-head' }: { className?: string }) {
  return <img className={className} src={mark} alt="" aria-hidden="true" draggable={false} />;
}
export const BADGE_SRC = badge;
