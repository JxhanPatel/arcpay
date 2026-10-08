import { useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  LoaderCircle,
  Lock,
  RefreshCcw,
  ScanLine,
  Send,
  Settings,
  Upload,
  Users,
  Wallet,
  Download,
  QrCode,
  Trash2,
  Search,
  Plus,
  X,
} from 'lucide-react';
import logoUrl from './assets/logo.png';
import logoForQrUrl from './assets/logo-for-qr.png';
import usdcSvg from './assets/usdc.svg';
import eurcSvg from './assets/eurc.svg';
import cirbtcSvg from './assets/cirbtc.svg';
import { QRCodeSVG } from 'qrcode.react';
import { BrowserQRCodeReader } from '@zxing/browser';
import {
  buildRequestLink,
  filterNonZeroAssetBalances,
  formatDisplayBalance,
  formatTokenBalance,
  getAssetDecimals,
  getAssetUsdValue,
  getTransactionDisplayMeta,
  isStableUsdPegged,
  parseNativeBalance,
  parseTokenBalances,
  parseTransactionDirection,
} from './balance';
import { buildFeeSummary, formatGasFeeUsdc } from './gasEstimate';
import {
  type Contact,
  formatContactLabel,
  getContacts,
  removeContact,
  saveContact,
  filterContacts,
} from './contacts';
import { resolveArcName } from './utils/arcName';
import {
  decryptPrivateKey,
  encryptPrivateKey,
  getVaultFromStorage,
  parseVaultPayload,
  removeSeedVaultFromStorage,
  removeVaultFromStorage,
  serializeVaultPayload,
  setVaultInStorage,
} from './utils/pinVault';
import {
  decryptWallet,
  encryptWallet,
  getKeystoreFromStorage,
  hasLegacyKey,
  removeKeystoreFromStorage,
  setKeystoreInStorage,
  STORAGE_KEY_LEGACY,
} from './utils/walletStorage';
import {
  ADD_ACCOUNT_UNAVAILABLE_MESSAGES,
  addDerivedAccount,
  clearSessionSeed,
  getActiveAccountIndex,
  getAddAccountUnavailableReason,
  getKeystoreForAccount,
  getSessionSeed,
  getStoredAccountsMeta,
  loadSessionSeedFromVault,
  migrateLegacyKeystoreToIndexZero,
  persistSeedVault,
  removeAccount,
  removeAllAccountData,
  renameAccount,
  saveAccountsMeta,
  setActiveAccountIndex,
  setKeystoreForAccount,
  setSessionSeed,
  type AccountMeta,
} from './accounts';

const ARC_RPC_URL = 'https://rpc.testnet.arc.network';
const ARC_CHAIN_ID = 5042002;
const ARC_NETWORK_NAME = 'Arc Testnet';
const ARC_CURRENCY_SYMBOL = 'USDC';
const EXPLORER_URL = 'https://explorer.testnet.arc.io';
const ARC_EXPLORER_API_URL = 'https://explorer.testnet.arc.io/api/v2';
const NATIVE_VALUE_DECIMALS = 18;
export const ERC20_TRANSFER_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];
const ASSET_ICON_URLS: Record<string, string> = {
  USDC: usdcSvg,
  EURC: eurcSvg,
  cirBTC: cirbtcSvg,
  CIRBTC: cirbtcSvg,
};

export type SendAssetPlan =
  | {
      kind: 'native';
      tx: {
        to: string;
        value: bigint;
      };
    }
  | {
      kind: 'token';
      tokenAddress: string;
      abi: string[];
      args: [string, bigint];
    };

export const buildSendTransactionPlan = (
  selectedSendAsset: { key: string; symbol: string; balance: string; decimals?: number },
  resolvedRecipient: string,
  sendAmount: string,
): SendAssetPlan => {
  if (selectedSendAsset.symbol === 'USDC') {
    // Native value on Arc is always 18-decimal EVM base units, regardless of USDC's 6 display decimals.
    const value = ethers.parseUnits(sendAmount, NATIVE_VALUE_DECIMALS);
    return {
      kind: 'native',
      tx: {
        to: resolvedRecipient,
        value,
      },
    };
  }

  // ERC-20 token transfers use the token's own decimals (e.g. 6 for EURC).
  const decimals = selectedSendAsset.decimals ?? 6;
  const value = ethers.parseUnits(sendAmount, decimals);

  const tokenAddress = selectedSendAsset.key;
  if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
    throw new Error(`Unable to determine the ${selectedSendAsset.symbol} contract address.`);
  }

  return {
    kind: 'token',
    tokenAddress,
    abi: ERC20_TRANSFER_ABI,
    args: [resolvedRecipient, value],
  };
};

// ---------------------------------------------------------------------------
// Optimistic post-send updates
//
// A send should be reflected in Holdings and in history the moment
// wallet.sendTransaction (or the ERC-20 transfer call) resolves — i.e. as soon
// as we hold a tx hash — not several seconds later when the explorer poll
// indexes it. The pure helpers below produce every state transition used by
// `handleSend`; keeping them pure makes the per-asset decimals handling
// directly unit-testable without touching a live RPC.
// ---------------------------------------------------------------------------

export type SendableAssetEntry = {
  key: string;
  symbol: string;
  balance: string;
  decimals: number;
};

export type OptimisticBalanceSnapshot = {
  balance: string;
  assetBalances: SendableAssetEntry[];
  tokenAssets: SendableAssetEntry[];
};

export type OptimisticSendUpdate = {
  historyItem: TransactionHistoryItem;
  snapshot: OptimisticBalanceSnapshot;
  nextBalance: string;
  nextAssetBalances: SendableAssetEntry[];
  nextTokenAssets: SendableAssetEntry[];
};

// State keys that can all refer to the native USDC entry depending on where it
// came from ('usdc' is the initial default, 'native-usdc' the refreshed one).
const NATIVE_USDC_KEYS = ['usdc', 'native-usdc'];

const parseDisplayedToRaw = (displayed: string, decimals: number) => {
  const normalized = String(displayed ?? '').replace(/,/g, '').trim() || '0';
  return ethers.parseUnits(normalized, decimals);
};

// Subtracts `sentAmount` from a *displayed* balance string using the SAME
// decimals basis that displayed string was formatted with — never mixing the
// 18-decimal native base units used by ethers.parseUnits at send time with a
// 6-decimal token display. All arithmetic is bigint-based so rollback-safe
// precision is guaranteed.
export const decrementDisplayedBalance = (
  displayedBalance: string,
  sentAmount: string,
  decimals: number,
): string => {
  try {
    const currentRaw = parseDisplayedToRaw(displayedBalance, decimals);
    const amountRaw = parseDisplayedToRaw(sentAmount, decimals);
    // A valid send can never exceed the balance (validateSendAmount guards
    // this), but clamp at zero defensively instead of showing a negative.
    const nextRaw = currentRaw > amountRaw ? currentRaw - amountRaw : 0n;
    return formatTokenBalance(nextRaw, decimals);
  } catch {
    // Malformed input leaves the displayed balance untouched; the next
    // refreshWalletData supersedes local state anyway.
    return String(displayedBalance ?? '0');
  }
};

export const applyOptimisticAssetDecrement = (
  assets: SendableAssetEntry[],
  matchKeys: string[],
  sentAmount: string,
): SendableAssetEntry[] => {
  const normalizedKeys = matchKeys.map((key) => String(key).toLowerCase());
  return assets.map((asset) =>
    normalizedKeys.includes(String(asset.key).toLowerCase())
      ? { ...asset, balance: decrementDisplayedBalance(asset.balance, sentAmount, asset.decimals) }
      : asset,
  );
};

export const createOptimisticSendUpdate = (input: {
  hash: string;
  from: string;
  to: string;
  assetKey: string;
  symbol: string;
  amount: string;
  decimals: number;
  balance: string;
  assetBalances: SendableAssetEntry[];
  tokenAssets: SendableAssetEntry[];
}): OptimisticSendUpdate => {
  const { hash, from, to, assetKey, symbol, amount, decimals } = input;

  // Snapshot BEFORE applying any decrement so a revert can restore the exact
  // pre-send values rather than recomputing them.
  const snapshot: OptimisticBalanceSnapshot = {
    balance: input.balance,
    assetBalances: input.assetBalances.map((asset) => ({ ...asset })),
    tokenAssets: input.tokenAssets.map((asset) => ({ ...asset })),
  };

  let amountRaw = 0n;
  try {
    amountRaw = parseDisplayedToRaw(amount, decimals);
  } catch {
    amountRaw = 0n;
  }

  const historyItem: TransactionHistoryItem = {
    hash,
    from,
    to,
    value: formatTokenBalance(amountRaw, decimals),
    tokenSymbol: symbol,
    decimals,
    timestamp: Date.now(),
    direction: 'sent',
    status: 'confirming',
  };

  return {
    historyItem,
    snapshot,
    // `balance` backs the native USDC figure (formatted from 18-decimal base
    // units by parseNativeBalance), so it is only decremented for USDC sends.
    nextBalance:
      symbol === 'USDC' ? decrementDisplayedBalance(input.balance, amount, decimals) : input.balance,
    nextAssetBalances: applyOptimisticAssetDecrement(
      input.assetBalances,
      symbol === 'USDC' ? [...NATIVE_USDC_KEYS, assetKey] : [assetKey],
      amount,
    ),
    nextTokenAssets: applyOptimisticAssetDecrement(
      input.tokenAssets,
      symbol === 'USDC' ? [...NATIVE_USDC_KEYS, assetKey] : [assetKey],
      amount,
    ),
  };
};

// Flips an unreconciled optimistic ('confirming') history item to its final
// state once the chain/explorer reports a definitive outcome for its hash.
export const reconcileOptimisticTransaction = (
  transactions: TransactionHistoryItem[],
  hash: string,
  status: 'ok' | 'error',
): TransactionHistoryItem[] => {
  const normalizedHash = String(hash ?? '').toLowerCase();
  return transactions.map((transaction) =>
    transaction.status === 'confirming' && String(transaction.hash).toLowerCase() === normalizedHash
      ? { ...transaction, status }
      : transaction,
  );
};

// Merges a freshly fetched explorer page into the current list without ever
// producing two entries for the same hash. Optimistic items whose hash has
// shown up on-chain are dropped in favour of the real explorer record (which
// carries the real timestamp/confirmations); still-'confirming' items stay
// pinned to the top until reconciliation completes, and any current item the
// explorer does not report yet (e.g. a just-reconciled send ahead of the next
// explorer index pass) is retained instead of vanishing.
export const mergeFetchedTransactions = (
  current: TransactionHistoryItem[],
  fetched: TransactionHistoryItem[],
): TransactionHistoryItem[] => {
  const seenHashes = new Set(fetched.map((transaction) => String(transaction.hash).toLowerCase()));
  const retained: TransactionHistoryItem[] = [];
  for (const transaction of current) {
    const normalizedHash = String(transaction.hash).toLowerCase();
    if (!seenHashes.has(normalizedHash)) {
      seenHashes.add(normalizedHash);
      retained.push(transaction);
    }
  }

  return [
    ...retained.filter((transaction) => transaction.status === 'confirming'),
    ...fetched,
    ...retained.filter((transaction) => transaction.status !== 'confirming'),
  ];
};

const isValidPrivateKey = (input: string) => {
  const normalized = input.trim();
  if (!normalized) return false;
  if (/^0x[0-9a-fA-F]{64}$/.test(normalized)) return true;
  const parts = normalized.split(/\s+/);
  return parts.length === 12 && parts.every((part) => part.length > 0);
};

type ArcWallet = (ethers.Wallet & { mnemonic?: { phrase: string } }) | ethers.HDNodeWallet;

type ScanPayload =
  | { kind: 'pay'; id: string }
  | { kind: 'request'; id: string; amount: string; note: string }
  | { kind: 'address'; id: string };

type BarcodeDetectorLike = {
  detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>>;
};

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

export type TransactionHistoryItem = {
  hash: string;
  from: string;
  to: string;
  value: string;
  tokenSymbol: string;
  decimals: number;
  timestamp: number;
  direction: 'sent' | 'received';
  // 'confirming' is an additive, client-side-only state for freshly submitted
  // sends that have a hash but no on-chain receipt yet. It is distinct from
  // 'pending', which remains the bucket for genuinely unconfirmed/unknown
  // statuses coming back from the explorer.
  status: 'ok' | 'pending' | 'error' | 'confirming';
};

const toBigInt = (value: unknown) => {
  if (typeof value === 'bigint') {
    return value;
  }

  const rawValue = String(value ?? '0').trim();
  if (!rawValue) {
    return 0n;
  }

  if (/^0x[0-9a-fA-F]+$/.test(rawValue)) {
    return BigInt(rawValue);
  }

  return BigInt(rawValue);
};

const formatTimestamp = (timestamp: number) => {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return 'Just now';
  }

  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return 'Just now';
  }

  if (diffSeconds < 3600) {
    return `${Math.floor(diffSeconds / 60)}m ago`;
  }

  if (diffSeconds < 86400) {
    return `${Math.floor(diffSeconds / 3600)}h ago`;
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
};

const truncateAddress = (value: string) => {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return 'Unknown';
  }

  if (normalized.length <= 10) {
    return normalized;
  }

  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
};

const STATUS_DISPLAY: Record<string, { label: string; className: string }> = {
  ok: {
    label: 'Success',
    className: 'border-emerald-700/40 bg-emerald-500/10 text-emerald-300',
  },
  error: {
    label: 'Failed',
    className: 'border-red-700/40 bg-red-500/10 text-rose-500/70',
  },
  pending: {
    label: 'Pending',
    className: 'border-white/[0.06] bg-[#16171C] text-[#A1A1AA]',
  },
  confirming: {
    label: 'Confirming',
    className: 'border-amber-600/40 bg-amber-500/10 text-amber-300 animate-pulse',
  },
};

const normalizeExplorerStatus = (value: string) => {
  const status = String(value ?? '').trim().toLowerCase();
  if (status.includes('pending')) {
    return 'pending' as const;
  }

  if (status.includes('fail') || status.includes('error') || status.includes('rejected')) {
    return 'error' as const;
  }

  if (status === 'ok' || status === 'success') {
    return 'ok' as const;
  }

  return 'pending' as const;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return isPlainObject(value);
};

const fetchTransactionDetail = async (hash: string) => {
  const detailResponse = await fetch(`${ARC_EXPLORER_API_URL}/transactions/${hash}`);
  if (!detailResponse.ok) {
    return null;
  }

  return detailResponse.json() as Promise<Record<string, unknown> | null>;
};

export const fetchTransactionHistory = async (address: string): Promise<TransactionHistoryItem[]> => {
  const normalizedAddress = String(address ?? '').trim();
  if (!normalizedAddress) {
    return [];
  }

  const explorerResponse = await fetch(`${ARC_EXPLORER_API_URL}/addresses/${normalizedAddress}/transactions`);
  if (!explorerResponse.ok) {
    throw new Error('Unable to load transaction history from Arc explorer.');
  }

  const payload = await explorerResponse.json();
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { items?: unknown[] }).items)
      ? (payload as { items?: unknown[] }).items ?? []
      : Array.isArray((payload as { transactions?: unknown[] }).transactions)
        ? (payload as { transactions?: unknown[] }).transactions ?? []
        : Array.isArray((payload as { result?: unknown[] }).result)
          ? (payload as { result?: unknown[] }).result ?? []
          : [];

  const normalizedCandidates = await Promise.all(
    candidates.map(async (item): Promise<TransactionHistoryItem | null> => {
      if (!isPlainObject(item)) {
        return null;
      }

      const hash = String(item.hash ?? item.transaction_hash ?? item.tx_hash ?? '');
      const transactionTypes = Array.isArray(item.transaction_types)
        ? item.transaction_types.map((entry) => String(entry ?? '').toLowerCase())
        : [];
      const hasTokenTransferType = transactionTypes.includes('token_transfer');
      const tokenTransfers = Array.isArray(item.token_transfers)
        ? item.token_transfers.filter(isObjectRecord)
        : [];
      const detailItem = hasTokenTransferType && tokenTransfers.length === 0 && hash
        ? await fetchTransactionDetail(hash)
        : null;
      const sourceItem = detailItem && isPlainObject(detailItem) ? detailItem : item;

      const txFrom = String(
        (sourceItem.from as { address_hash?: string; hash?: string } | undefined)?.address_hash
          ?? (sourceItem.from as { address_hash?: string; hash?: string } | undefined)?.hash
          ?? (sourceItem.from as string | undefined)
          ?? (sourceItem.sender as string | undefined)
          ?? '',
      );
      const txTo = String(
        (sourceItem.to as { address_hash?: string; hash?: string } | undefined)?.address_hash
          ?? (sourceItem.to as { address_hash?: string; hash?: string } | undefined)?.hash
          ?? (sourceItem.to as string | undefined)
          ?? (sourceItem.receiver as string | undefined)
          ?? '',
      );
      const displayMeta = getTransactionDisplayMeta(sourceItem as Record<string, unknown>);
      const status = normalizeExplorerStatus(String(sourceItem.status ?? sourceItem.tx_status ?? sourceItem.state ?? 'ok'));
      const rawTimestamp = Number(
        sourceItem.timestamp
          ?? sourceItem.block_timestamp
          ?? sourceItem.time_stamp
          ?? sourceItem.created_at
          ?? sourceItem.time
          ?? 0,
      );
      const parsedTimestamp = Number.isFinite(rawTimestamp) ? rawTimestamp : Date.parse(String(sourceItem.timestamp ?? sourceItem.created_at ?? new Date().toISOString()));

      if (!hash) {
        return null;
      }

      const direction = parseTransactionDirection(normalizedAddress, txFrom, txTo);

      return {
        hash,
        from: txFrom,
        to: txTo,
        value: formatTokenBalance(displayMeta.rawValue, displayMeta.decimals),
        tokenSymbol: displayMeta.symbol,
        decimals: displayMeta.decimals,
        timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now(),
        direction,
        status,
      } satisfies TransactionHistoryItem;
    }),
  );

  return normalizedCandidates
    .filter((value): value is TransactionHistoryItem => value !== null)
    .sort((left, right) => (right?.timestamp ?? 0) - (left?.timestamp ?? 0))
    .slice(0, 50);
};

export const parseScanPayload = (rawInput: string): ScanPayload | null => {
  const trimmed = String(rawInput ?? '').trim();
  if (!trimmed) {
    return null;
  }

  const looksLikeAddress = /^0x[a-fA-F0-9]{40}$/.test(trimmed);
  if (looksLikeAddress) {
    return { kind: 'address', id: trimmed };
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'arcpay:') {
      return null;
    }

    const host = parsed.host.toLowerCase();
    const lookupId = parsed.searchParams.get('id');

    if (host === 'pay' && lookupId) {
      return { kind: 'pay', id: lookupId };
    }

    if (host === 'request' && lookupId) {
      const amount = parsed.searchParams.get('amount') ?? '';
      const note = parsed.searchParams.get('note') ?? '';
      return {
        kind: 'request',
        id: lookupId,
        amount,
        note,
      };
    }

    return null;
  } catch {
    return null;
  }
};

const parseWalletInput = (input: string): ArcWallet => {
  const normalized = input.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    return new ethers.Wallet(normalized);
  }

  const words = normalized.split(/\s+/);
  if (words.length === 12) {
    return ethers.Wallet.fromPhrase(normalized);
  }

  throw new Error('Enter a valid 12-word seed phrase or a raw private key.');
};

// Numeric passcode pad used for unlock / create / confirm screens.
const PasscodePad = ({
  mode,
  error,
  onComplete,
}: {
  mode: 'unlock' | 'create' | 'confirm';
  error?: string | null;
  onComplete: (pin: string) => void;
}) => {
  const [pin, setPin] = useState('');
  const title = mode === 'unlock' ? 'Enter PIN' : mode === 'create' ? 'Create PIN' : 'Confirm PIN';
  const submitLabel = mode === 'unlock' ? 'Unlock' : 'Continue';

  // Automatically clear the PIN entry when a wrong passcode is reported
  useEffect(() => {
    if (error) {
      setPin('');
    }
  }, [error]);

  const handleDigit = (digit: string) => {
    setPin((current) => {
      if (current.length >= 4) return current;
      const nextPin = current + digit;
      if (nextPin.length === 4) {
        onComplete(nextPin);
      }
      return nextPin;
    });
  };

  const handleBackspace = () => {
    setPin((current) => current.slice(0, -1));
  };

  return (
    <div className="min-h-screen bg-[#08090D] text-[#F5F3FF] flex items-center justify-center px-4 py-10">
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute -top-32 right-[-40px] h-80 w-80 rounded-full bg-[#069494]/[0.07] blur-3xl" />
      </div>
      <div className="relative w-full max-w-sm rounded-[20px] border border-white/[0.06] bg-[#111216] p-8 shadow-[0_0_60px_rgba(0,0,0,0.4)]">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#069494]/[0.10]">
            <Lock className="h-5 w-5 text-[#069494]" />
          </div>
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.3em] text-[#71717A]">Security</p>
            <h1 className="text-lg font-semibold">{title}</h1>
          </div>
        </div>

        <div
          className="mb-2 flex items-center justify-center gap-3"
          aria-label="PIN entry"
          role="textbox"
        >
          {Array.from({ length: 4 }).map((_, index) => {
            const filled = pin.length > index;
            return (
              <span
                key={index}
                className={`h-6 w-6 rounded-full border flex items-center justify-center transition-fast ${
                  filled ? 'border-[#069494] bg-[#16171C]' : 'border-white/[0.08] bg-[#16171C]'
                }`}
              >
                {filled && <span className="h-2 w-2 rounded-full bg-[#069494]" />}
              </span>
            );
          })}
        </div>

        {error ? <p className="mb-4 text-center text-sm text-rose-500/70">{error}</p> : <div className="mb-4 h-5" />}

        <div className="grid grid-cols-3 gap-3">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
            <button
              key={digit}
              type="button"
              onClick={() => handleDigit(digit)}
              className="press-effect rounded-[14px] border border-white/[0.06] bg-[#16171C] py-3 text-lg font-medium text-[#F5F3FF] transition-fast hover:border-[#069494]/40/40 hover:bg-[#069494]/[0.06]"
            >
              {digit}
            </button>
          ))}
          <button
            type="button"
            onClick={handleBackspace}
            aria-label="Delete last digit"
            className="press-effect rounded-[14px] border border-white/[0.06] bg-[#16171C] py-3 text-lg text-[#A1A1AA] transition-fast hover:border-[#069494]/40/40"
          >
            ⌫
          </button>
          <button
            type="button"
            onClick={() => handleDigit('0')}
            className="press-effect rounded-[14px] border border-white/[0.06] bg-[#16171C] py-3 text-lg font-medium text-[#F5F3FF] transition-fast hover:border-[#069494]/40/40 hover:bg-[#069494]/[0.06]"
          >
            0
          </button>
          <button
            type="button"
            onClick={() => onComplete(pin)}
            disabled={pin.length < 4}
            className="press-effect rounded-[14px] bg-[#069494] py-3 text-sm font-medium text-white transition-normal hover:bg-[#058A8A] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

type AppScreenState = 'setup' | 'unlock' | 'create-passcode' | 'confirm-passcode' | 'dashboard';

type AssetOption = {
  key: string;
  symbol: string;
  balance: string;
  decimals: number;
};

type AssetSelectorProps = {
  id: string;
  label: string;
  assets: AssetOption[];
  value: string;
  onChange: (key: string) => void;
};

// AssetSelector — accessible, custom-styled dropdown that shows the selected
// asset icon + symbol + balance and lists all options with zero-balance dimming.
const AssetSelector = ({ id, label, assets, value, onChange }: AssetSelectorProps) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selected = assets.find((asset) => asset.key === value) ?? assets[0] ?? null;
  const listId = `${id}-listbox`;
  const optionId = (key: string) => `${id}-opt-${key}`;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const iconUrl = (symbol: string) =>
    ASSET_ICON_URLS[symbol] ?? `https://cryptologos.cc/logos/${symbol.toLowerCase()}-${symbol.toLowerCase()}-logo.png`;

  const isZero = (asset: AssetOption) => {
    const n = Number(asset.balance);
    return !Number.isFinite(n) || n <= 0;
  };

  return (
    <div ref={containerRef} className="relative" role="combobox" aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? listId : undefined}>
      <label htmlFor={`${id}-trigger`} className="block text-sm text-[#A1A1AA] mb-1.5">
        {label}
      </label>
      <button
        id={`${id}-trigger`}
        type="button"
        aria-expanded={open}
        aria-label={`${label}: ${selected?.symbol ?? 'None'}`}
        onClick={() => setOpen((prev) => !prev)}
        className="group flex w-full items-center gap-3 rounded-xl border border-white/[0.06] bg-[#0B0C11] px-4 py-3 text-left transition-all duration-200 hover:border-[#069494]/30 hover:bg-[#16171C] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#069494]/40 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090D]"
      >
        {selected ? (
          <>
            <img
              src={iconUrl(selected.symbol)}
              alt=""
              className="h-8 w-8 shrink-0 rounded-full shadow-sm"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
            <div className="min-w-0 flex-1 text-left">
              <span className="block text-sm font-medium text-[#F5F3FF] truncate">{selected.symbol}</span>
              <span className={`block text-[11px] font-variant-numeric-tabular ${isZero(selected) ? 'text-[#555]' : 'text-[#71717A]'}`}>
                {formatDisplayBalance(selected.balance)} available
              </span>
            </div>
          </>
        ) : (
          <span className="text-sm text-[#71717A]">Select asset…</span>
        )}
        <ChevronRight className={`h-4 w-4 text-[#069494] opacity-70 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={`${label} options`}
          className="absolute z-50 mt-1 w-full max-h-[90vh] sm:max-h-72 overflow-y-auto overflow-x-hidden rounded-xl border border-white/[0.08] bg-[#12141B]/95 backdrop-blur-xl shadow-[0_16px_50px_rgba(0,0,0,0.5)] overscroll-contain p-1"
        >
          {assets.map((asset) => {
            const zero = isZero(asset);
            const active = asset.key === value;
            return (
              <button
                key={asset.key}
                id={optionId(asset.key)}
                type="button"
                role="option"
                aria-selected={active}
                aria-label={`${asset.symbol}, ${formatDisplayBalance(asset.balance)}`}
                onClick={() => { onChange(asset.key); setOpen(false); }}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-fast ${
                  active ? 'bg-[#069494]/10' : 'hover:bg-white/[0.04]'
                } ${zero ? 'opacity-60' : ''}`}
              >
                <img
                  src={iconUrl(asset.symbol)}
                  alt=""
                  className="h-8 w-8 shrink-0 rounded-full shadow-sm"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                />
                <div className="min-w-0 flex-1">
                  <span className={`block text-sm font-medium truncate ${zero ? 'text-[#71717A]' : 'text-[#F5F3FF]'}`}>
                    {asset.symbol}
                  </span>
                  <span className={`block text-[11px] font-variant-numeric-tabular ${zero ? 'text-[#555]' : 'text-[#71717A]'}`}>
                    {formatDisplayBalance(asset.balance)} available
                  </span>
                </div>
                {active && <CheckCircle2 className="h-4 w-4 shrink-0 text-[#069494]" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

function App() {
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [wallet, setWallet] = useState<ArcWallet | null>(null);
  const [balance, setBalance] = useState<string>('0');
  const [isLoading, setIsLoading] = useState(false);
  const [importInput, setImportInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showReceive, setShowReceive] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [showRequest, setShowRequest] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showContacts, setShowContacts] = useState(false);
  const [showContactPicker, setShowContactPicker] = useState(false);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>(getContacts());
  const [transactions, setTransactions] = useState<TransactionHistoryItem[]>([]);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [sendAddress, setSendAddress] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [sendAssetKey, setSendAssetKey] = useState('usdc');
  const [sendReview, setSendReview] = useState(false);
  const [gasFeeEstimate, setGasFeeEstimate] = useState<string | null>(null);

  // Format amount for input with asset-specific decimal precision
  const formatAmountForInput = (amount: number | string, decimals: number) => {
    const numericValue = Number.parseFloat(String(amount));
    if (!Number.isFinite(numericValue) || numericValue < 0) {
      return '';
    }
    const maxDecimals = Number.isFinite(decimals) && decimals >= 0 ? decimals : 2;
    return numericValue.toFixed(maxDecimals).replace(/0+$/, '').replace(/\.$/, '');
  };
  const [isEstimatingGasFee, setIsEstimatingGasFee] = useState(false);
  const [gasFeeEstimateError, setGasFeeEstimateError] = useState<string | null>(null);
  const [selectedAssetDetail, setSelectedAssetDetail] = useState<string | null>(null);
  const [sendRecipientError, setSendRecipientError] = useState('');
  const [recipientResolutionStatus, setRecipientResolutionStatus] = useState<'idle' | 'checking' | 'resolved' | 'unsupported'>('idle');
  const [sendAmountError, setSendAmountError] = useState('');
  const [requestAssetKey, setRequestAssetKey] = useState('native-usdc');
  const [requestAmount, setRequestAmount] = useState('');
  const [requestNote, setRequestNote] = useState('');
  const [requestAmountError, setRequestAmountError] = useState('');
  const [requestLinkCopied, setRequestLinkCopied] = useState(false);
  const [txState, setTxState] = useState<'idle' | 'pending' | 'confirming' | 'success' | 'error'>('idle');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txConfirmationTimedOut, setTxConfirmationTimedOut] = useState(false);
  const [txErrorDetail, setTxErrorDetail] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [assetBalances, setAssetBalances] = useState<Array<{ key: string; symbol: string; balance: string; decimals: number }>>([
    { key: 'usdc', symbol: 'USDC', balance, decimals: 6 },
  ]);
  const [tokenAssets, setTokenAssets] = useState<Array<{ key: string; symbol: string; balance: string; decimals: number }>>([]);
  const [resolvedSendAddress, setResolvedSendAddress] = useState<string | null>(null);
  const [isResolvingArcName, setIsResolvingArcName] = useState(false);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const [scannerSuccess, setScannerSuccess] = useState(false);
  const [scannedRequestNote, setScannedRequestNote] = useState('');
  const [contactLabelDraft, setContactLabelDraft] = useState('');
  const [showContactLabelInput, setShowContactLabelInput] = useState(false);
  const [addContactInput, setAddContactInput] = useState('');
  const [addContactLabel, setAddContactLabel] = useState('');
  const [addContactStatus, setAddContactStatus] = useState<'idle' | 'resolving'>('idle');
  const [addContactError, setAddContactError] = useState<string | null>(null);
  const [isAddContactOpen, setIsAddContactOpen] = useState(false);
  const [contactSearchQuery, setContactSearchQuery] = useState('');

  // Account management state
  const [accounts, setAccounts] = useState<AccountMeta[]>(getStoredAccountsMeta());
  const [activeAccountIndex, setActiveAccountIndexState] = useState<number>(getActiveAccountIndex());
  // Whether an unlocked session currently holds the decrypted mnemonic in
  // memory (module-level variable inside src/accounts.ts — deliberately NOT
  // React state, so the plaintext seed never appears in state inspectors).
  // Only this boolean flag is mirrored into React for rendering.
  const [hasSessionSeed, setHasSessionSeed] = useState<boolean>(() => getSessionSeed() !== null);
  // Why "Add Account" is unavailable when hasSessionSeed is false. Two distinct
  // states: raw-private-key wallets can never derive more accounts, while
  // pre-fix seed-phrase wallets get a one-time "re-import once" migration ask.
  const [addAccountHint, setAddAccountHint] = useState<string | null>(null);
  const [isAddingAccount, setIsAddingAccount] = useState(false);
  const [addAccountError, setAddAccountError] = useState<string | null>(null);
  const [confirmAccountRemoval, setConfirmAccountRemoval] = useState(false);
  const [removalTargetIndex, setRemovalTargetIndex] = useState<number | null>(null);
  const [editingAccountIndex, setEditingAccountIndex] = useState<number | null>(null);
  const [editingAccountLabel, setEditingAccountLabel] = useState('');

  // Wallet security / screen-flow state
  const [appState, setAppState] = useState<AppScreenState>(() => {
    // A valid encrypted vault under `arc_wallet_pk` means a wallet exists on
    // this device — start locked and require the PIN. A leftover plaintext
    // value from before the vault existed is NOT a valid vault and falls
    // through to the create/import screen instead of crashing.
    if (parseVaultPayload(getVaultFromStorage() ?? '')) {
      return 'unlock';
    }
    if (getKeystoreForAccount(getActiveAccountIndex()) ?? getKeystoreFromStorage()) {
      return 'unlock';
    }
    return 'setup';
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [passcodeError, setPasscodeError] = useState<string | null>(null);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const [pinDraft, setPinDraft] = useState('');
  const [pendingPrivateKey, setPendingPrivateKey] = useState<string | null>(null);
  const [pendingWallet, setPendingWallet] = useState<ArcWallet | null>(null);

  // Close account menu when clicking outside
  useEffect(() => {
    if (!showAccountMenu) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target as Node)) {
        setShowAccountMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showAccountMenu]);

  // Seed phrase reveal state
  const [pendingMnemonic, setPendingMnemonic] = useState<string | null>(null);
  const [showMnemonicReveal, setShowMnemonicReveal] = useState(false);
  const [hasConfirmedMnemonicSave, setHasConfirmedMnemonicSave] = useState(false);
  const [copiedPhrase, setCopiedPhrase] = useState(false);
  // Holds the mnemonic captured during create/import until the wallet is finalized,
  // at which point it is encrypted into `arc_wallet_seed_vault` AND held in
  // in-memory session storage (see src/accounts.ts). In-memory only.
  const [pendingSessionSeed, setPendingSessionSeed] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerStreamRef = useRef<MediaStream | null>(null);
  const scannerLoopRef = useRef<number | null>(null);
  const fallbackReaderRef = useRef<BrowserQRCodeReader | null>(null);
  // Holds the PIN captured at unlock/create/import time for the lifetime of the
  // unlocked session. Lets keystore writes (e.g. Add Account) reuse the same PIN
  // without ever re-prompting the user. Cleared on lock/logout.
  const sessionPinRef = useRef<string>('');

  const provider = useMemo(() => new ethers.JsonRpcProvider(ARC_RPC_URL), []);

  const refreshBalance = async (currentWallet?: ArcWallet | null) => {
    const targetWallet = currentWallet ?? wallet;
    if (!targetWallet) return;
    setIsLoading(true);
    setError(null);
    try {
      const address = targetWallet.address;

      // Fetch both native balance and token balances in parallel
      const [nativeResponse, tokenResponse] = await Promise.all([
        fetch(`${ARC_EXPLORER_API_URL}/addresses/${address}`),
        fetch(`${ARC_EXPLORER_API_URL}/addresses/${address}/token-balances`),
      ]);

      if (!nativeResponse.ok) {
        throw new Error('Unable to fetch native balance from Arc explorer.');
      }
      if (!tokenResponse.ok) {
        throw new Error('Unable to fetch token balances from Arc explorer.');
      }

      const nativePayload = await nativeResponse.json();
      const tokenPayload = await tokenResponse.json();

      // Parse native balance (18 decimals, USDC gas token)
      const nativeBalance = parseNativeBalance(nativePayload, address);
      const nativeUsdcBalance = nativeBalance?.coinBalanceFormatted ?? '0';

      // Parse token balances (ERC-20 tokens)
      const tokenBalances = parseTokenBalances(tokenPayload, address);

      // Normalize token balances to AssetBalance format
      const normalizedAssets = tokenBalances
        .filter((balance) => Number(balance.balanceFormatted) > 0)
        .map((balance) => ({
          key: balance.tokenAddress,
          symbol: balance.symbol,
          balance: balance.balanceFormatted,
          decimals: balance.decimals,
        }));

      // Set the primary balance to native USDC (coin_balance)
      // This is what funds sends and pays gas
      setBalance(nativeUsdcBalance);

      // Store token assets separately
      setTokenAssets(normalizedAssets);

      // Combine native USDC with token assets for asset balances display
      // Native USDC should be first since it's the primary balance
      const assetBalancesWithNative = [
        {
          key: 'native-usdc',
          symbol: 'USDC',
          balance: nativeUsdcBalance,
          decimals: 18,
        },
        ...normalizedAssets.filter((asset) => asset.symbol !== 'USDC'),
      ];

      setAssetBalances(assetBalancesWithNative);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to fetch balance.');
    } finally {
      setIsLoading(false);
    }
  };

  const refreshTransactionHistory = async (currentWallet?: ArcWallet | null) => {
    const targetWallet = currentWallet ?? wallet;
    if (!targetWallet) return;
    setIsHistoryLoading(true);
    setHistoryError(null);

    try {
      const nextTransactions = await fetchTransactionHistory(targetWallet.address);
      // Merge (not replace): any still-'confirming' optimistic item whose hash
      // has not shown up on-chain yet stays pinned at the top; once the
      // explorer returns the real record for a hash it wins, so we never end
      // up with two entries for the same hash.
      setTransactions((current) => mergeFetchedTransactions(current, nextTransactions));
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Unable to fetch transaction history.');
      // Keep in-flight optimistic items so a transient explorer failure does
      // not make a pending send vanish from history.
      setTransactions((current) => current.filter((tx) => tx.status === 'confirming'));
    } finally {
      setIsHistoryLoading(false);
    }
  };

  const refreshWalletData = async (currentWallet?: ArcWallet | null) => {
    const targetWallet = currentWallet ?? wallet;
    if (!targetWallet) return;

    await Promise.all([
      refreshBalance(targetWallet),
      refreshTransactionHistory(targetWallet),
    ]);
  };

  // Handle wallet unlock with PIN. The AES-GCM vault payload stored under
  // `arc_wallet_pk` is the primary source of truth for the active account;
  // the ethers keystore path remains as a fallback for devices whose data
  // predates the vault.
  const handleUnlock = async (pin: string) => {
    setIsProcessing(true);
    setPasscodeError(null);

    try {
      const vaultRaw = getVaultFromStorage();
      const vaultPayload = vaultRaw ? parseVaultPayload(vaultRaw) : null;

      let decryptedWallet: ethers.Wallet;
      if (vaultPayload) {
        const privateKeyValue = await decryptPrivateKey(vaultPayload, pin);
        decryptedWallet = new ethers.Wallet(privateKeyValue);
      } else {
        const activeIndex = getActiveAccountIndex();
        const keystore = getKeystoreForAccount(activeIndex) ?? getKeystoreFromStorage();
        if (!keystore) {
          throw new Error('Keystore not found');
        }

        decryptedWallet = await decryptWallet(keystore, pin);
      }

      const connectedWallet = decryptedWallet.connect(provider);
      // The PIN has now been proven correct. Decrypt the seed vault (if present)
      // into in-memory session storage so HD accounts can be derived later
      // without re-prompting. Wallets without a seed vault (raw-private-key
      // imports, or pre-fix wallets awaiting one-time re-import) leave the
      // session seed unset — Add Account then explains which case applies.
      const sessionMnemonic = await loadSessionSeedFromVault(pin);
      setHasSessionSeed(sessionMnemonic !== null);
      const unavailableReason = sessionMnemonic ? null : getAddAccountUnavailableReason();
      setAddAccountHint(unavailableReason ? ADD_ACCOUNT_UNAVAILABLE_MESSAGES[unavailableReason] : null);
      // Remember the PIN for this unlocked session so later keystore writes
      // (Add Account) can reuse it without re-prompting.
      sessionPinRef.current = pin;
      setWallet(connectedWallet);
      setAppState('dashboard');
      setPasscodeError(null);
      void refreshWalletData(connectedWallet);

      // One-time migration: if the legacy single-account keystore exists but no
      // per-index keystore for account 0 has been written yet, backfill it so that
      // switchAccount works for index 0.
      const legacyKeystore = getKeystoreFromStorage();
      if (legacyKeystore && !getKeystoreForAccount(0)) {
        migrateLegacyKeystoreToIndexZero(legacyKeystore, connectedWallet.address);
        setAccounts(getStoredAccountsMeta());
      }
    } catch {
      // Never reveal whether the PIN was wrong vs. the stored data being
      // corrupted — both paths fail identically.
      setPasscodeError('Incorrect PIN. Try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle new wallet creation - show mnemonic first, then passcode
  const handleCreateWallet = async () => {
    setIsProcessing(true);
    setError(null);

    try {
      const created = ethers.Wallet.createRandom().connect(provider);

      // Extract mnemonic for new wallet creation
      const mnemonic = created.mnemonic?.phrase;
      if (mnemonic) {
        setPendingMnemonic(mnemonic);
        // Stash the phrase so it can be cached as the session seed once the
        // wallet is finalized (after the PIN step) — never written to storage.
        setPendingSessionSeed(mnemonic);
        setShowMnemonicReveal(true);
      }

      // Store the wallet temporarily in state, but don't set it yet.
      // We'll finalize after the user confirms the mnemonic and sets a PIN.
      setPendingPrivateKey(created.privateKey);
      setPendingWallet(created);
      setAppState('create-passcode');
    } catch {
      setError('Wallet creation failed');
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle import wallet with PIN
  const handleImportWallet = async () => {
    try {
      setIsLoading(true);
      setError(null);
      if (!isValidPrivateKey(importInput)) {
        throw new Error('Enter a valid 12-word seed phrase or a raw private key.');
      }
      const imported = parseWalletInput(importInput).connect(provider);
      const privateKeyValue = imported.privateKey;

      const importedMnemonic = (imported as { mnemonic?: { phrase?: string } }).mnemonic?.phrase;
      setPendingSessionSeed(typeof importedMnemonic === 'string' && importedMnemonic ? importedMnemonic : null);

      setPendingPrivateKey(privateKeyValue);
      setPendingWallet(imported);
      setAppState('create-passcode');
      setImportInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wallet import failed.');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasscodeComplete = async (pin: string) => {
    if (appState === 'unlock') {
      await handleUnlock(pin);
      return;
    }

    if (appState === 'create-passcode') {
      setPinDraft(pin);
      setPasscodeError(null);
      setAppState('confirm-passcode');
      return;
    }

    if (appState === 'confirm-passcode') {
      if (pin !== pinDraft) {
        setPasscodeError("Passcodes didn't match, try again");
        setPinDraft('');
        setAppState('create-passcode');
        return;
      }

      setIsProcessing(true);
      setPasscodeError(null);

      try {
        if (!pendingPrivateKey || !pendingWallet) throw new Error('No pending wallet');

        // Encrypt the private key into the PIN vault (AES-GCM via Web Crypto).
        // Only this ciphertext ever touches localStorage — never the plaintext key.
        const vaultPayload = await encryptPrivateKey(pendingPrivateKey, pin);
        setVaultInStorage(serializeVaultPayload(vaultPayload));

        const keystore = await encryptWallet(pendingPrivateKey, pin);
        setKeystoreInStorage(keystore);
        setKeystoreForAccount(0, keystore);

        // If this wallet came from a seed phrase, encrypt the mnemonic with the
        // same PIN-derived key and persist it under its own dedicated storage
        // key (`arc_wallet_seed_vault`) so future unlocks can restore HD
        // derivation. Raw-private-key wallets have no derivable seed — record
        // that on the account so Add Account can explain it distinctly.
        const walletSource = pendingSessionSeed ? 'seed' : 'private-key';
        if (pendingSessionSeed) {
          await persistSeedVault(pendingSessionSeed, pin);
          setSessionSeed(pendingSessionSeed);
          setHasSessionSeed(true);
          setAddAccountHint(null);
        } else {
          clearSessionSeed();
          setHasSessionSeed(false);
          setAddAccountHint(ADD_ACCOUNT_UNAVAILABLE_MESSAGES['private-key']);
        }

        saveAccountsMeta([
          { index: 0, label: 'Account 1', address: pendingWallet.address, source: walletSource },
        ]);
        setActiveAccountIndex(0);
        setAccounts(getStoredAccountsMeta());
        setActiveAccountIndexState(0);

        setWallet(pendingWallet);
        sessionPinRef.current = pin;
        setPendingSessionSeed(null);
        
        setPendingPrivateKey(null);
        setPendingWallet(null);
        setPinDraft('');
        setAppState('dashboard');
        
        setPendingMnemonic(null);
        setShowMnemonicReveal(false);
        
        setAppState('dashboard');
        void refreshWalletData(pendingWallet);
      } catch (err) {
        setPasscodeError('Wallet setup failed');
      } finally {
        setIsProcessing(false);
      }
    }
  };

  // Handle lock - preserve keystore, just clear state
  const handleLock = () => {
    setPrivateKey(null);
    setWallet(null);
    setBalance('0');
    setError(null);
    setShowReceive(false);
    setShowSend(false);
    setShowRequest(false);
    setShowHistory(false);
    setTransactions([]);
    setHistoryError(null);
    setTxHash(null);
    setTxState('idle');
    setAppState('unlock');
    setPasscodeError(null);
    setPendingMnemonic(null);
    // Drop the plaintext mnemonic from memory — it must not outlive the
    // unlocked session. The encrypted copy stays in `arc_wallet_seed_vault`.
    clearSessionSeed();
    setHasSessionSeed(false);
    setAddAccountHint(null);
    setPendingSessionSeed(null);
    sessionPinRef.current = '';
  };

  // --- Account management helpers ---
  const setActiveAccountIndexWithState = (index: number) => {
    setActiveAccountIndexState(index);
    setActiveAccountIndex(index);
  };

  // Adds a derived HD account using the in-memory session seed. No PIN prompt:
  // the wallet is already unlocked, so we reuse the same session lifetime as the
  // decrypted active wallet held in state. When no seed is available, surfaces
  // the reason-specific message (raw private key vs. one-time re-import).
  const handleAddAccount = async () => {
    if (!hasSessionSeed || isAddingAccount) {
      return;
    }

    setIsAddingAccount(true);
    setAddAccountError(null);

    try {
      const outcome = await addDerivedAccount(sessionPinRef.current);
      if (outcome.status === 'unavailable') {
        setAddAccountError(ADD_ACCOUNT_UNAVAILABLE_MESSAGES[outcome.reason]);
        return;
      }

      const { account: newAccount, privateKey } = outcome;

      // Keep the PIN vault in sync with the newly active account so the next
      // unlock restores this exact account.
      const vaultPayload = await encryptPrivateKey(privateKey, sessionPinRef.current);
      setVaultInStorage(serializeVaultPayload(vaultPayload));

      // Optimistic UI update — accounts list reflects the new entry immediately.
      setAccounts(getStoredAccountsMeta());
      setActiveAccountIndexWithState(newAccount.index);

      const connectedWallet = new ethers.Wallet(privateKey).connect(provider);
      setWallet(connectedWallet);
      void refreshWalletData(connectedWallet);
    } catch (err) {
      setAddAccountError(err instanceof Error ? err.message : 'Unable to add account.');
    } finally {
      setIsAddingAccount(false);
    }
  };

  // Switching accounts stays instant: keystores are already encrypted on disk and
  // the session is already unlocked, so no PIN or re-derivation is needed.
  const switchAccount = async (index: number) => {
    const keystore = getKeystoreForAccount(index);
    if (!keystore) {
      throw new Error('Keystore not found for this account');
    }

    const decrypted = await decryptWallet(keystore, sessionPinRef.current);
    const connectedWallet = decrypted.connect(provider);
    // Keep the PIN vault in sync with the newly active account so the next
    // unlock restores this exact account.
    const vaultPayload = await encryptPrivateKey(decrypted.privateKey, sessionPinRef.current);
    setVaultInStorage(serializeVaultPayload(vaultPayload));
    setWallet(connectedWallet);
    setActiveAccountIndexWithState(index);
    void refreshWalletData(connectedWallet);
  };

  const handleRenameAccount = (index: number, label: string) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    const updated = renameAccount(index, trimmed);
    setAccounts(updated);
  };

  const handleSwitchAccountClick = (index: number) => {
    void switchAccount(index).catch(() => {
      if (index === 0) {
        setAddAccountError('Main account needs to be re-encrypted — re-enter your PIN to fix this.');
      } else {
        setAddAccountError('Unable to switch to this account.');
      }
    });
  };

  const handleRemoveAccountConfirm = (index: number) => {
    const result = removeAccount(index);
    if (!result) {
      setConfirmAccountRemoval(false);
      setRemovalTargetIndex(null);
      return;
    }

    setAccounts(result.accounts);
    setActiveAccountIndexWithState(result.activeIndex);
    const nextKeystore = getKeystoreForAccount(result.activeIndex);
    if (nextKeystore && sessionPinRef.current) {
      void decryptWallet(nextKeystore, sessionPinRef.current)
        .then(async (decrypted) => {
          const connectedWallet = decrypted.connect(provider);
          // Keep the PIN vault in sync with the remaining active account.
          const vaultPayload = await encryptPrivateKey(decrypted.privateKey, sessionPinRef.current);
          setVaultInStorage(serializeVaultPayload(vaultPayload));
          setWallet(connectedWallet);
          void refreshWalletData(connectedWallet);
        })
        .catch(() => {
          setAddAccountError('Unable to load the remaining account.');
        });
    }
    setConfirmAccountRemoval(false);
    setRemovalTargetIndex(null);
  };
  // --- End account management helpers ---




  const openSendModal = (scanDetails?: { recipient?: string; amount?: string; note?: string; presetAssetKey?: string }) => {
    const allAssets = [...tokenAssets, ...assetBalances];
    const presetKey = scanDetails?.presetAssetKey;
    const defaultAsset = (presetKey ? allAssets.find((asset) => asset.key === presetKey) : null)
      ?? allAssets.find((asset) => asset.symbol === 'USDC')
      ?? allAssets.find((asset) => Number(asset.balance) > 0)
      ?? { key: 'usdc', symbol: 'USDC', balance: '0', decimals: 6 };

    setSendAssetKey(defaultAsset.key);
    setSendAddress(scanDetails?.recipient ?? '');
    setSendAmount(scanDetails?.amount ?? '');
    setScannedRequestNote(scanDetails?.note ?? '');
    setSendReview(false);
    setGasFeeEstimate(null);
    setIsEstimatingGasFee(false);
    setGasFeeEstimateError(null);
    setSendRecipientError('');
    setSendAmountError('');
    setResolvedSendAddress(null);
    setIsResolvingArcName(false);
    setTxState('idle');
    setTxHash(null);
    setShowSend(true);
  };

  const copyAddress = async () => {
    if (!wallet?.address) return;
    await navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1300);
  };

  const getContactTargetAddress = () => {
    const rawAddress = String(sendAddress ?? '').trim();
    if (resolvedSendAddress) {
      return resolvedSendAddress;
    }

    if (!/^0x[a-fA-F0-9]{40}$/.test(rawAddress)) {
      return null;
    }

    try {
      return ethers.getAddress(rawAddress);
    } catch {
      return null;
    }
  };

  const refreshContactsState = () => {
    setContacts(getContacts());
  };

  const handleSaveCurrentContact = () => {
    const targetAddress = getContactTargetAddress();
    if (!targetAddress) {
      return;
    }

    const nextContacts = saveContact(targetAddress, contactLabelDraft);
    setContacts(nextContacts);
    setContactLabelDraft('');
    setShowContactLabelInput(false);
  };

  const handleAddContact = async () => {
    const input = addContactInput.trim();
    const label = addContactLabel.trim();

    if (!input) {
      setAddContactError('Enter a valid address or ArcName handle.');
      return;
    }

    if (addContactStatus === 'resolving') {
      return;
    }

    if (/^0x[a-fA-F0-9]{40}$/.test(input)) {
      try {
        const checksum = ethers.getAddress(input);
        const nextContacts = saveContact(checksum, label || undefined);
        setContacts(nextContacts);
        setAddContactInput('');
        setAddContactLabel('');
        setAddContactError(null);
        setAddContactStatus('idle');
      } catch {
        setAddContactError('Enter a valid 0x address.');
      }
      return;
    }

    if (!input.endsWith('.arc')) {
      setAddContactError('Enter a valid 0x address or a handle ending in .arc.');
      return;
    }

    setAddContactError(null);
    setAddContactStatus('resolving');

    try {
      const resolvedAddress = await resolveArcName(input, provider);
      const nextContacts = saveContact(resolvedAddress, label || undefined);
      setContacts(nextContacts);
      setAddContactInput('');
      setAddContactLabel('');
      setAddContactStatus('idle');
    } catch (err) {
      setAddContactError(err instanceof Error ? err.message : 'Unable to resolve ArcName handle.');
      setAddContactStatus('idle');
    }
  };

  const handleConfirmMnemonicSave = () => {
    setPendingMnemonic(null);
    setShowMnemonicReveal(false);
    setAppState('create-passcode');
    setPasscodeError(null);
  };

  const requestAssets: AssetOption[] = useMemo(() => {
    // Always include native USDC first so users can always select USDC
    const nativeUsdc = assetBalances.find((asset) => asset.symbol === 'USDC');
    const merged = nativeUsdc
      ? [nativeUsdc, ...tokenAssets.filter((t) => t.symbol !== 'USDC')]
      : tokenAssets;
    const filtered = filterNonZeroAssetBalances(merged);
    // Ensure we always have at least one asset (USDC as fallback)
    return filtered.length > 0 
      ? (filtered as unknown as AssetOption[]) 
      : [{ key: 'usdc', symbol: 'USDC', balance: '0', decimals: 6 }];
  }, [assetBalances, tokenAssets]);

  const openRequestModal = () => {
    const defaultAsset = requestAssets.find((asset) => asset.symbol === 'USDC')
      ?? requestAssets.find((asset) => Number(asset.balance) > 0)
      // Fallback to native USDC even if balance is zero or assets haven't loaded yet
      ?? { key: 'native-usdc', symbol: 'USDC', balance: '0', decimals: 18 };

    setRequestAssetKey(defaultAsset.key);
    setRequestAmount('');
    setRequestNote('');
    setRequestAmountError('');
    setShowRequest(true);
  };

  const getRequestAmountError = (value: string, asset = selectedRequestAsset) => {
    const normalized = value.trim();
    if (!normalized) {
      return 'Enter an amount to request.';
    }

    const numericAmount = Number(normalized);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return 'Enter a valid amount greater than zero.';
    }

    const [whole, fraction = ''] = normalized.split('.');
    if (whole.startsWith('-') || whole === '') {
      return 'Enter a valid amount greater than zero.';
    }

    const decimals = asset.decimals ?? 6;
    if (fraction.length > decimals) {
      return `Amount exceeds ${asset.symbol} precision (${decimals} decimals max).`;
    }

    return '';
  };

  const validateRequestAmount = (value: string) => {
    const error = getRequestAmountError(value, selectedRequestAsset);
    setRequestAmountError(error);
    return !error;
  };

  const sendAssets: AssetOption[] = useMemo(() => {
    // Always include native USDC (the gas asset) so the selector is never empty
    // and users can always select USDC even when holding other tokens.
    const nativeUsdc = assetBalances.find((asset) => asset.symbol === 'USDC');
    const merged = nativeUsdc
      ? [nativeUsdc, ...tokenAssets.filter((t) => t.symbol !== 'USDC')]
      : tokenAssets;
    const filtered = filterNonZeroAssetBalances(merged);
    // Ensure we always have at least one asset (USDC as fallback)
    return filtered.length > 0 
      ? (filtered as unknown as AssetOption[]) 
      : [{ key: 'usdc', symbol: 'USDC', balance: '0', decimals: 6 }];
  }, [assetBalances, tokenAssets]);

  const selectedSendAsset = useMemo(() => {
    return sendAssets.find((asset) => asset.key === sendAssetKey)
      ?? sendAssets.find((asset) => asset.symbol === 'USDC')
      ?? sendAssets[0]
      ?? { key: 'usdc', symbol: 'USDC', balance: '0', decimals: 6 };
  }, [sendAssetKey, sendAssets]);

  const selectedRequestAsset = useMemo(() => {
    return requestAssets.find((asset) => asset.key === requestAssetKey)
      ?? requestAssets.find((asset) => asset.symbol === 'USDC')
      ?? requestAssets[0]
      ?? { key: 'usdc', symbol: 'USDC', balance: '0', decimals: 6 };
  }, [requestAssetKey, requestAssets]);

  const selectedSendAssetDecimals = selectedSendAsset.decimals ?? 6;
  const selectedRequestAssetDecimals = selectedRequestAsset.decimals ?? 6;

  const stopScannerStream = () => {
    if (scannerLoopRef.current) {
      window.clearInterval(scannerLoopRef.current);
      scannerLoopRef.current = null;
    }

    if (scannerStreamRef.current) {
      scannerStreamRef.current.getTracks().forEach((track) => track.stop());
      scannerStreamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  const handleScanPayload = (decodedValue: string) => {
    const parsedPayload = parseScanPayload(decodedValue);

    if (!parsedPayload) {
      setScannerError('This QR code isn\'t a valid ArcPay link');
      return;
    }

    if (parsedPayload.kind === 'address') {
      setScannerSuccess(true);
      window.setTimeout(() => {
        setShowScanner(false);
        setScannerError(null);
        setScannerSuccess(false);
        openSendModal({ recipient: parsedPayload.id });
      }, 700);
      return;
    }

    if (parsedPayload.kind === 'pay') {
      setScannerSuccess(true);
      window.setTimeout(() => {
        setShowScanner(false);
        setScannerError(null);
        setScannerSuccess(false);
        openSendModal({ recipient: parsedPayload.id });
      }, 700);
      return;
    }

    setScannerSuccess(true);
    window.setTimeout(() => {
      setShowScanner(false);
      setScannerError(null);
      setScannerSuccess(false);
      openSendModal({
        recipient: parsedPayload.id,
        amount: parsedPayload.amount,
        note: parsedPayload.note,
      });
    }, 700);
  };

  const requestLink = useMemo(() => {
    if (!wallet) {
      return '';
    }

    const amountError = getRequestAmountError(requestAmount, selectedRequestAsset);
    if (amountError) {
      return '';
    }

    return buildRequestLink(wallet.address, requestAmount, requestNote);
  }, [requestAmount, requestNote, selectedRequestAsset, wallet]);

  const looksLikeArcNameHandle = (value: string) => {
    const input = String(value ?? '').trim();
    return /^[a-z0-9][a-z0-9-]*\.arc$/i.test(input);
  };

  const sendTarget = resolvedSendAddress ?? sendAddress;

  const handleCheckArcName = async () => {
    const input = String(sendAddress ?? '').trim();
    if (!looksLikeArcNameHandle(input)) {
      return;
    }

    setRecipientResolutionStatus('checking');
    setIsResolvingArcName(true);

    try {
      const resolved = await resolveRecipientAddress(input);
      setResolvedSendAddress(resolved);
      setRecipientResolutionStatus('resolved');
    } catch {
      setResolvedSendAddress(null);
      setRecipientResolutionStatus('unsupported');
    } finally {
      setIsResolvingArcName(false);
    }
  };

  const resolveRecipientAddress = async (value: string) => {
    const input = String(value).trim();
    if (!input) {
      throw new Error('Enter a recipient address or ArcName handle.');
    }

    const looksLikeAddress = /^0x[a-fA-F0-9]{40}$/.test(input);
    if (looksLikeAddress) {
      const checksum = ethers.getAddress(input);
      setResolvedSendAddress(checksum);
      setIsResolvingArcName(false);
      return checksum;
    }

    const normalizedLower = input.toLowerCase();
    if (!normalizedLower.endsWith('.arc')) {
      throw new Error('Enter a valid checksummed address or a handle ending in .arc.');
    }

    setIsResolvingArcName(true);
    try {
      const resolved = await resolveArcName(input, provider);
      setResolvedSendAddress(resolved);
      return resolved;
    } catch (err) {
      setResolvedSendAddress(null);
      throw err;
    } finally {
      setIsResolvingArcName(false);
    }
  };

  const validateSendRecipient = (value: string) => {
    const input = String(value).trim();
    if (!input) {
      setSendRecipientError('Enter a recipient address or ArcName handle.');
      setRecipientResolutionStatus('idle');
      return false;
    }

    const looksLikeAddress = /^0x[a-fA-F0-9]{40}$/.test(input);
    const looksLikeArcName = looksLikeArcNameHandle(input);

    if (looksLikeAddress) {
      const checksum = ethers.getAddress(input);
      setSendRecipientError('');
      setResolvedSendAddress(checksum);
      setRecipientResolutionStatus('idle');
      setIsResolvingArcName(false);
      return true;
    }

    if (looksLikeArcName) {
      setSendRecipientError('');
      setResolvedSendAddress(null);
      setRecipientResolutionStatus('idle');
      setIsResolvingArcName(false);
      return true;
    }

    setSendRecipientError('Enter a valid checksummed address or a handle ending in .arc.');
    setResolvedSendAddress(null);
    setRecipientResolutionStatus('idle');
    setIsResolvingArcName(false);
    return false;
  };

  const validateSendAmount = (value: string) => {
    const normalized = value.trim();
    if (!normalized) {
      setSendAmountError('Enter an amount to send.');
      return false;
    }

    const numericAmount = Number(normalized);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setSendAmountError('Enter a valid amount greater than zero.');
      return false;
    }

    const assetDecimals = selectedSendAsset.decimals ?? getAssetDecimals(selectedSendAsset.symbol);
    const maxDecimals = Number.isFinite(assetDecimals) && assetDecimals > 0 ? assetDecimals : 2;
    if (!new RegExp(`^\\d+(\\.\\d{0,${maxDecimals}})?$`).test(normalized)) {
      setSendAmountError(`Amount cannot exceed ${maxDecimals} decimal places.`);
      return false;
    }

    const availableBalance = Number.parseFloat(selectedSendAsset.balance);
    if (Number.isFinite(availableBalance) && numericAmount > availableBalance) {
      setSendAmountError(`Amount exceeds available ${selectedSendAsset.symbol} balance.`);
      return false;
    }

    setSendAmountError('');
    return true;
  };

  const startScanner = async () => {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setScannerError('Camera scanning is not supported in this browser.');
      return;
    }

    setScannerError(null);
    setScannerSuccess(false);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      scannerStreamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      // Wait for video to be ready before starting detection
      await new Promise<void>((resolve) => {
        const checkReady = () => {
          if (!videoRef.current) return;
          if (videoRef.current.readyState >= videoRef.current.HAVE_ENOUGH_DATA) {
            resolve();
          } else {
            requestAnimationFrame(checkReady);
          }
        };
        checkReady();
      });

      const BarcodeDetectorConstructor = (window as Window & typeof globalThis & {
        BarcodeDetector?: BarcodeDetectorCtor;
      }).BarcodeDetector;

      if (BarcodeDetectorConstructor) {
        const detector = new BarcodeDetectorConstructor({ formats: ['qr_code'] });
        scannerLoopRef.current = window.setInterval(async () => {
          if (!videoRef.current || !showScanner) {
            return;
          }

          try {
            const detected = await detector.detect(videoRef.current);
            const firstResult = detected[0]?.rawValue?.trim();
            if (firstResult) {
              window.clearInterval(scannerLoopRef.current ?? undefined);
              handleScanPayload(firstResult);
            }
          } catch {
            // Ignore frame detection errors and keep trying.
          }
        }, 700);
        return;
      }

      const reader = new BrowserQRCodeReader();
      fallbackReaderRef.current = reader;
      scannerLoopRef.current = window.setInterval(async () => {
        if (!videoRef.current || !showScanner) {
          return;
        }

        try {
          const result = await reader.decodeOnceFromVideoDevice(undefined, videoRef.current);
          // Robustly extract text: handle getText() returning string, null, or undefined
          const decoded = typeof result?.getText === 'function' ? result.getText() : null;
          const cleanedDecoded = decoded ? String(decoded).trim() : '';
          if (cleanedDecoded) {
            window.clearInterval(scannerLoopRef.current ?? undefined);
            handleScanPayload(cleanedDecoded);
          }
        } catch {
          // Ignore decode errors and keep trying.
        }
      }, 1000);
    } catch {
      setScannerError('Camera permission was denied or no camera is available.');
    }
  };

  useEffect(() => {
    if (showScanner) {
      void startScanner();
    } else {
      stopScannerStream();
    }

    return () => {
      stopScannerStream();
    };
  }, [showScanner]);

  const handleSendReview = async () => {
    const recipientValid = validateSendRecipient(sendAddress);
    const amountValid = validateSendAmount(sendAmount);
    if (!recipientValid || !amountValid || !wallet) {
      return;
    }

    try {
      const nextSendTarget = await resolveRecipientAddress(sendTarget);
      setResolvedSendAddress(nextSendTarget);
    } catch (err) {
      setSendRecipientError(err instanceof Error ? err.message : 'Unable to resolve ArcName handle.');
      return;
    }

    setSendReview(true);
    setTxState('idle');
    setError(null);

    // Kick off gas estimation asynchronously — do not block the review screen.
    estimateSendGasFee();
  };

  const estimateSendGasFee = async () => {
    if (!wallet) return;

    setGasFeeEstimate(null);
    setGasFeeEstimateError(null);
    setIsEstimatingGasFee(true);

    try {
      const resolvedRecipient = resolvedSendAddress ?? sendTarget;
      const plan = buildSendTransactionPlan(selectedSendAsset, resolvedRecipient, sendAmount);

      let gasLimit: bigint;
      if (plan.kind === 'native') {
        gasLimit = await provider.estimateGas({
          from: wallet.address,
          to: plan.tx.to,
          value: plan.tx.value,
        });
      } else {
        const tokenContract = new ethers.Contract(plan.tokenAddress, plan.abi, wallet);
        gasLimit = await tokenContract.transfer.estimateGas(...plan.args);
      }

      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;

      if (gasPrice === null || gasPrice === undefined) {
        setGasFeeEstimateError('Unable to retrieve gas price from the network.');
        return;
      }

      const formattedFee = formatGasFeeUsdc(gasLimit, gasPrice);
      setGasFeeEstimate(formattedFee);
    } catch (err) {
      setGasFeeEstimateError(
        err instanceof Error ? err.message : 'Gas estimation failed.',
      );
    } finally {
      setIsEstimatingGasFee(false);
    }
  };

  // Restores the exact pre-send balances captured before the optimistic
  // decrement — no recomputation, the snapshot values are reapplied verbatim.
  const rollbackOptimisticSend = (update: OptimisticSendUpdate) => {
    setBalance(update.snapshot.balance);
    setAssetBalances(update.snapshot.assetBalances);
    setTokenAssets(update.snapshot.tokenAssets);
  };

  const handleSend = async () => {
    if (!wallet) return;
    const amountValid = validateSendAmount(sendAmount);
    const recipientValid = validateSendRecipient(sendAddress);
    if (!amountValid || !recipientValid) {
      return;
    }

    setTxState('pending');
    setError(null);
    setTxHash(null);
    setTxConfirmationTimedOut(false);
    setTxErrorDetail(null);

    try {
      const resolvedRecipient = await resolveRecipientAddress(sendAddress);
      const plan = buildSendTransactionPlan(selectedSendAsset, resolvedRecipient, sendAmount);

      let txHashValue: string;
      if (plan.kind === 'native') {
        const response = await wallet.sendTransaction(plan.tx);
        txHashValue = response.hash;
        setTxHash(txHashValue);
      } else {
        const tokenContract = new ethers.Contract(plan.tokenAddress, plan.abi, wallet);
        const response = await tokenContract.transfer(...plan.args);
        txHashValue = response.hash;
        setTxHash(txHashValue);
      }

      // --- Optimistic post-send updates ---
      // The moment we hold a hash, reflect the send in history and Holdings
      // instead of waiting for the next explorer poll to index it.
      const isNativeSend = plan.kind === 'native';
      // History items for native transfers use the 18-decimal basis the
      // explorer reports; ERC-20 transfers use the token's own decimals.
      const optimisticDecimals = isNativeSend
        ? NATIVE_VALUE_DECIMALS
        : selectedSendAsset.decimals ?? getAssetDecimals(selectedSendAsset.symbol);

      const sendOptimistic = createOptimisticSendUpdate({
        hash: txHashValue,
        from: wallet.address,
        to: resolvedRecipient,
        assetKey: selectedSendAsset.key,
        symbol: selectedSendAsset.symbol,
        amount: sendAmount.trim(),
        decimals: optimisticDecimals,
        balance,
        assetBalances,
        tokenAssets,
      });

      setTransactions((current) => [
        sendOptimistic.historyItem,
        ...current.filter((tx) => tx.hash.toLowerCase() !== txHashValue.toLowerCase()),
      ]);
      setAssetBalances(sendOptimistic.nextAssetBalances);
      setTokenAssets(sendOptimistic.nextTokenAssets);
      if (selectedSendAsset.symbol === 'USDC') {
        setBalance(sendOptimistic.nextBalance);
      }

      // Move to 'confirming' state immediately so UI shows hash + spinner
      setTxState('confirming');
      setSendReview(false);
      setGasFeeEstimate(null);
      setIsEstimatingGasFee(false);
      setGasFeeEstimateError(null);

      // Save contact in background
      setContacts((current) => {
        const isSaved = current.some((contact) => contact.address.toLowerCase() === resolvedRecipient.toLowerCase());
        return isSaved ? current : saveContact(resolvedRecipient);
      });

      // Poll for confirmation with 120s timeout
      const CONFIRMATION_TIMEOUT_MS = 120_000;
      let confirmationTimedOut = false;
      const timeoutId = window.setTimeout(() => {
        confirmationTimedOut = true;
        setTxConfirmationTimedOut(true);
      }, CONFIRMATION_TIMEOUT_MS);

      try {
        const receipt = await provider.waitForTransaction(txHashValue);
        window.clearTimeout(timeoutId);

        if (confirmationTimedOut) {
          // Timed out but we still got a receipt — check its status
          if (receipt?.status === 1) {
            setTxState('success');
            setTransactions((current) => reconcileOptimisticTransaction(current, txHashValue, 'ok'));
            void refreshTransactionHistory();
          } else if (receipt?.status === 0) {
            setTxState('error');
            setTxErrorDetail('Transaction reverted on-chain.');
            rollbackOptimisticSend(sendOptimistic);
            setTransactions((current) => reconcileOptimisticTransaction(current, txHashValue, 'error'));
            void refreshTransactionHistory();
          } else {
            // Receipt without clear status after timeout — leave in confirming with timed-out flag
            setTxState('confirming');
          }
        } else if (receipt?.status === 1) {
          setTxState('success');
          // Confirmed: flip the synthesized item to 'ok' right away; the
          // explorer fetch below then supersedes it with the real record
          // (real timestamp, confirmations, …) via hash dedupe.
          setTransactions((current) => reconcileOptimisticTransaction(current, txHashValue, 'ok'));
          void refreshTransactionHistory();
        } else if (receipt?.status === 0) {
          setTxState('error');
          setTxErrorDetail('Transaction reverted on-chain.');
          // Reverted: restore the exact pre-send balances captured before the
          // optimistic decrement, and keep the history entry visible as failed.
          rollbackOptimisticSend(sendOptimistic);
          setTransactions((current) => reconcileOptimisticTransaction(current, txHashValue, 'error'));
          void refreshTransactionHistory();
        } else {
          // No receipt or unknown status
          setTxState('confirming');
          setTxConfirmationTimedOut(true);
        }
      } catch (waitErr) {
        window.clearTimeout(timeoutId);
        // If waitForTransaction itself throws (e.g. network error), treat as timeout-like
        setTxState('confirming');
        setTxConfirmationTimedOut(true);
      }
    } catch (err) {
      setTxState('error');
      setTxErrorDetail(err instanceof Error ? err.message : 'Transaction failed.');
      setError(err instanceof Error ? err.message : 'Transaction failed.');
    }
  };

  const address = wallet?.address ?? '';
  const visibleAssets = useMemo(() => {
    const rawAssets = sendAssets.map((asset) => ({ ...asset, balance: formatDisplayBalance(asset.balance) }));
    return rawAssets;
  }, [sendAssets]);
  const totalPortfolioValue = useMemo(() => {
    return formatDisplayBalance(
      visibleAssets.reduce((total, asset) => {
        const value = getAssetUsdValue(asset.symbol, asset.balance);
        return total + (value ?? 0);
      }, 0),
    );
  }, [visibleAssets]);

  useEffect(() => {
    setAssetBalances((current) => current.map((asset) => (asset.key === 'usdc' ? { ...asset, balance } : asset)));
  }, [balance]);

  useEffect(() => {
    if (selectedAssetDetail && transactions.length === 0 && !isHistoryLoading) {
      void refreshTransactionHistory();
    }
  }, [selectedAssetDetail]);


  if (appState === 'unlock') {
    return <PasscodePad mode="unlock" error={passcodeError} onComplete={handlePasscodeComplete} />;
  }

  if (appState === 'create-passcode') {
    return <PasscodePad mode="create" error={passcodeError} onComplete={handlePasscodeComplete} />;
  }

  if (appState === 'confirm-passcode') {
    return <PasscodePad mode="confirm" error={passcodeError} onComplete={handlePasscodeComplete} />;
  }

  // Mnemonic reveal screen - shown immediately after wallet creation
  if (showMnemonicReveal && pendingMnemonic) {
    const mnemonicWords = pendingMnemonic.split(' ');
    
    const copyMnemonic = async () => {
      await navigator.clipboard.writeText(pendingMnemonic);
      setCopiedPhrase(true);
      window.setTimeout(() => setCopiedPhrase(false), 1300);
    };

    return (
      <div className="min-h-screen bg-[#08090D] text-[#F5F3FF] flex items-center justify-center px-4 py-10">
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute -top-32 right-[-40px] h-80 w-80 rounded-full bg-[#069494]/[0.07] blur-3xl" />
        </div>
        <div className="relative w-full max-w-md rounded-[20px] border border-white/[0.06] bg-[#111216] p-8 shadow-[0_0_60px_rgba(0,0,0,0.4)]">
          <div className="mb-8 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#069494]/[0.10]">
              <Wallet className="h-5 w-5 text-[#069494]" />
            </div>
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.3em] text-[#71717A]">Backup</p>
              <h1 className="text-lg font-semibold">Save your recovery phrase</h1>
            </div>
          </div>

          <div className="space-y-6">
            <div className="space-y-4">
              <p className="text-[14px] text-[#A1A1AA]">
                This is your 12-word recovery phrase. Write it down and store it securely. This is the only way to recover your wallet if you lose access to this device.
              </p>
              
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {mnemonicWords.map((word, index) => (
                  <div 
                    key={index} 
                    className="flex items-center gap-2 rounded-[10px] border border-white/[0.06] bg-[#16171C] px-3 py-2 text-sm text-[#F5F3FF]"
                  >
                    <span className="text-[#71717A] text-xs font-medium w-5">{index + 1}.</span>
                    <span>{word}</span>
                  </div>
                ))}
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={copyMnemonic}
                  className="flex items-center gap-2 rounded-full border border-white/[0.06] bg-[#16171C] px-4 py-2 text-sm text-[#F5F3FF] transition-fast hover:border-[#069494]/40"
                >
                  <Copy className="h-4 w-4" />
                  {copiedPhrase ? 'Copied!' : 'Copy phrase'}
                </button>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id="confirmMnemonic"
                  checked={hasConfirmedMnemonicSave}
                  onChange={(e) => setHasConfirmedMnemonicSave(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-white/[0.08] bg-[#0B0C11] text-[#069494] focus:ring-[#069494] focus:ring-offset-0"
                />
                <label htmlFor="confirmMnemonic" className="text-[14px] text-[#A1A1AA]">
                  I have saved my recovery phrase somewhere safe.
                </label>
              </div>

              <button
                type="button"
                onClick={handleConfirmMnemonicSave}
                disabled={!hasConfirmedMnemonicSave}
                className="press-effect w-full flex items-center justify-center gap-2 rounded-[14px] bg-[#069494] px-4 py-3.5 font-medium text-white transition-normal hover:bg-[#058A8A] disabled:opacity-70"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }



  // No wallet - show create/import screen
  if (appState === 'setup' && !wallet) {
    return (
      <div className="min-h-screen bg-[#08090D] text-[#F5F3FF] flex items-center justify-center px-4 py-10">
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute -top-32 right-[-40px] h-80 w-80 rounded-full bg-[#069494]/[0.07] blur-3xl" />
        </div>
        <div className="relative w-full max-w-md rounded-[20px] border border-white/[0.06] bg-[#111216] p-8 shadow-[0_0_60px_rgba(0,0,0,0.4)]">
          <div className="mb-8 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#069494]/[0.10]">
              <Wallet className="h-5 w-5 text-[#069494]" />
            </div>
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.3em] text-[#71717A]">Self-custodial</p>
              <h1 className="text-lg font-semibold">Arc Wallet</h1>
            </div>
          </div>

          <div className="mb-6 space-y-2">
            <h2 className="text-2xl font-bold tracking-tight">Secure your Arc Testnet wallet</h2>
            <p className="text-[14px] text-[#A1A1AA]">Create a fresh wallet or import an existing one directly in your browser.</p>
          </div>

          <div className="space-y-3">
            <button
              onClick={handleCreateWallet}
              disabled={isLoading || isProcessing}
              className="press-effect flex w-full items-center justify-center gap-2 rounded-[14px] bg-[#069494] px-4 py-3.5 font-medium text-white transition-normal hover:bg-[#058A8A]"
            >
              <Download className="h-4 w-4" />
              {isLoading || isProcessing ? 'Preparing…' : 'Create New Wallet'}
            </button>

            <div className="rounded-[14px] border border-white/[0.06] bg-[#16171C]/60 p-4">
              <label className="mb-2 block text-[10px] font-medium uppercase tracking-[0.3em] text-[#71717A]">Import wallet</label>
              <textarea
                value={importInput}
                onChange={(e) => setImportInput(e.target.value)}
                rows={4}
                placeholder="12-word seed phrase or 0x private key"
                className="w-full rounded-xl border border-white/[0.06] bg-[#0B0C11] px-3 py-2.5 text-sm text-[#F5F3FF] outline-none ring-0 placeholder:text-[#71717A] focus:border-[#069494]/30 transition-fast"
              />
              <button
                onClick={handleImportWallet}
                disabled={isLoading || isProcessing}
                className="press-effect mt-3 flex w-full items-center justify-center gap-2 rounded-[14px] border border-white/[0.06] bg-[#111216] px-4 py-3 text-sm font-medium text-[#F5F3FF] transition-normal hover:border-[#069494]/40/40 hover:bg-[#069494]/[0.06]"
              >
                <Upload className="h-4 w-4" />
                Import Wallet
              </button>
            </div>
          </div>

          {error ? <p className="mt-4 text-sm text-rose-500/70">{error}</p> : null}
        </div>
      </div>
    );
  }

  if (appState !== 'dashboard' && !wallet) return null;

  return (
    <div className="min-h-screen bg-[#08090D] text-[#F5F3FF] px-4 pt-3 pb-28 sm:px-6 lg:px-8">
      <div className="relative mx-auto flex max-w-md flex-col gap-5">
        {/* Header */}
        <header className="flex items-center justify-between py-1.5">
          <div className="flex items-center gap-2.5">
            <img src={logoUrl} alt="ArcPay" className="h-9 w-9 object-contain" />
            <div className="flex flex-col leading-tight">
              <span className="text-[13px] font-semibold">ArcPay</span>
              <button
                type="button"
                onClick={() => setShowAccountMenu((prev) => !prev)}
                className="text-[9px] font-medium uppercase tracking-[0.3em] text-[#71717A] hover:text-[#A1A1AA] transition-colors"
                aria-expanded={showAccountMenu}
                aria-label="Select account"
              >
                {accounts.find((a) => a.index === activeAccountIndex)?.label ?? 'Arc Network'}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={copyAddress}
              className="group flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-[#111216] px-3 py-1.5 transition-fast hover:border-white/[0.12]"
              aria-label="Copy wallet address"
            >
              <span className="font-mono text-[11px] text-[#A1A1AA] transition-fast group-hover:text-[#F5F3FF]">
                {address.slice(0, 6)}…{address.slice(-4)}
              </span>
              <Copy className="h-3.5 w-3.5 text-[#71717A] transition-fast group-hover:text-[#A1A1AA]" />
            </button>
            <button
              onClick={handleLock}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.06] bg-[#111216] text-[#71717A] transition-fast hover:border-white/[0.12] hover:text-[#F5F3FF]"
              aria-label="Lock wallet"
            >
              <Lock className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        {/* Account selector menu */}
        {showAccountMenu && (
          <div ref={accountMenuRef} className="relative">
            <div
              className="absolute z-50 mt-1 w-full max-w-sm rounded-xl border border-white/[0.08] bg-[#12141B]/95 backdrop-blur-xl shadow-[0_16px_50px_rgba(0,0,0,0.5)] overflow-hidden"
              role="menu"
              aria-label="Account selector"
            >
              <div className="px-4 py-3 border-b border-white/[0.06]">
                <p className="text-[10px] font-medium uppercase tracking-[0.3em] text-[#71717A]">Account</p>
              </div>
              <div className="py-1">
                {accounts.map((account) => {
                  const isActive = account.index === activeAccountIndex;
                  return (
                    <button
                      key={account.index}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        if (!isActive) {
                          handleSwitchAccountClick(account.index);
                        }
                        setShowAccountMenu(false);
                      }}
                      className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-fast ${
                        isActive ? 'bg-[#069494]/10' : 'hover:bg-white/[0.04]'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium text-[#F5F3FF]">{account.label}</p>
                          {isActive && (
                            <span className="rounded-full bg-[#069494]/20 px-2 py-0.5 text-[10px] font-medium text-[#069494]">
                              Active
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-[#A1A1AA] font-mono">
                          {account.address.slice(0, 6)}...{account.address.slice(-4)}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Total Balance Card */}
        <section className="relative overflow-hidden rounded-[18px] border border-white/[0.06] bg-[#111216] px-6 py-8">
          {/* Subtle teal ambient glow */}
          <div className="pointer-events-none absolute -right-8 -top-8 h-40 w-40 rounded-full bg-[#069494]/[0.06] blur-3xl" />
          <div className="pointer-events-none absolute -left-4 bottom-0 h-24 w-24 rounded-full bg-[#069494]/[0.04] blur-2xl" />
          <div className="relative">
            <p className="text-[10px] font-medium uppercase tracking-[0.3em] text-[#71717A]">Total Balance</p>
            <h2 className="mt-3 text-[40px] font-bold leading-none tracking-tight text-[#F5F3FF]">
              ${totalPortfolioValue}
            </h2>
            <div className="mt-3 flex items-center gap-3">
              <span className="text-[12px] text-[#71717A]">Testnet · {ARC_NETWORK_NAME}</span>
              <button
                onClick={() => void refreshWalletData()}
                className="group flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.06] bg-[#16171C] transition-fast hover:border-[#069494]/30 hover:bg-[#069494]/[0.08]"
                aria-label="Refresh"
              >
                <RefreshCcw className="h-3 w-3 text-[#71717A] transition-fast group-hover:text-[#069494]" />
              </button>
            </div>
          </div>
        </section>

        {/* Quick Actions */}
        <section className="flex items-center justify-between px-2">
          <button
            onClick={() => openSendModal()}
            className="group flex flex-col items-center gap-2"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/[0.06] bg-[#111216] text-[#A1A1AA] transition-fast group-hover:border-[#069494]/30 group-hover:bg-[#069494]/[0.08] group-hover:text-[#069494] group-active:scale-95">
              <Send className="h-[18px] w-[18px]" />
            </span>
            <span className="text-[11px] font-medium text-[#71717A] transition-fast group-hover:text-[#A1A1AA]">Send</span>
          </button>
          <button
            onClick={() => setShowReceive(true)}
            className="group flex flex-col items-center gap-2"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/[0.06] bg-[#111216] text-[#A1A1AA] transition-fast group-hover:border-[#069494]/30 group-hover:bg-[#069494]/[0.08] group-hover:text-[#069494] group-active:scale-95">
              <Download className="h-[18px] w-[18px]" />
            </span>
            <span className="text-[11px] font-medium text-[#71717A] transition-fast group-hover:text-[#A1A1AA]">Receive</span>
          </button>
          <button
            onClick={openRequestModal}
            className="group flex flex-col items-center gap-2"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/[0.06] bg-[#111216] text-[#A1A1AA] transition-fast group-hover:border-[#069494]/30 group-hover:bg-[#069494]/[0.08] group-hover:text-[#069494] group-active:scale-95">
              <QrCode className="h-[18px] w-[18px]" />
            </span>
            <span className="text-[11px] font-medium text-[#71717A] transition-fast group-hover:text-[#A1A1AA]">Request</span>
          </button>
          <button
            onClick={() => setShowHistory(true)}
            className="group flex flex-col items-center gap-2"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/[0.06] bg-[#111216] text-[#A1A1AA] transition-fast group-hover:border-[#069494]/30 group-hover:bg-[#069494]/[0.08] group-hover:text-[#069494] group-active:scale-95">
              <Clock className="h-[18px] w-[18px]" />
            </span>
            <span className="text-[11px] font-medium text-[#71717A] transition-fast group-hover:text-[#A1A1AA]">History</span>
          </button>
        </section>

        {/* Holdings */}
        <section className="rounded-[16px] border border-white/[0.06] bg-[#111216] px-4 py-4">
          <div className="mb-1 flex items-center justify-between px-2">
            <p className="text-[10px] font-medium uppercase tracking-[0.3em] text-[#71717A]">Holdings</p>
            <span className="text-[11px] text-[#71717A]">{visibleAssets.length} assets</span>
          </div>
          {visibleAssets.length > 0 ? (
            <div className="divide-y divide-white/[0.04]">
              {visibleAssets.map((asset) => {
                const usdEstimate = getAssetUsdValue(asset.symbol, asset.balance);
                return (
                <button
                  key={asset.key}
                  type="button"
                  onClick={() => setSelectedAssetDetail(asset.key)}
                  className="group flex w-full items-center justify-between gap-3 rounded-xl px-2.5 py-3.5 text-left transition-fast hover:bg-[#069494]/[0.04]"
                >
                  <div className="flex items-center gap-3">
                    <img
                      src={ASSET_ICON_URLS[asset.symbol] ?? `https://cryptologos.cc/logos/${asset.symbol.toLowerCase()}-${asset.symbol.toLowerCase()}-logo.png`}
                      alt={`${asset.symbol} icon`}
                      className="h-9 w-9 rounded-full"
                      onError={(event) => {
                        event.currentTarget.style.display = 'none';
                        const fallback = document.createElement('div');
                        fallback.className = 'flex h-9 w-9 items-center justify-center rounded-full border border-[#069494]/20 bg-[#069494]/[0.08] text-[11px] font-semibold text-[#069494]';
                        fallback.textContent = asset.symbol.slice(0, 2).toUpperCase();
                        event.currentTarget.parentElement?.appendChild(fallback);
                      }}
                    />
                    <div>
                      <p className="text-[14px] font-semibold text-[#F5F3FF]">{asset.symbol}</p>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className="text-[12px] text-[#71717A]">{asset.balance} available</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <p className="font-mono text-[13px] font-semibold text-[#F5F3FF]">${formatDisplayBalance(usdEstimate ?? 0)}</p>
                    <ChevronRight className="h-4 w-4 text-[#71717A] transition-fast group-hover:text-[#069494]" />
                  </div>
                </button>
                );
              })}
            </div>
          ) : (
            <p className="px-2 py-4 text-[13px] text-[#71717A]">No balances above zero yet.</p>
          )}
        </section>

        {copied ? <p className="text-center text-[11px] font-medium text-[#069494]">Address copied</p> : null}
      </div>

      {selectedAssetDetail ? (() => {
        const detailAsset = visibleAssets.find((a) => a.key === selectedAssetDetail)
          ?? { key: selectedAssetDetail, symbol: 'TOKEN', balance: '0', decimals: 6 };
        const assetTransactions = transactions.filter((tx) => tx.tokenSymbol === detailAsset.symbol);
        const iconUrl = ASSET_ICON_URLS[detailAsset.symbol] ?? `https://cryptologos.cc/logos/${detailAsset.symbol.toLowerCase()}-${detailAsset.symbol.toLowerCase()}-logo.png`;

        return (
          <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4">
            <div className="w-full max-w-md rounded-[20px] border border-white/[0.08] bg-[#12141B] p-7 shadow-[0_24px_80px_rgba(0,0,0,0.45),0_8px_30px_rgba(0,0,0,0.25)] flex flex-col h-full">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <img
                    src={iconUrl}
                    alt={`${detailAsset.symbol} icon`}
                    className="h-8 w-8 rounded-full"
                    onError={(event) => {
                      event.currentTarget.style.display = 'none';
                    }}
                  />
                  <div>
                    <h3 className="text-xl font-semibold text-[#F4F4F5]">{detailAsset.symbol}</h3>
                    <p className="text-xs text-[#A1A1AA]">Available · {detailAsset.balance}</p>
                  </div>
                </div>
                <button 
                  onClick={() => setSelectedAssetDetail(null)}
                  className="flex items-center justify-center w-8 h-8 rounded-full text-[#A1A1AA] hover:bg-white/[0.05] transition-colors focus:outline-none focus:ring-1 focus:ring-[#069494]/50"
                  aria-label="Close"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-6">
                <button
                  onClick={() => {
                    const assetKey = selectedAssetDetail;
                    setSelectedAssetDetail(null);
                    openSendModal({ presetAssetKey: assetKey });
                  }}
                  className="flex flex-1 items-center justify-center gap-2 rounded-[12px] bg-gradient-to-r from-[#047A7A] to-[#069494] px-4 py-3 text-sm font-medium text-white transition-all duration-180 hover:from-[#058A8A] hover:to-[#069494] active:scale-98 shadow-[0_4px_12px_rgba(6,148,148,0.2)]"
                >
                  <Send className="h-4 w-4" />
                  Send
                </button>
                <button
                  onClick={() => {
                    setSelectedAssetDetail(null);
                    openRequestModal();
                  }}
                  className="flex flex-1 items-center justify-center gap-2 rounded-[12px] border border-white/[0.08] bg-[#11131A] px-4 py-3 text-sm font-medium text-white transition-all duration-180 hover:bg-[#1B1D26] hover:border-white/[0.12] active:scale-98"
                >
                  <Upload className="h-4 w-4" />
                  Receive
                </button>
              </div>

              <div className="mb-4 flex items-center justify-between pb-2 border-b border-white/[0.07]">
                <p className="text-[11px] uppercase tracking-[0.1em] text-[#A1A1AA]">Activity</p>
                <button 
                  onClick={() => void refreshTransactionHistory()} 
                  className="flex items-center gap-1.5 text-xs text-[#A1A1AA] transition-colors duration-180 hover:text-[#069494]"
                >
                  <RefreshCcw className="h-3 w-3" />
                  Refresh
                </button>
              </div>

                <div className="pr-1 custom-scrollbar scrollbar-hide overflow-y-auto">
                  {isHistoryLoading && transactions.length === 0 ? (
                    Array.from({ length: 4 }).map((_, index) => (
                      <div key={index} className="py-4 border-b border-white/[0.05] last:border-b-0">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1B1D26] border border-white/[0.07]">
                            <div className="h-4 w-4 rounded-full bg-[#2B2B2B]" />
                          </div>
                          <div className="flex-1">
                            <div className="h-4 w-24 rounded bg-[#2B2B2B] mb-1"></div>
                            <div className="h-3 w-32 rounded bg-[#1B1D26]"></div>
                          </div>
                          <div className="text-right">
                            <div className="h-4 w-16 rounded bg-[#2B2B2B] mb-1"></div>
                            <div className="h-3 w-20 rounded bg-[#1B1D26]"></div>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : null}

                  {!isHistoryLoading && assetTransactions.length === 0 ? (
                    <div className="py-8 text-center text-sm text-[#A1A1AA]">
                      No {detailAsset.symbol} transactions yet.
                    </div>
                  ) : null}

                  {assetTransactions.map((transaction) => {
                    const counterparty = transaction.direction === 'sent' ? transaction.to : transaction.from;
                    const tokenDisplay = formatDisplayBalance(transaction.value);
                    const statusDisplay = STATUS_DISPLAY[transaction.status] ?? STATUS_DISPLAY.pending;
                    const directionIcon = transaction.direction === 'received' ? (
                      <ArrowDownLeft className="h-4 w-4 text-emerald-500/70" />
                    ) : (
                      <ArrowUpRight className="h-4 w-4 text-rose-500/70" />
                    );

                    return (
                      <div 
                        key={transaction.hash} 
                        className={`py-4 border-b border-white/[0.05] last:border-b-0 transition-colors duration-180 hover:bg-white/[0.025] ${
                          transaction.status === 'error' ? 'opacity-50' : ''
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1B1D26] border border-white/[0.07]">
                              {directionIcon}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="font-medium text-[#F4F4F5] truncate">{transaction.direction === 'received' ? 'Received' : 'Sent'}</p>
                              <p className="text-sm text-[#A1A1AA] truncate">{truncateAddress(counterparty)}</p>
                              <p className="text-xs text-[#71717A]">{formatTimestamp(transaction.timestamp)}</p>
                            </div>
                          </div>
                          <div className="text-right pl-2">
                            <p className={`font-semibold ${transaction.direction === 'sent' ? 'text-rose-400' : 'text-emerald-400'} font-variant-numeric-tabular`}>
                              {transaction.direction === 'sent' ? '-' : '+'}{tokenDisplay} {transaction.tokenSymbol}
                            </p>
                            <span className={`inline-block text-xs mt-1 ${
                              transaction.status === 'ok' 
                                ? 'text-emerald-500' 
                                : transaction.status === 'error'
                                  ? 'text-red-400'
                                  : 'text-[#71717A]'
                            }`}>
                              {transaction.status === 'ok' ? '✓ Success' : statusDisplay.label}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
            </div>
          </div>
        );
      })() : null}

      {showHistory ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4">
          <div className="w-full max-w-md rounded-[20px] border border-white/[0.08] bg-[#12141B] p-7 shadow-[0_24px_80px_rgba(0,0,0,0.45),0_8px_30px_rgba(0,0,0,0.25)] flex flex-col h-full">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-semibold text-[#F4F4F5]">Transaction History</h3>
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => void refreshTransactionHistory()} 
                  className="flex items-center gap-2 rounded-full border border-white/[0.08] bg-[#11131A] px-3 py-2 text-xs text-[#A1A1AA] transition-colors duration-180 hover:text-[#069494] hover:border-white/[0.12]"
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                  Refresh
                </button>
                <button 
                  onClick={() => setShowHistory(false)} 
                  className="flex items-center justify-center w-8 h-8 rounded-full text-[#A1A1AA] hover:bg-white/[0.05] transition-colors focus:outline-none focus:ring-1 focus:ring-[#069494]/50"
                  aria-label="Close"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="mt-5 flex-1 flex flex-col overflow-y-auto">
              <div className="mb-4 flex items-center justify-between pb-2 border-b border-white/[0.07]">
                <p className="text-[11px] uppercase tracking-[0.1em] text-[#A1A1AA]">Recent Transactions</p>
              </div>
                <div className="pr-1 custom-scrollbar scrollbar-hide overflow-y-auto">
                  {isHistoryLoading ? (
                    Array.from({ length: 4 }).map((_, index) => (
                      <div key={index} className="py-4 border-b border-white/[0.05] last:border-b-0">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1B1D26] border border-white/[0.07]">
                            <div className="h-4 w-4 rounded-full bg-[#2B2B2B]" />
                          </div>
                          <div className="flex-1">
                            <div className="h-4 w-24 rounded bg-[#2B2B2B] mb-1"></div>
                            <div className="h-3 w-32 rounded bg-[#1B1D26]"></div>
                          </div>
                          <div className="text-right">
                            <div className="h-4 w-16 rounded bg-[#2B2B2B] mb-1"></div>
                            <div className="h-3 w-20 rounded bg-[#1B1D26]"></div>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : null}

              {!isHistoryLoading && historyError ? (
                <div className="py-8 text-center text-sm text-red-400">{historyError}</div>
              ) : null}

              {!isHistoryLoading && !historyError && transactions.length === 0 ? (
                <div className="py-8 text-center text-sm text-[#A1A1AA]">No transactions yet.</div>
              ) : null}

              {!isHistoryLoading && !historyError && transactions.length > 0 ? (
                <div className="pr-1 custom-scrollbar scrollbar-hide overflow-y-auto">
                  {transactions.map((transaction) => {
                    const counterparty = transaction.direction === 'sent' ? transaction.to : transaction.from;
                    const tokenDisplay = formatDisplayBalance(transaction.value);
                    const statusDisplay = STATUS_DISPLAY[transaction.status] ?? STATUS_DISPLAY.pending;
                    const directionIcon = transaction.direction === 'received' ? (
                      <ArrowDownLeft className="h-4 w-4 text-emerald-500/70" />
                    ) : (
                      <ArrowUpRight className="h-4 w-4 text-rose-500/70" />
                    );

                    return (
                      <div 
                        key={transaction.hash} 
                        className={`py-4 border-b border-white/[0.05] last:border-b-0 transition-colors duration-180 hover:bg-white/[0.025] ${
                          transaction.status === 'error' ? 'opacity-50' : ''
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1B1D26] border border-white/[0.07]">
                              {directionIcon}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="font-medium text-[#F4F4F5] truncate">{transaction.direction === 'received' ? 'Received' : 'Sent'}</p>
                              <p className="text-sm text-[#A1A1AA] truncate">{truncateAddress(counterparty)}</p>
                              <p className="text-xs text-[#71717A]">{formatTimestamp(transaction.timestamp)}</p>
                            </div>
                          </div>
                          <div className="text-right pl-2">
                            <p className={`font-semibold ${transaction.direction === 'sent' ? 'text-rose-400' : 'text-emerald-400'} font-variant-numeric-tabular`}>
                              {transaction.direction === 'sent' ? '-' : '+'}{tokenDisplay} {transaction.tokenSymbol}
                            </p>
                            <span className={`inline-block text-xs mt-1 ${
                              transaction.status === 'ok' 
                                ? 'text-emerald-500' 
                                : transaction.status === 'error'
                                  ? 'text-red-400'
                                  : 'text-[#71717A]'
                            }`}>
                              {transaction.status === 'ok' ? '✓ Success' : statusDisplay.label}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>
        </div>
</div>
      ) : null}

      {showSettings ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-[20px] border border-white/[0.06] bg-[#111216] p-6 shadow-[0_0_60px_rgba(0,0,0,0.4)]">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">Settings</h3>
              <button 
                onClick={() => {
                  setShowSettings(false);
                  setConfirmRemoval(false);
                }} 
                className="text-sm text-[#A1A1AA]"
              >
                Close
              </button>
            </div>
            <div className="mt-6 space-y-3">
              <button
                onClick={() => {
                  setShowSettings(false);
                  setShowContacts(true);
                }}
                className="flex w-full items-center justify-between rounded-2xl border border-white/[0.06] bg-[#16171C] px-4 py-3 text-left text-[#F5F3FF] transition hover:border-[#069494]/40"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.06] bg-[#111216]">
                    <Users className="h-4 w-4 text-[#069494]" />
                  </div>
                  <span className="text-sm font-medium">Manage Contacts</span>
                </div>
                <ChevronRight className="h-4 w-4 text-[#A1A1AA]" />
              </button>

              <div className="pt-4 border-t border-white/[0.06]">
                <p className="text-[10px] font-medium uppercase tracking-[0.3em] text-[#069494] mb-3">Accounts</p>
                <div className="space-y-2">
                  {accounts.map((account) => {
                    const isActive = account.index === activeAccountIndex;
                    const isEditing = editingAccountIndex === account.index;
                    const isConfirmingRemoval = confirmAccountRemoval && removalTargetIndex === account.index;

                    return (
                      <div key={account.index} className="rounded-xl border border-white/[0.06] bg-[#16171C] p-3">
                        {isEditing ? (
                          <div className="flex items-center gap-2">
                            <input
                              value={editingAccountLabel}
                              onChange={(e) => setEditingAccountLabel(e.target.value.slice(0, 40))}
                              className="flex-1 rounded-lg border border-white/[0.06] bg-[#0B0C11] px-2 py-1.5 text-sm text-[#F5F3FF] outline-none"
                              autoFocus
                            />
                            <button
                              type="button"
                              onClick={() => {
                                handleRenameAccount(account.index, editingAccountLabel);
                                setEditingAccountIndex(null);
                                setEditingAccountLabel('');
                              }}
                              className="rounded-lg bg-[#069494] px-2.5 py-1.5 text-xs font-medium text-white"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingAccountIndex(null);
                                setEditingAccountLabel('');
                              }}
                              className="text-xs text-[#A1A1AA]"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <p className="truncate text-sm font-medium text-[#F5F3FF]">{account.label}</p>
                                {isActive && (
                                  <span className="rounded-full bg-[#069494]/20 px-2 py-0.5 text-[10px] font-medium text-[#069494]">
                                    Active
                                  </span>
                                )}
                              </div>
                              <p className="mt-0.5 truncate text-xs text-[#A1A1AA] font-mono">
                                {account.address.slice(0, 6)}...{account.address.slice(-4)}
                              </p>
                            </div>
                            <div className="flex items-center gap-1">
                              {!isActive && (
                                <button
                                  type="button"
                                  onClick={() => handleSwitchAccountClick(account.index)}
                                  className="rounded-lg border border-white/[0.06] bg-[#111216] px-2 py-1 text-[11px] text-[#F5F3FF] transition hover:border-[#069494]/40"
                                >
                                  Switch
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingAccountIndex(account.index);
                                  setEditingAccountLabel(account.label);
                                }}
                                className="rounded-lg border border-white/[0.06] bg-[#111216] px-2 py-1 text-[11px] text-[#A1A1AA] transition hover:text-[#F5F3FF]"
                              >
                                Rename
                              </button>
                              {accounts.length > 1 && (
                                isConfirmingRemoval ? (
                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => handleRemoveAccountConfirm(account.index)}
                                      className="rounded-lg bg-red-500 px-2 py-1 text-[11px] text-white"
                                    >
                                      Confirm
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setConfirmAccountRemoval(false);
                                        setRemovalTargetIndex(null);
                                      }}
                                      className="text-[11px] text-[#A1A1AA]"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setConfirmAccountRemoval(true);
                                      setRemovalTargetIndex(account.index);
                                    }}
                                    className="rounded-lg border border-white/[0.06] bg-[#111216] px-2 py-1 text-[11px] text-[#A1A1AA] transition hover:border-red-500/50 hover:text-red-300"
                                  >
                                    Remove
                                  </button>
                                )
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {!hasSessionSeed && addAccountHint ? (
                  <p className="mt-3 rounded-xl border border-white/[0.06] bg-[#16171C] px-3 py-2 text-xs text-[#A1A1AA]">
                    {addAccountHint}
                  </p>
                ) : null}

                <button
                  type="button"
                  onClick={() => void handleAddAccount()}
                  disabled={!hasSessionSeed || isAddingAccount}
                  className="press-effect mt-3 flex w-full items-center justify-center gap-2 rounded-[14px] border border-[#069494]/20 bg-[#069494]/[0.06] px-4 py-2.5 text-sm font-medium text-[#069494] transition-normal hover:border-[#069494]/40 hover:bg-[#069494]/[0.10] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isAddingAccount ? (
                    <>
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                      Adding…
                    </>
                  ) : (
                    <>
                      <Plus className="h-4 w-4" />
                      Add Account
                    </>
                  )}
                </button>

                {addAccountError ? (
                  <p className="mt-2 text-xs text-rose-500/70">{addAccountError}</p>
                ) : null}
              </div>

              <div className="pt-4 border-t border-white/[0.06]">
                <p className="text-[10px] font-medium uppercase tracking-[0.3em] text-rose-500/70 mb-3">Danger Zone</p>
                {!confirmRemoval ? (
                  <button
                    onClick={() => setConfirmRemoval(true)}
                    className="w-full flex items-center justify-center gap-2 rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-300 transition hover:bg-red-500/20"
                  >
                    <Trash2 className="h-4 w-4" />
                    Remove wallet from this device
                  </button>
                ) : (
                  <div className="space-y-3">
                    <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
                      <div className="flex items-center gap-2 mb-2">
                        <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                        <strong>Warning:</strong>
                      </div>
                      <p>This action will permanently delete your wallet from this device. Make sure you have your seed phrase or private key backed up securely.</p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          // Execute wallet removal
                          removeAllAccountData();
                          localStorage.removeItem(STORAGE_KEY_LEGACY);
                          removeKeystoreFromStorage();
                          removeVaultFromStorage();
                          removeSeedVaultFromStorage();
                          setPrivateKey(null);
                          setWallet(null);
                          setBalance('0');
                          setError(null);
                          setShowReceive(false);
                          setShowSend(false);
                          setShowRequest(false);
                          setShowHistory(false);
                          setShowSettings(false);
                          setConfirmRemoval(false);
                          setTransactions([]);
                          setHistoryError(null);
                          setTxHash(null);
                          setTxState('idle');
                          setAppState('setup');
                          clearSessionSeed();
                          setHasSessionSeed(false);
                          setAddAccountHint(null);
                          setPendingSessionSeed(null);
                          sessionPinRef.current = '';
                        }}
                        className="flex-1 rounded-2xl bg-red-500 px-4 py-3 text-sm font-medium text-white transition hover:bg-red-600"
                      >
                        Yes, remove wallet
                      </button>
                      <button
                        onClick={() => setConfirmRemoval(false)}
                        className="flex-1 rounded-2xl border border-white/[0.06] bg-[#16171C] px-4 py-3 text-sm font-medium text-[#F5F3FF] transition hover:border-[#069494]/40"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showReceive ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-[20px] border border-white/[0.06] bg-[#111216] p-6 shadow-[0_0_60px_rgba(0,0,0,0.4)]">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">Receive</h3>
              <button onClick={() => setShowReceive(false)} className="text-sm text-[#A1A1AA]">Close</button>
            </div>
            <div className="mt-6 flex flex-col items-center gap-4">
              <div className="relative rounded-2xl border border-white/[0.06] bg-[#16171C] p-4">
                <QRCodeSVG value={address} size={180} includeMargin bgColor="#161616" fgColor="#FAFAFA" />
                <img
                  src={logoForQrUrl}
                  alt=""
                  className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-8 w-8 pointer-events-none"
                />
              </div>
              <p className="break-all text-center font-mono text-sm text-[#A1A1AA]">{address}</p>
              <button onClick={copyAddress} className="flex items-center gap-2 rounded-full border border-white/[0.06] bg-[#16171C] px-4 py-2 text-sm text-[#F5F3FF]">
                <Copy className="h-4 w-4" />
                Copy address
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showRequest ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-[20px] border border-white/[0.06] bg-[#111216] p-6 shadow-[0_0_60px_rgba(0,0,0,0.4)]">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">Request</h3>
              <button onClick={() => {
                setShowRequest(false);
                setRequestAssetKey('native-usdc');
                setRequestAmount('');
                setRequestNote('');
                setRequestAmountError('');
                setRequestLinkCopied(false);
              }} className="text-sm text-[#A1A1AA]">Close</button>
            </div>
            <div className="mt-6 space-y-4">
              <AssetSelector
                    id="request-asset"
                    label="Asset"
                    assets={requestAssets}
                    value={requestAssetKey}
                    onChange={(key) => {
                      setRequestAssetKey(key);
                      setRequestAmountError('');
                    }}
                  />
              <label className="block text-sm text-[#A1A1AA]">
                Amount
                <div className="mt-2 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-[#0B0C11] px-3 py-3">
                  <input
                    value={requestAmount}
                    onChange={(e) => {
                      setRequestAmount(e.target.value);
                      validateRequestAmount(e.target.value);
                    }}
                    className="w-full bg-transparent text-sm text-[#F5F3FF] outline-none"
                    placeholder="12.50"
                  />
                  <span className="text-[11px] text-[#A1A1AA]">{selectedRequestAsset.symbol}</span>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-[#A1A1AA]">
                  <span>Precision: {selectedRequestAssetDecimals}</span>
                  <span>Default: {selectedRequestAsset.symbol}</span>
                </div>
                {requestAmountError ? <p className="mt-2 text-xs text-rose-500/70">{requestAmountError}</p> : null}
              </label>

              <label className="block text-sm text-[#A1A1AA]">
                Note (optional)
                <textarea
                  value={requestNote}
                  onChange={(e) => {
                    const nextValue = e.target.value.slice(0, 140);
                    setRequestNote(nextValue);
                  }}
                  rows={3}
                  maxLength={140}
                  className="mt-2 w-full rounded-xl border border-white/[0.06] bg-[#0B0C11] px-3 py-3 text-sm text-[#F5F3FF] outline-none"
                  placeholder="Dinner split"
                />
                <div className="mt-2 text-right text-[11px] text-[#A1A1AA]">{requestNote.length}/140</div>
              </label>

              {requestLink ? (
                <div className="space-y-3 rounded-2xl border border-white/[0.06] bg-[#16171C] p-4">
                  <div className="flex flex-col items-center gap-4">
                    <div className="relative rounded-2xl border border-white/[0.06] bg-[#16171C] p-4">
                      <QRCodeSVG value={requestLink} size={180} includeMargin bgColor="#161616" fgColor="#FAFAFA" />
                      <img
                        src={logoUrl}
                        alt=""
                        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-16 w-16 pointer-events-none"
                      />
                    </div>
                    <button
                      onClick={async () => {
                        if (!requestLink) return;
                        await navigator.clipboard.writeText(requestLink);
                        setCopied(true);
                        setRequestLinkCopied(true);
                        window.setTimeout(() => setCopied(false), 1300);
                        window.setTimeout(() => setRequestLinkCopied(false), 1300);
                      }}
                      className="flex items-center gap-2 rounded-full border border-white/[0.06] bg-[#16171C] px-4 py-2 text-sm text-[#F5F3FF]"
                    >
                      {requestLinkCopied ? <CheckCircle2 className="h-4 w-4 text-emerald-500/70" /> : <Copy className="h-4 w-4" />}
                      {requestLinkCopied ? 'Copied' : 'Copy request link'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-white/[0.06] bg-[#16171C] p-4 text-sm text-[#A1A1AA]">
                  Enter a valid positive amount to generate a shareable request QR code and deep link.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {showScanner ? (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-[20px] border border-white/[0.06] bg-[#111216] p-5 shadow-[0_0_60px_rgba(0,0,0,0.4)]">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xl font-semibold">Scan QR</h3>
                <p className="text-xs text-[#A1A1AA]">Point your camera at an ArcPay deep link.</p>
              </div>
              <button onClick={() => setShowScanner(false)} className="text-sm text-[#A1A1AA]">Close</button>
            </div>

            <div className="mt-4 overflow-hidden rounded-2xl border border-white/[0.06] bg-[#0B0C11]">
              <div className="relative aspect-[4/5] w-full bg-black">
                <video ref={videoRef} className="h-full w-full object-cover" playsInline muted autoPlay />
                <div className="pointer-events-none absolute inset-4 rounded-3xl border-2 border-[#069494]/80" />
                <div className="pointer-events-none absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-white/20" />
                {scannerSuccess ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-[#069494]/10 backdrop-blur-[1px]">
                    <div className="rounded-full border border-[#069494]/40 bg-[#111216]/80 px-4 py-2 text-sm font-medium text-[#069494]">
                      Scan complete
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            {scannerError ? (
              <div className="mt-4 rounded-2xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
                {scannerError}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {showContacts ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-[20px] border border-white/[0.06] bg-[#111216] p-6 shadow-[0_0_60px_rgba(0,0,0,0.4)]">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">Contacts</h3>
              <button onClick={() => setShowContacts(false)} className="text-sm text-[#A1A1AA]">Close</button>
            </div>

            <div className="mt-5 space-y-4">
              {/* Add contact button */}
              <button
                onClick={() => setIsAddContactOpen(!isAddContactOpen)}
                className={`w-full flex items-center justify-center gap-2 rounded-xl border ${
                  isAddContactOpen
                    ? 'border-[#069494] bg-[#069494]/10 text-[#069494]'
                    : 'border-white/[0.06] bg-[#16171C] text-[#F5F3FF] hover:text-[#F5F3FF]'
                } py-2.5 text-sm font-medium transition`}
                aria-label="Add contact"
              >
                {isAddContactOpen ? <X size={18} /> : <Plus size={18} />}
                Add Contact
              </button>

              {isAddContactOpen && (
                <div className="rounded-2xl border border-white/[0.06] bg-[#16171C] p-4">
                  <p className="mb-3 text-[11px] uppercase tracking-[0.28em] text-[#A1A1AA]">Add contact</p>
                  <div className="space-y-3">
                    <input
                      value={addContactInput}
                      onChange={(e) => {
                        setAddContactInput(e.target.value);
                        if (addContactError) {
                          setAddContactError(null);
                        }
                      }}
                      className="w-full rounded-xl border border-white/[0.06] bg-[#0B0C11] px-3 py-2.5 text-sm text-[#F5F3FF] outline-none"
                      placeholder="0x... or name.arc"
                    />
                    <input
                      value={addContactLabel}
                      onChange={(e) => setAddContactLabel(e.target.value.trimStart())}
                      className="w-full rounded-xl border border-white/[0.06] bg-[#0B0C11] px-3 py-2.5 text-sm text-[#F5F3FF] outline-none"
                      placeholder="Label (optional)"
                    />

                    <div className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          void handleAddContact();
                          // Auto-collapse form after successful submission
                          if (!addContactError && addContactInput.trim() && addContactStatus !== 'resolving') {
                            setIsAddContactOpen(false);
                          }
                        }}
                        disabled={!addContactInput.trim() || addContactStatus === 'resolving'}
                        className="rounded-xl bg-[#069494] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#058A8A] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Add
                      </button>
                      {addContactStatus === 'resolving' ? (
                        <div className="inline-flex items-center gap-2 rounded-full border border-[#069494]/30 bg-[#0B0C11] px-3 py-1 text-[11px] text-[#069494]">
                          <span className="h-2 w-2 animate-pulse rounded-full bg-[#069494]" />
                          Resolving…
                        </div>
                      ) : null}
                    </div>

                    {addContactError ? <p className="text-xs text-rose-500/70">{addContactError}</p> : null}
                  </div>
                </div>
              )}

              {/* Search bar */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#A1A1AA]" />
                <input
                  type="text"
                  value={contactSearchQuery}
                  onChange={(e) => setContactSearchQuery(e.target.value)}
                  placeholder="Search contacts..."
                  className="w-full rounded-xl border border-white/[0.06] bg-[#0B0C11] pl-10 pr-4 py-2.5 text-sm text-[#F5F3FF] outline-none"
                />
              </div>

              {/* Filtered contacts list */}
              {(() => {
                const filteredContacts = filterContacts(contacts, contactSearchQuery);
                return filteredContacts.length === 0 ? (
                  <div className="rounded-2xl border border-white/[0.06] bg-[#16171C] p-4 text-sm text-[#A1A1AA]">
                    {contacts.length === 0 ? 'No saved contacts yet.' : 'No contacts match your search.'}
                  </div>
                ) : (
                  <div className="space-y-3 max-h-96 overflow-y-auto">
                    {filteredContacts.map((contact) => (
                      <div key={contact.id} className="flex items-center justify-between gap-3 rounded-2xl border border-white/[0.06] bg-[#16171C] p-3">
                        <button
                          type="button"
                          onClick={() => {
                            setSendAddress(contact.address);
                            setResolvedSendAddress(contact.address);
                            setRecipientResolutionStatus('idle');
                            validateSendRecipient(contact.address);
                            setShowContacts(false);
                          }}
                          className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        >
                          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#069494]/15 text-[11px] font-semibold text-[#069494]">
                            {formatContactLabel(contact)
                              .split(/\s+/)
                              .filter(Boolean)
                              .slice(0, 2)
                              .map((part) => part[0]?.toUpperCase() ?? '')
                              .join('') || contact.address.slice(2, 4).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-[#F5F3FF]">{formatContactLabel(contact)}</p>
                            <p className="truncate text-xs text-[#A1A1AA]">{contact.address}</p>
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const nextContacts = removeContact(contact.address);
                            setContacts(nextContacts);
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.06] bg-[#0B0C11] text-[#A1A1AA] transition hover:border-red-500/50 hover:text-red-300"
                          aria-label={`Delete ${formatContactLabel(contact)}`}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      ) : null}

      {showSend ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-[20px] border border-white/[0.06] bg-[#111216] p-6 shadow-[0_0_60px_rgba(0,0,0,0.4)]">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">Send</h3>
              <button onClick={() => {
                setShowSend(false);
                setShowContacts(false);
                setShowContactLabelInput(false);
                setContactLabelDraft('');
                setSendReview(false);
                setGasFeeEstimate(null);
                setIsEstimatingGasFee(false);
                setGasFeeEstimateError(null);
                setSendAmount('');
                setSendAddress('');
                setSendAmountError('');
                setSendRecipientError('');
                setRecipientResolutionStatus('idle');
                setResolvedSendAddress(null);
                setScannedRequestNote('');
                setIsResolvingArcName(false);
              }} className="text-sm text-[#A1A1AA]">Close</button>
            </div>
            <div className="mt-6 space-y-4">
              {sendReview ? (
                <div className="space-y-4">
                  <div className="rounded-2xl border border-white/[0.06] bg-[#16171C] p-4">
                    <div className="flex items-center justify-between text-sm text-[#A1A1AA]">
                      <span>Asset</span>
                      <span className="text-[#F5F3FF]">{selectedSendAsset.symbol}</span>
                    </div>
                    <div className="mt-3 flex items-center justify-between text-sm text-[#A1A1AA]">
                      <span>Amount</span>
                      <div className="text-right">
                        <span className="text-[#F5F3FF]">{sendAmount} {selectedSendAsset.symbol}</span>
                        {(() => {
                          const usdValue = getAssetUsdValue(selectedSendAsset.symbol, sendAmount);
                          return usdValue !== null ? (
                            <span className="ml-2 text-xs text-[#71717A]">≈ ${formatDisplayBalance(usdValue)}</span>
                          ) : null;
                        })()}
                      </div>
                    </div>
                    <div className="mt-3 flex items-center justify-between text-sm text-[#A1A1AA]">
                      <span>Recipient</span>
                      <span className="break-all text-right text-[#F5F3FF]">{sendTarget}</span>
                    </div>
                    <div className="mt-3 flex items-center justify-between text-sm text-[#A1A1AA]">
                      <span>Network Fee</span>
                      {isEstimatingGasFee ? (
                        <span className="flex items-center gap-1.5 text-xs text-[#71717A]">
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                          Estimating…
                        </span>
                      ) : gasFeeEstimate !== null ? (
                        <div className="text-right">
                          <span className="text-[#F5F3FF]">{gasFeeEstimate} USDC</span>
                          {(() => {
                            const feeUsd = getAssetUsdValue('USDC', gasFeeEstimate);
                            return feeUsd !== null ? (
                              <span className="ml-2 text-xs text-[#71717A]">≈ ${formatDisplayBalance(feeUsd)}</span>
                            ) : null;
                          })()}
                        </div>
                      ) : (
                        <span className="text-xs text-[#71717A]">
                          {gasFeeEstimateError ?? 'Fee unavailable — you can still send'}
                        </span>
                      )}
                    </div>
                    {(() => {
                      const feeSummary = buildFeeSummary({
                        sentAmount: sendAmount,
                        sentSymbol: selectedSendAsset.symbol,
                        estimatedFeeUsdc: gasFeeEstimate,
                      });
                      return feeSummary.showTotal && feeSummary.total !== null ? (
                        <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-3 text-sm">
                          <span className="font-medium text-[#F5F3FF]">Total</span>
                          <span className="font-medium text-[#F5F3FF]">{feeSummary.total} USDC</span>
                        </div>
                      ) : null;
                    })()}
                    {isResolvingArcName ? (
                      <div className="mt-3 rounded-xl border border-[#069494]/30 bg-[#0B0C11] p-3 text-sm text-[#069494]">
                        Resolving ArcName handle…
                      </div>
                    ) : null}
                  </div>

                  <button
                    onClick={() => void handleSend()}
                    disabled={txState === 'pending' || isResolvingArcName}
                    className="w-full rounded-2xl bg-[#069494] px-4 py-3 font-medium text-white transition hover:bg-[#058A8A] disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {txState === 'pending' ? 'Sending…' : 'Send Now'}
                  </button>
                </div>
              ) : (
                <>
                  <AssetSelector
                    id="send-asset"
                    label="Asset"
                    assets={sendAssets}
                    value={sendAssetKey}
                    onChange={(key) => {
                      setSendAssetKey(key);
                      setSendAmountError('');
                    }}
                  />

                  {scannedRequestNote ? (
                    <div className="rounded-2xl border border-[#069494]/30 bg-[#0B0C11] p-3 text-sm text-[#069494]">
                      <p className="text-[11px] uppercase tracking-[0.28em] text-[#A1A1AA]">Requested</p>
                      <p className="mt-2 break-words text-[#F5F3FF]">{scannedRequestNote}</p>
                    </div>
                  ) : null}

                  <label className="block text-sm text-[#A1A1AA]">
                    <span className="mb-2 block">Recipient</span>
                    <div className="relative mt-2">
                      <div className={`flex items-center gap-2 rounded-[14px] border bg-[#0B0C11] px-3 py-2 transition-fast ${sendRecipientError ? 'border-red-500/60' : 'border-white/[0.06] focus-within:border-[#069494]/30'}`}>
                        <input
                          value={sendAddress}
                          onChange={(e) => {
                            setSendAddress(e.target.value);
                            setResolvedSendAddress(null);
                            setRecipientResolutionStatus('idle');
                            setShowContactLabelInput(false);
                            setContactLabelDraft('');
                            setShowContactPicker(false);
                            validateSendRecipient(e.target.value);
                          }}
                          className="w-full bg-transparent text-sm text-[#F5F3FF] outline-none"
                          placeholder="0x... or name.arc"
                        />
                        <button
                          type="button"
                          onClick={() => setShowContactPicker((current) => !current)}
                          className="flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.06] bg-[#111216] text-[#A1A1AA] transition hover:border-[#069494]/40 hover:text-[#F5F3FF]"
                          aria-label="Open contacts"
                        >
                          <Users className="h-4 w-4" />
                        </button>
                        {recipientResolutionStatus === 'resolved' ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-500/70" />
                        ) : null}
                        {recipientResolutionStatus === 'idle' && getContactTargetAddress() ? (
                          <button
                            type="button"
                            onClick={() => setShowContactLabelInput((current) => !current)}
                            className="rounded-full border border-white/[0.06] bg-[#111216] px-2.5 py-1 text-[11px] font-medium text-[#F5F3FF] transition hover:border-[#069494]/40"
                          >
                            Save
                          </button>
                        ) : null}
                        {looksLikeArcNameHandle(sendAddress) && recipientResolutionStatus !== 'resolved' ? (
                          <button
                            type="button"
                            onClick={() => void handleCheckArcName()}
                            disabled={isResolvingArcName || recipientResolutionStatus === 'checking'}
                            className="rounded-full border border-[#069494]/40 bg-[#111216] px-2.5 py-1 text-[11px] font-medium text-[#069494] transition hover:border-[#069494]/40 disabled:cursor-not-allowed disabled:opacity-70"
                          >
                            {recipientResolutionStatus === 'checking' ? 'Checking…' : 'Check'}
                          </button>
                        ) : null}
                      </div>

                      {showContactPicker ? (
                        <div className="mt-2 rounded-2xl border border-white/[0.06] bg-[#111216] p-2 shadow-[0_0_30px_rgba(0,0,0,0.25)]">
                          {contacts.length === 0 ? (
                            <div className="rounded-xl border border-white/[0.06] bg-[#16171C] px-3 py-3 text-xs text-[#A1A1AA]">
                              No saved contacts yet.
                            </div>
                          ) : (
                            <div className="max-h-48 space-y-2 overflow-y-auto">
                              {contacts.map((contact) => (
                                <button
                                  key={contact.id}
                                  type="button"
                                  onClick={() => {
                                    setSendAddress(contact.address);
                                    setResolvedSendAddress(contact.address);
                                    setRecipientResolutionStatus('idle');
                                    setShowContactPicker(false);
                                    validateSendRecipient(contact.address);
                                  }}
                                  className="flex w-full items-center gap-2 rounded-xl border border-white/[0.06] bg-[#16171C] px-3 py-2 text-left transition hover:border-[#069494]/40"
                                >
                                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#069494]/15 text-[10px] font-semibold text-[#069494]">
                                    {formatContactLabel(contact)
                                      .split(/\s+/)
                                      .filter(Boolean)
                                      .slice(0, 2)
                                      .map((part) => part[0]?.toUpperCase() ?? '')
                                      .join('') || contact.address.slice(2, 4).toUpperCase()}
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-xs font-medium text-[#F5F3FF]">{formatContactLabel(contact)}</p>
                                    <p className="truncate text-[11px] text-[#A1A1AA]">{contact.address}</p>
                                  </div>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>

                    {showContactLabelInput && getContactTargetAddress() ? (
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          value={contactLabelDraft}
                          onChange={(e) => setContactLabelDraft(e.target.value.slice(0, 40))}
                          className="w-full rounded-xl border border-white/[0.06] bg-[#0B0C11] px-3 py-2 text-sm text-[#F5F3FF] outline-none"
                          placeholder="Optional label"
                        />
                        <button
                          type="button"
                          onClick={handleSaveCurrentContact}
                          className="rounded-xl bg-[#069494] px-3 py-2 text-xs font-medium text-white"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowContactLabelInput(false);
                            setContactLabelDraft('');
                          }}
                          className="text-xs text-[#A1A1AA]"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : null}

                    {sendRecipientError ? <p className="mt-2 text-xs text-rose-500/70">{sendRecipientError}</p> : null}
                    {recipientResolutionStatus === 'resolved' && resolvedSendAddress ? (
                      <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald-500/70">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Resolved to {resolvedSendAddress.slice(0, 6)}...{resolvedSendAddress.slice(-4)}
                      </p>
                    ) : null}
                    {recipientResolutionStatus === 'unsupported' ? (
                      <p className="mt-2 text-xs text-[#A1A1AA]">
                        This name isn't resolvable yet: enter a 0x address instead.
                      </p>
                    ) : null}
                    {isResolvingArcName ? (
                      <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-[#069494]/30 bg-[#0B0C11] px-3 py-1 text-[11px] text-[#069494]">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-[#069494]" />
                        Resolving ArcName handle…
                      </div>
                    ) : null}
                  </label>

                  <label className="block text-sm text-[#A1A1AA]">
                    Amount
                    <div className="mt-2 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-[#0B0C11] px-3 py-3">
                      <input
                        value={sendAmount}
                        onChange={(e) => {
                          setSendAmount(e.target.value);
                          validateSendAmount(e.target.value);
                        }}
                        className="w-full bg-transparent text-sm text-[#F5F3FF] outline-none"
                        placeholder="0.10"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setSendAmount(selectedSendAsset.balance);
                          setSendAmountError('');
                        }}
                        disabled={txState === 'pending'}
                        className="rounded-full border border-white/[0.06] bg-[#16171C] px-2.5 py-1 text-[11px] font-medium text-[#A1A1AA] transition-fast hover:border-[#069494]/30 hover:text-[#F5F3FF]"
                      >
                        Max
                      </button>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-[#A1A1AA]">
                      <span>Available: {formatDisplayBalance(selectedSendAsset.balance)} {selectedSendAsset.symbol}</span>
                    </div>
                    <div className="mt-2 flex gap-2">
                      {[25, 50, 75, 100].map((percent) => (
                        <button
                          key={percent}
                          type="button"
                          onClick={() => {
                            const balance = parseFloat(selectedSendAsset.balance);
                            setSendAmount(formatAmountForInput(balance * (percent / 100), selectedSendAsset.decimals ?? getAssetDecimals(selectedSendAsset.symbol)));
                            setSendAmountError('');
                          }}
                          disabled={txState === 'pending'}
                          className="flex-1 rounded-full border border-white/[0.06] bg-[#16171C] px-2.5 py-1.5 text-xs font-medium text-[#A1A1AA] transition-fast hover:border-[#069494]/30 hover:text-[#F5F3FF]"
                        >
                          {percent}%
                        </button>
                      ))}
                    </div>
                    {sendAmountError ? <p className="mt-2 text-xs text-rose-500/70">{sendAmountError}</p> : null}
                  </label>

                  <button
                    onClick={() => void handleSendReview()}
                    disabled={txState === 'pending' || isResolvingArcName}
                    className="w-full rounded-2xl bg-[#069494] px-4 py-3 font-medium text-white transition hover:bg-[#058A8A] disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {txState === 'pending' ? 'Confirming…' : 'Confirm payment'}
                  </button>
                </>
              )}

              {txState === 'confirming' && txHash ? (
                <div className="rounded-2xl border border-[#069494]/40 bg-[#069494]/10 p-3 text-sm text-[#069494]">
                  <div className="flex items-center gap-2">
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    <p>{txConfirmationTimedOut ? 'Still confirming — check the explorer' : 'Confirming on-chain…'}</p>
                  </div>
                  <a href={`${EXPLORER_URL}/tx/${txHash}`} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-2 text-[#069494]">
                    View on explorer <ExternalLink className="h-4 w-4" />
                  </a>
                </div>
              ) : null}
              {txState === 'success' && txHash ? (
                <div className="rounded-2xl border border-emerald-700/40 bg-emerald-500/10 p-3 text-sm text-emerald-300">
                  <p>Transaction confirmed on-chain.</p>
                  <a href={`${EXPLORER_URL}/tx/${txHash}`} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-2 text-emerald-200">
                    View on explorer <ExternalLink className="h-4 w-4" />
                  </a>
                </div>
              ) : null}
              {txState === 'error' ? (
                <div className="rounded-2xl border border-red-700/40 bg-red-500/10 p-3 text-sm text-red-300">
                  <p>{txErrorDetail ?? error ?? 'Transaction failed.'}</p>
                  {txHash ? (
                    <a href={`${EXPLORER_URL}/tx/${txHash}`} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-2 text-red-200">
                      View on explorer <ExternalLink className="h-4 w-4" />
                    </a>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 z-10 border-t border-white/[0.06] bg-[#08090D]/95 backdrop-blur-xl">
        <div className="relative mx-auto flex h-[72px] max-w-md items-center justify-around">
          {/* Left: Contacts */}
          <button
            onClick={() => setShowContacts(true)}
            className="group flex h-11 w-11 items-center justify-center rounded-full transition-fast hover:bg-white/[0.04]"
            aria-label="Contacts"
          >
            <Users className="h-5 w-5 text-[#71717A] transition-fast group-hover:text-[#A1A1AA]" />
          </button>

          {/* Center: Scan — primary action */}
          <button
            onClick={() => setShowScanner(true)}
            aria-label="Scan QR code"
            className="group relative -mt-5 flex h-14 w-14 items-center justify-center rounded-full bg-[#069494] text-white shadow-scan transition-normal hover:bg-[#058A8A] hover:shadow-scan-hover active:scale-95"
          >
            <ScanLine className="h-6 w-6" strokeWidth={2} />
            {/* Subtle pulse ring on hover */}
            <span className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-[#069494]/30 transition-normal group-hover:ring-[#069494]/50" />
          </button>

          {/* Right: Settings */}
          <button
            onClick={() => setShowSettings(true)}
            className="group flex h-11 w-11 items-center justify-center rounded-full transition-fast hover:bg-white/[0.04]"
            aria-label="Settings"
          >
            <Settings className="h-5 w-5 text-[#71717A] transition-fast group-hover:text-[#A1A1AA]" />
          </button>
        </div>
      </nav>
    </div>
  );
}

export default App;