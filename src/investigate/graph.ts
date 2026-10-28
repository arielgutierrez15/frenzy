/**
 * Connections for the holder map, built ONLY from decoded token transfers the user has loaded.
 *  - wallet → wallet edge: both ends' owners were resolved from the transaction's own token-balance records
 *  - token-account link: one end's owner could not be resolved; that end is shown as "unknown token account",
 *    never merged into a wallet and never counted as a wallet connection
 *  - mint/burn events and transfers between two accounts of the same owner draw nothing
 * Nothing is inferred from balances, timing or shared counterparties. Shared-funder analysis is not implemented.
 */
import type { Holder, TokenEvent } from './types';

export type NodeKind = 'holder' | 'owner' | 'unknown_account';
export interface GraphNode { id: string; kind: NodeKind; owner?: string; account?: string; holderRank?: number }
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  /** wallet = both owners resolved; account = at least one end is an unresolved token account */
  evidence: 'wallet' | 'account';
  /** top_level = every transfer was a top-level token instruction; inner = all inside another program; mixed = both */
  context: 'top_level' | 'inner' | 'mixed';
  events: TokenEvent[];
  /** exact raw-unit sum of the transfers on this edge */
  total: string;
}
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[]; selfTransfers: number; walletEdges: number; accountLinks: number }

export const nodeIdOwner = (o: string) => `o:${o}`;
export const nodeIdAccount = (a: string) => `a:${a}`;

export function buildGraph(holders: Holder[], events: TokenEvent[]): Graph {
  const holderBy = new Map(holders.map((h) => [h.owner, h]));
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge & { sum: bigint }>();
  const seen = new Set<string>();
  let selfTransfers = 0;
  const endpoint = (owner: string | null, account: string | null): GraphNode | null => {
    if (owner) {
      const id = nodeIdOwner(owner);
      if (!nodes.has(id)) { const h = holderBy.get(owner); nodes.set(id, h ? { id, kind: 'holder', owner, holderRank: h.rank } : { id, kind: 'owner', owner }); }
      return nodes.get(id)!;
    }
    if (account) {
      const id = nodeIdAccount(account);
      if (!nodes.has(id)) nodes.set(id, { id, kind: 'unknown_account', account });
      return nodes.get(id)!;
    }
    return null;
  };
  for (const e of events) {
    if (e.kind !== 'transfer') continue;
    const k = `${e.signature}#${e.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (e.sourceOwner && e.destinationOwner && e.sourceOwner === e.destinationOwner) { selfTransfers++; continue; }
    if (e.sourceAccount && e.sourceAccount === e.destinationAccount) { selfTransfers++; continue; }
    const a = endpoint(e.sourceOwner, e.sourceAccount), b = endpoint(e.destinationOwner, e.destinationAccount);
    if (!a || !b) continue;
    const evidence: GraphEdge['evidence'] = a.kind !== 'unknown_account' && b.kind !== 'unknown_account' ? 'wallet' : 'account';
    const id = `${a.id}>${b.id}`;
    const ctx: GraphEdge['context'] = e.context === 'inner' ? 'inner' : 'top_level';
    const cur = edges.get(id);
    if (!cur) edges.set(id, { id, from: a.id, to: b.id, evidence, context: ctx, events: [e], total: e.amount, sum: BigInt(e.amount) });
    else { cur.events.push(e); cur.sum += BigInt(e.amount); cur.total = cur.sum.toString(); if (cur.context !== ctx) cur.context = 'mixed'; }
  }
  // holders without edges are drawn by the map anyway; only connected non-holder nodes are returned here
  const used = new Set<string>();
  for (const e of edges.values()) { used.add(e.from); used.add(e.to); }
  const list = [...edges.values()].map(({ sum: _s, ...e }) => e);
  return {
    nodes: [...nodes.values()].filter((n) => used.has(n.id)),
    edges: list,
    selfTransfers,
    walletEdges: list.filter((e) => e.evidence === 'wallet').length,
    accountLinks: list.filter((e) => e.evidence === 'account').length,
  };
}
