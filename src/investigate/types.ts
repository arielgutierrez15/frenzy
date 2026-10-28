/**
 * Contract of the BAGZ Worker's read-only investigation routes (worker/investigate.js, version 1).
 * Every response is checked against this shape (validate.ts) before anything is drawn.
 * Token amounts are integer strings in the mint's raw units; they are never turned into floats for arithmetic.
 */
export interface CacheInfo { hit: boolean; shared: boolean; ageMs: number; stale: boolean; staleCode?: string; staleReason?: string }

export type OwnerKindId = 'pda' | 'wallet' | 'wallet_no_sol' | 'program' | 'program_owned' | 'unknown';
export interface OwnerKind { kind: OwnerKindId; label: string; detail: string; programOwner: string | null; programOwnerLabel: string | null }

export interface HolderAccount {
  address: string;
  amount: string;
  rankingAmount: string | null;
  changedSinceRanking: boolean;
  state: string | null;
  program: 'spl-token' | 'spl-token-2022';
}
export interface Holder {
  rank: number;
  owner: string;
  amount: string;
  /** percent of the denominator, truncated to 4 decimals (string); null when there is no usable denominator */
  percent: string | null;
  percentBelowDisplay: boolean;
  accounts: HolderAccount[];
  balanceScope: 'selected_accounts_only';
  ownerKind: OwnerKind;
}
export interface TokenFacts {
  program: 'spl-token' | 'spl-token-2022';
  decimals: number;
  supply: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: string[];
  decodingGaps: { extension: string; note: string }[];
  isWrappedSol: boolean;
}
export interface HoldersResponse {
  kind: 'bagz.investigate.holders';
  version: 1;
  chain: 'solana';
  mint: string;
  provider: string;
  commitment: 'finalized';
  retrievedAt: string;
  observedAt: number;
  slots: { ranking: number; accounts: number; owners: number | null };
  token: TokenFacts;
  denominator: { kind: 'token_supply' | 'wrapped_sol_token_supply' | 'none'; raw: string; slot: number; note: string };
  holders: Holder[];
  excluded: { address: string; reason: string; detail: string }[];
  coverage: {
    scope: 'largest_token_accounts'; maxTokenAccounts: number; tokenAccountsReturned: number; tokenAccountsIncluded: number; tokenAccountsExcluded: number;
    ownerCount: number; includedRaw: string; includedPercent: string | null; completeOwnerRanking: false; ownersNote: string | null; description: string;
  };
  consistency: { rankingSlot: number; accountsSlot: number; changedAccounts: number; note: string };
  connections: [];
  connectionStatus: string;
  cache: CacheInfo;
}

export interface TokenEvent {
  signature: string;
  /** "3" = outer instruction 3, "3.1" = inner instruction 1 of outer 3 (both 0-based) */
  path: string;
  outerIndex: number;
  innerIndex: number | null;
  instructionType: string;
  programId: string;
  outerProgramId: string | null;
  outerProgramLabel: string | null;
  invokedBy: string | null;
  invokedByLabel: string | null;
  stackHeight: number | null;
  slot: number | null;
  blockTime: number | null;
  kind: 'transfer' | 'mint' | 'burn';
  direction: 'in' | 'out' | 'self';
  amount: string;
  feeAmount: string | null;
  sourceAccount: string | null;
  destinationAccount: string | null;
  sourceOwner: string | null;
  destinationOwner: string | null;
  sourceOwnerNote: string | null;
  destinationOwnerNote: string | null;
  authority: string | null;
  context: 'top_level' | 'inner';
  interpretation: string;
}
export interface ActivityResponse {
  kind: 'bagz.investigate.activity';
  version: 1;
  chain: 'solana';
  mint: string;
  account: string;
  provider: string;
  commitment: 'finalized';
  retrievedAt: string;
  observedAt: number;
  tokenAccount: { owner: string | null; amount: string | null; decimals: number | null; state: string | null; slot: number; program: string };
  transfers: TokenEvent[];
  slots: { account: number; newestSignature: number | null; oldestSignature: number | null };
  coverage: {
    scope: 'recent_signatures_for_token_account'; limit: number; before: string | null;
    signaturesReturned: number; successfulSignatures: number; failedSignaturesSkipped: number; signaturesWithUnknownStatus: number;
    transactionsParsed: number; missingTransactionBodies: number; transactionFetchErrors: number; transactionsNotFetched: number; failedOnRead: number;
    eventsFound: number; otherAccountTransfers: number; otherMintTransfers: number; unresolvedMintTransfers: number; unreadable: number;
    complete: boolean; haltedBy: string | null; nextBefore: string | null; description: string;
  };
  cache: CacheInfo;
}

/** what went wrong, as one of a fixed set of states the panel knows how to explain */
export type InvestigateErrorCode =
  | 'no_server' | 'demo_unavailable' | 'unsupported_chain' | 'invalid_mint' | 'invalid_account' | 'account_not_found' | 'account_mint_mismatch'
  | 'provider_not_configured' | 'provider_auth' | 'rate_limited' | 'provider_error' | 'timeout' | 'network' | 'malformed' | 'origin_refused' | 'aborted' | 'unknown';
