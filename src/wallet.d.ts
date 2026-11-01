export type Hex = `0x${string}`;

/** Secret adapter for a managed vault or another encrypted secret store. Values are strings. */
export interface SecretStore {
  get(key: string): Promise<string | null | undefined> | string | null | undefined;
  set(key: string, value: string): Promise<unknown> | unknown;
}

/** viem-compatible EVM signer; the private key may remain inside a remote signer. */
export interface WalletSigner {
  address: `0x${string}` | string;
  signMessage(args: { message: string }): Promise<Hex> | Hex;
  signTypedData?(args: any): Promise<Hex> | Hex;
}

export interface AgentWalletOptions {
  /** Persistent private directory for the process lock and purchase recovery journals. */
  directory?: string;
  /** Defaults to true for library callers. CLI enables creation only for bootstrap. */
  createIfMissing?: boolean;
  origin?: string;
  fetcher?: typeof fetch;
  /** If supplied, stores all wallet identity and merchant credential state. */
  secretStore?: SecretStore;
  /** Optional remote or hardware signer. Requires secretStore. */
  signer?: WalletSigner;
  /** Prefix used for the secretStore key. Defaults to `402mob/agent-wallet`. */
  secretPrefix?: string;
}

export class WalletError extends Error {}

export class AgentWallet {
  static open(options?: AgentWalletOptions): Promise<AgentWallet>;
  close(): Promise<void>;
  status(): { address: string; network: 'eip155:8453'; origin: string; enrolled: boolean; merchant: unknown };
  bootstrap(name?: string): Promise<unknown>;
  discover(query?: string): Promise<unknown>;
  provider(merchantId: string): Promise<unknown>;
  offers(): Promise<unknown>;
  publish(input: Record<string, unknown>): Promise<unknown>;
  discovery(enabled: boolean): Promise<unknown>;
  sales(): Promise<unknown>;
  inbox(): Promise<unknown>;
  claim(id: string): Promise<unknown>;
  quote(id: string, input: Record<string, unknown>): Promise<unknown>;
  deliver(id: string, input: Record<string, unknown>): Promise<unknown>;
  balance(rpc?: string): Promise<{ address: string; ETH: string; USDC: string }>;
  purchase(input: { id: string; merchantId: string; offerId: string; maxUSDC: string; payee: string }): Promise<unknown>;
  resume(id: string): Promise<unknown>;
  acknowledge(id: string, verdict: 'accepted' | 'disputed'): Promise<unknown>;
}

export const USDC: string;
