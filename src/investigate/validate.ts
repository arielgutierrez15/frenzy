/**
 * Contract validation for investigation responses. A response that does not match is rejected as a whole, and the panel
 * says the server answered in an unexpected format, rather than drawing a partly understood answer.
 */
import type { ActivityResponse, CacheInfo, Holder, HoldersResponse, TokenEvent } from './types';

export class ContractError extends Error { constructor(message: string) { super(message); this.name = 'ContractError'; } }

export const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DIG = /^\d{1,40}$/;
const PCT = /^\d{1,3}\.\d{4}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

type O = Record<string, any>;
const isObj = (x: unknown): x is O => typeof x === 'object' && x !== null && !Array.isArray(x);
function need(c: unknown, what: string): asserts c { if (!c) throw new ContractError(what); }
const str = (o: O, k: string, re?: RegExp) => { need(typeof o[k] === 'string' && (!re || re.test(o[k])), `${k} is missing or malformed`); return o[k] as string; };
const strOrNull = (o: O, k: string, re?: RegExp) => { need(o[k] === null || (typeof o[k] === 'string' && (!re || re.test(o[k]))), `${k} is malformed`); return o[k] as string | null; };
const int = (o: O, k: string) => { need(Number.isSafeInteger(o[k]) && o[k] >= 0, `${k} is not a whole number`); return o[k] as number; };
const intOrNull = (o: O, k: string) => { need(o[k] === null || (Number.isSafeInteger(o[k]) && o[k] >= 0), `${k} is malformed`); return o[k] as number | null; };
const bool = (o: O, k: string) => { need(typeof o[k] === 'boolean', `${k} is not true/false`); return o[k] as boolean; };
const obj = (o: O, k: string) => { need(isObj(o[k]), `${k} is missing`); return o[k] as O; };
const arr = (o: O, k: string) => { need(Array.isArray(o[k]), `${k} is not a list`); return o[k] as unknown[]; };

function cacheInfo(o: O): CacheInfo {
  const c = obj(o, 'cache');
  bool(c, 'hit'); bool(c, 'stale'); need(typeof c.ageMs === 'number' && c.ageMs >= 0, 'cache.ageMs is malformed');
  return c as CacheInfo;
}

function holder(h: unknown, i: number): Holder {
  need(isObj(h), `holder ${i} is not an object`);
  str(h, 'owner', B58); str(h, 'amount', DIG); strOrNull(h, 'percent', PCT); bool(h, 'percentBelowDisplay');
  need(h.rank === i + 1, `holder ${i} has rank ${h.rank}`);
  const accts = arr(h, 'accounts');
  need(accts.length > 0, `holder ${i} has no token accounts`);
  let sum = 0n;
  for (const a of accts) {
    need(isObj(a), 'token account is not an object');
    str(a, 'address', B58); str(a, 'amount', DIG); strOrNull(a, 'rankingAmount', DIG); bool(a, 'changedSinceRanking');
    need(a.program === 'spl-token' || a.program === 'spl-token-2022', 'token account program is unknown');
    sum += BigInt(a.amount);
  }
  // the owner total must be the exact sum of the listed accounts
  need(sum === BigInt(h.amount), `holder ${i} total does not equal the sum of its accounts`);
  const k = obj(h, 'ownerKind');
  need(['pda', 'wallet', 'wallet_no_sol', 'program', 'program_owned', 'unknown'].includes(k.kind), 'ownerKind is unknown');
  str(k, 'label'); str(k, 'detail');
  return h as unknown as Holder;
}

export function validateHolders(j: unknown, mint: string): HoldersResponse {
  need(isObj(j), 'response is not an object');
  need(j.kind === 'bagz.investigate.holders' && j.version === 1, 'not a version-1 holders response');
  need(j.mint === mint, 'response is for a different token');
  need(j.chain === 'solana' && j.commitment === 'finalized', 'chain or commitment is unexpected');
  str(j, 'provider'); str(j, 'retrievedAt'); int(j, 'observedAt');
  const slots = obj(j, 'slots'); int(slots, 'ranking'); int(slots, 'accounts'); intOrNull(slots, 'owners');
  const t = obj(j, 'token');
  need(t.program === 'spl-token' || t.program === 'spl-token-2022', 'token program is unknown');
  int(t, 'decimals'); need(t.decimals <= 255, 'decimals out of range'); str(t, 'supply', DIG);
  bool(t, 'isWrappedSol'); arr(t, 'extensions'); arr(t, 'decodingGaps');
  const d = obj(j, 'denominator');
  need(['token_supply', 'wrapped_sol_token_supply', 'none'].includes(d.kind), 'denominator kind is unknown');
  str(d, 'raw', DIG); str(d, 'note');
  const hs = arr(j, 'holders').map(holder);
  // ranking must be by amount, largest first
  for (let i = 1; i < hs.length; i++) need(BigInt(hs[i - 1].amount) >= BigInt(hs[i].amount), 'holders are not sorted by balance');
  const owners = new Set(hs.map((h) => h.owner));
  need(owners.size === hs.length, 'an owner appears twice');
  arr(j, 'excluded');
  const c = obj(j, 'coverage');
  need(c.scope === 'largest_token_accounts' && c.completeOwnerRanking === false, 'coverage scope is unexpected');
  int(c, 'tokenAccountsReturned'); int(c, 'tokenAccountsIncluded'); int(c, 'ownerCount'); str(c, 'includedRaw', DIG); strOrNull(c, 'includedPercent', PCT); str(c, 'description');
  need(c.ownerCount === hs.length, 'coverage owner count does not match');
  need(BigInt(c.includedRaw) === hs.reduce((a, h) => a + BigInt(h.amount), 0n), 'coverage total does not match the holders');
  const k = obj(j, 'consistency'); int(k, 'rankingSlot'); int(k, 'accountsSlot'); int(k, 'changedAccounts'); str(k, 'note');
  need(Array.isArray(j.connections) && j.connections.length === 0, 'unexpected connections in a balance snapshot');
  cacheInfo(j);
  return j as unknown as HoldersResponse;
}

function event(e: unknown, account: string): TokenEvent {
  need(isObj(e), 'event is not an object');
  str(e, 'signature', SIG); str(e, 'path', /^\d{1,3}(\.\d{1,3})?$/); int(e, 'outerIndex'); intOrNull(e, 'innerIndex');
  need(e.path === (e.innerIndex === null ? `${e.outerIndex}` : `${e.outerIndex}.${e.innerIndex}`), 'event path does not match its indexes');
  need(['transfer', 'mint', 'burn'].includes(e.kind), 'event kind is unknown');
  need(['in', 'out', 'self'].includes(e.direction), 'event direction is unknown');
  need(e.context === 'top_level' || e.context === 'inner', 'event context is unknown');
  str(e, 'amount', DIG); strOrNull(e, 'feeAmount', DIG); intOrNull(e, 'slot'); intOrNull(e, 'blockTime');
  strOrNull(e, 'sourceAccount', B58); strOrNull(e, 'destinationAccount', B58); strOrNull(e, 'sourceOwner', B58); strOrNull(e, 'destinationOwner', B58);
  strOrNull(e, 'outerProgramId', B58); str(e, 'programId', B58); str(e, 'interpretation');
  // an event is only listed when it touches the requested account
  need(e.sourceAccount === account || e.destinationAccount === account, 'event does not involve the requested account');
  return e as unknown as TokenEvent;
}

export function validateActivity(j: unknown, mint: string, account: string): ActivityResponse {
  need(isObj(j), 'response is not an object');
  need(j.kind === 'bagz.investigate.activity' && j.version === 1, 'not a version-1 activity response');
  need(j.mint === mint && j.account === account, 'response is for a different token or account');
  need(j.chain === 'solana' && j.commitment === 'finalized', 'chain or commitment is unexpected');
  str(j, 'provider'); str(j, 'retrievedAt'); int(j, 'observedAt');
  const ta = obj(j, 'tokenAccount'); strOrNull(ta, 'owner', B58); strOrNull(ta, 'amount', DIG); intOrNull(ta, 'decimals'); int(ta, 'slot');
  const evs = arr(j, 'transfers').map((e) => event(e, account));
  const keys = new Set(evs.map((e) => `${e.signature}#${e.path}`));
  need(keys.size === evs.length, 'an event appears twice');
  const c = obj(j, 'coverage');
  need(c.scope === 'recent_signatures_for_token_account', 'coverage scope is unexpected');
  for (const k of ['limit', 'signaturesReturned', 'successfulSignatures', 'failedSignaturesSkipped', 'transactionsParsed', 'missingTransactionBodies', 'transactionFetchErrors', 'eventsFound']) int(c, k);
  bool(c, 'complete'); strOrNull(c, 'nextBefore', SIG); str(c, 'description');
  need(c.eventsFound === evs.length, 'coverage event count does not match');
  need(c.successfulSignatures <= c.signaturesReturned && c.signaturesReturned <= c.limit, 'coverage counts are inconsistent');
  cacheInfo(j);
  return j as unknown as ActivityResponse;
}
