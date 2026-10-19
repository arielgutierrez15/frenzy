/** The small part of TradingView Lightweight Charts v4 that BAGZ uses. */
export type Time = number; // UTCTimestamp, seconds
export interface CandlePoint { time: Time; open: number; high: number; low: number; close: number }
export interface ValuePoint { time: Time; value: number; color?: string }
export interface Marker { time: Time; position: 'aboveBar' | 'belowBar'; color: string; shape: 'arrowUp' | 'arrowDown' | 'circle'; text?: string }
export interface PriceLineOpts { price: number; color: string; lineWidth?: number; lineStyle?: number; axisLabelVisible?: boolean; title?: string }
export interface PriceLine { applyOptions(o: Partial<PriceLineOpts>): void }
export interface Series {
  setData(d: unknown[]): void;
  update(d: unknown): void;
  setMarkers(m: Marker[]): void;
  createPriceLine(o: PriceLineOpts): PriceLine;
  removePriceLine(l: PriceLine): void;
  applyOptions(o: Record<string, unknown>): void;
  priceScale(): { applyOptions(o: Record<string, unknown>): void };
}
export interface CrosshairParam { time?: Time; point?: { x: number; y: number }; seriesData: Map<Series, any> }
export interface TimeScale {
  fitContent(): void;
  scrollToRealTime(): void;
  applyOptions(o: Record<string, unknown>): void;
  setVisibleLogicalRange(r: { from: number; to: number }): void;
}
export interface Chart {
  addCandlestickSeries(o?: Record<string, unknown>): Series;
  addLineSeries(o?: Record<string, unknown>): Series;
  addAreaSeries(o?: Record<string, unknown>): Series;
  addHistogramSeries(o?: Record<string, unknown>): Series;
  removeSeries(s: Series): void;
  priceScale(id: string): { applyOptions(o: Record<string, unknown>): void };
  timeScale(): TimeScale;
  subscribeCrosshairMove(f: (p: CrosshairParam) => void): void;
  unsubscribeCrosshairMove(f: (p: CrosshairParam) => void): void;
  applyOptions(o: Record<string, unknown>): void;
  resize(w: number, h: number): void;
  remove(): void;
}
export interface LwcModule { createChart(el: HTMLElement, o?: Record<string, unknown>): Chart }
