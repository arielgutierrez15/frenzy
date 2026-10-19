import React, { useSyncExternalStore } from 'react';
import { useStore } from './store';
import { getHealth, healthVersion, subscribeHealth, cooldownUntil, type SourceHealth } from './providers/http';
import { PROVIDERS, type ProviderId } from './providers/registry';
import { proxyBase } from './providers/config';
import { ago } from './format';

export function useHealth(): SourceHealth[] {
  useSyncExternalStore((l) => subscribeHealth(l), healthVersion);
  return getHealth();
}

const WHY: Record<string, string> = {
  network: 'blocked, offline or refused by the provider',
  timeout: 'timed out',
  'rate-limited': 'rate limited',
  cooldown: 'cooling down after a rate limit',
  invalid: 'sent a response BAGZ could not validate',
  http: 'returned an error',
};

/** Real freshness and health for every data source. Nothing here is estimated: times are when the provider answered. */
export function HealthPanel() {
  const st = useStore();
  const health = useHealth();
  const proxy = proxyBase();
  const byProv = new Map<ProviderId, SourceHealth[]>();
  for (const x of health) (byProv.get(x.provider) ?? byProv.set(x.provider, []).get(x.provider)!).push(x);
  const pumpDown = ['pumpfun', 'pump-live'].some((k) => st.sources[k]?.ok === false);
  const derived = Object.values(st.coins).filter((c) => c.launchpad === 'pump.fun' && !c.sources.some((s) => s === 'pumpfun' || s === 'pump-live')).length;

  return (
    <div className="panel" id="data-health">
      <div className="row gap-s wrap"><h2>Data sources</h2><span className="grow" />
        <span className={`pill ${proxy ? 'pill-up' : 'pill-warn'}`}>{proxy ? 'via BAGZ proxy' : 'direct from your browser'}</span></div>
      <p className="muted small">{proxy ? 'Requests go through the BAGZ proxy, which holds API keys and caches at the edge.' : 'No BAGZ proxy is configured, so each site is called directly. Some providers (pump.fun, rate-limited APIs) may refuse browsers. See the README to deploy the proxy.'}</p>
      {!health.length && <p className="muted small">Waiting for the first responses…</p>}
      {[...byProv.entries()].map(([pid, rows]) => {
        const p = PROVIDERS[pid];
        const cd = cooldownUntil(pid);
        return (
          <div key={pid}>
            <div className="hgroup">{p.label}{!p.official && <span className="pill pill-unofficial">unofficial</span>}{cd > Date.now() && <span className="pill pill-warn">cooling down {Math.ceil((cd - Date.now()) / 1000)}s</span>}</div>
            <ul className="health">
              {rows.map((x) => (
                <li key={x.source}>
                  <span className={`hdot hdot-${x.status}`} title={x.status} />
                  <span className="hl-name">
                    <span>{x.label}</span>
                    {x.status !== 'ok' && x.lastError && <span className="hl-err">{x.servedStale ? 'Showing the last good answer. ' : ''}{x.lastError}{x.errorKind && WHY[x.errorKind] && !x.lastError.toLowerCase().includes(WHY[x.errorKind]) ? ` (${WHY[x.errorKind]})` : ''}</span>}
                  </span>
                  <span className="hl-meta num">{x.lastOkAt ? `${ago(x.lastOkAt)} ago` : 'never'}{x.latencyMs !== undefined ? ` · ${x.latencyMs}ms` : ''}</span>
                </li>
              ))}
            </ul>
            {p.note && rows.some((x) => x.status !== 'ok') && <p className="muted small">{p.note}</p>}
          </div>
        );
      })}
      {pumpDown && <p className="small warn">pump.fun has no supported public API, so its new-coin and livestream feeds are unavailable{derived ? `. ${derived} pump.fun coin${derived > 1 ? 's' : ''} still appear via Jupiter and GeckoTerminal launch data` : ''}. Livestream status is not shown for coins without that feed.</p>}
    </div>
  );
}
