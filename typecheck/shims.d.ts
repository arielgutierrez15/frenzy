// Only used by tsconfig.check.json when @types/react isn't installed (offline sandbox).
declare namespace React { type FormEvent<T = any> = any; type PointerEvent<T = any> = any; type ReactNode = any; type RefObject<T> = { current: T | null }; type CSSProperties = any; }
declare module 'react' {
  export const useState: <T = any>(i?: T | (() => T)) => [T, (v: T | ((p: T) => T)) => void];
  export const useRef: <T = any>(i?: T | null) => { current: T };
  export const useMemo: <T = any>(f: () => T, d?: any[]) => T;
  export const useCallback: <T = any>(f: T, d?: any[]) => T;
  export const useEffect: (f: () => any, d?: any[]) => void;
  export const useLayoutEffect: (f: () => any, d?: any[]) => void;
  export const createContext: <T = any>(d: T) => { Provider: any };
  export const useContext: <T = any>(c: { Provider: any } | any) => T;
  export const useSyncExternalStore: <T = any>(sub: any, get: () => T, ssr?: () => T) => T;
  export const StrictMode: any, Fragment: any;
  export type FormEvent<T = any> = any; export type PointerEvent<T = any> = any; export type ReactNode = any; export type RefObject<T> = { current: T | null };
  const React: any; export default React;
}
declare module 'react/jsx-runtime' { export const jsx: any, jsxs: any, Fragment: any; }
declare module 'react-dom/client' { export const createRoot: any; }
declare module '*.css' { const x: string; export default x; }
declare namespace JSX { interface IntrinsicElements { [k: string]: any } interface IntrinsicAttributes { key?: any } interface ElementChildrenAttribute { children: {} } interface Element {} }
