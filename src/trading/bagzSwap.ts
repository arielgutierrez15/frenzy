/**
 * Live swap flow (BAGZ server builds, the wallet signs, BAGZ sends, the chain confirms):
 *   1. /v1/swap/prepare  → Jupiter /build with the 0.50% BAGZ fee, simulated, unsigned transaction + quote
 *   2. wallet signTransaction (the wallet shows the user what they sign)
 *   3. /v1/swap/submit   → the server checks the bytes are unchanged and the signature is valid, then sends once
 *   4. /v1/swap/status   → polled until confirmed/failed/expired; the collected fee is read from the chain
 * Success is only ever reported after step 4 says "confirmed". A timeout is reported as "not confirmed yet", never success.
 */
import { liveTradingEnabled, TradingDisabledError } from './flags';
import { signTransactionB64, type Connected } from './wallet';
import { submitSwap, swapStatus, ApiErr, type Prepared, type SwapStatus } from './api';

export type SwapFlowOutcome =
  | { ok: true; signature: string; feeCollected: string | null; feeMint: string; warning: string | null }
  | { ok: false; stage: 'prepare' | 'sign' | 'submit' | 'confirm'; error: string; signature?: string };

/** a quote is signed only while this much of its server lifetime is left */
export const SIGN_MARGIN_MS = 3_000;

export async function runSwap(p: Prepared, wallet: Connected, hooks: { onStage?: (s: string) => void; sleep?: (ms: number) => Promise<void>; now?: () => number; pollMs?: number; timeoutMs?: number } = {}): Promise<SwapFlowOutcome> {
  if (!liveTradingEnabled()) throw new TradingDisabledError();
  const now = hooks.now || (() => Date.now());
  const sleep = hooks.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (!p.live || !p.transaction || !p.swapId || !p.expiresAt) return { ok: false, stage: 'prepare', error: p.note || 'This quote can’t be signed' };
  if (now() > p.expiresAt - SIGN_MARGIN_MS) return { ok: false, stage: 'prepare', error: 'Quote expired, get a new one' };

  hooks.onStage?.('Waiting for your wallet to sign');
  let signed: string;
  try { signed = await signTransactionB64(wallet, p.transaction); }
  catch (e: any) { return { ok: false, stage: 'sign', error: e?.message || 'Signing failed' }; }
  // the user may have taken a while in the wallet
  if (now() > p.expiresAt) return { ok: false, stage: 'sign', error: 'The quote expired while the wallet was open. Nothing was sent; get a new quote.' };

  hooks.onStage?.('Sending');
  let signature: string;
  try { signature = (await submitSwap(p.swapId, signed)).signature; }
  catch (e: any) {
    const sig = e instanceof ApiErr && e.body && typeof e.body.signature === 'string' ? e.body.signature : undefined;
    // 0 = no answer: the server may or may not have sent it, so the user must check before trying again
    if (e instanceof ApiErr && e.status === 0) return { ok: false, stage: 'submit', error: `${e.message}. The swap may or may not have been sent; check your wallet before retrying.` };
    return { ok: false, stage: 'submit', error: e?.message || 'Sending failed', signature: sig };
  }

  hooks.onStage?.('Confirming on Solana');
  const end = now() + (hooks.timeoutMs ?? 90_000);
  let last: SwapStatus | null = null;
  while (now() < end) {
    await sleep(hooks.pollMs ?? 2000);
    try { last = await swapStatus(p.swapId); } catch { continue; }
    if (last.status === 'confirmed') return { ok: true, signature, feeCollected: last.feeCollected, feeMint: last.feeMint, warning: last.warning };
    if (last.status === 'failed' || last.status === 'expired') return { ok: false, stage: 'confirm', error: last.error || `Swap ${last.status}`, signature };
  }
  return { ok: false, stage: 'confirm', error: 'Sent, but not confirmed yet. Check the transaction before trying again.', signature };
}
