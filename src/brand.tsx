import wordmark from './assets/bagz-wordmark.png';
import emblem from './assets/bagz-emblem.png';

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
