import { useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
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
} from 'lucide-react';
import logoUrl from './assets/logo.png';
import { QRCodeSVG } from 'qrcode.react';
import { BrowserQRCodeReader } from '@zxing/browser';
import {
  buildRequestLink,
  filterNonZeroAssetBalances,
  formatDisplayBalance,
  formatTokenBalance,
  getAssetDecimals,
  getTransactionDisplayMeta,
  isStableUsdPegged,
  parseNativeBalance,
  parseTokenBalances,
  parseTransactionDirection,
} from './balance';
import {
  type Contact,
  formatContactLabel,
  getContacts,
  removeContact,
  saveContact,
} from './contacts';
import { resolveArcName } from './utils/arcName';
import {
  decryptWallet,
  encryptWallet,
  getKeystoreFromStorage,
  hasLegacyKey,
  removeKeystoreFromStorage,
  setKeystoreInStorage,
  STORAGE_KEY_LEGACY,
} from './utils/walletStorage';

const ARC_RPC_URL = 'https://5042002.rpc.thirdweb.com';
const ARC_CHAIN_ID = 5042002;
const ARC_NETWORK_NAME = 'Arc Testnet';
const ARC_CURRENCY_SYMBOL = 'USDC';
const EXPLORER_URL = 'https://testnet.arcscan.app';
const ARC_EXPLORER_API_URL = 'https://testnet.arcscan.app/api/v2';
const NATIVE_VALUE_DECIMALS = 18;
export const ERC20_TRANSFER_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];
const ASSET_ICON_URLS: Record<string, string> = {
  USDC: 'https://cryptologos.cc/logos/usd-coin-usdc-logo.png',
  EURC: 'https://orbmarkets.io/api/icons/euroCoin.png',
  cirBTC: 'https://assets.coingecko.com/coins/images/102172745/standard/cirbtc.jpg',
  CIRBTC: 'https://assets.coingecko.com/coins/images/102172745/standard/cirbtc.jpg',
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

const isValidPrivateKey = (input: string) => {
  const normalized = input.trim();
  if (!normalized) return false;
  if (/^0x[0-9a-fA-F]{64}$/.test(normalized)) return true;
  const parts = normalized.split(/\s+/);
  return parts.length === 12 && parts.every((part) => part.length > 0);
};

type ArcWallet = ethers.Wallet | ethers.HDNodeWallet;

type ScanPayload =
  | { kind: 'pay'; id: string }
  | { kind: 'request'; id: string; amount: string; note: string }
  | { kind: 'address'; id: string };

type BarcodeDetectorLike = {
  detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>>;
};

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

type TransactionHistoryItem = {
  hash: string;
  from: string;
  to: string;
  value: string;
  tokenSymbol: string;
  decimals: number;
  timestamp: number;
  direction: 'sent' | 'received';
  status: 'ok' | 'pending' | 'error';
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
    className: 'border-red-700/40 bg-red-500/10 text-red-400',
  },
  pending: {
    label: 'Pending',
    className: 'border-[#27272A] bg-[#161616] text-[#A1A1AA]',
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
    candidates.map(async (item) => {
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

// PIN Input component
const PinInput = ({
  value,
  onChange,
  placeholder = 'Enter PIN',
  disabled = false,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  error?: string | null;
}) => (
  <input
    type="password"
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className={`w-full rounded-xl border bg-[#0a0a0a] px-3 py-3 text-sm text-[#FAFAFA] outline-none ${
      error ? 'border-red-500' : 'border-[#27272A]'
    }`}
    placeholder={placeholder}
    disabled={disabled}
    maxLength={20}
  />
);

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
  const [selectedAssetDetail, setSelectedAssetDetail] = useState<string | null>(null);
  const [sendRecipientError, setSendRecipientError] = useState('');
  const [recipientCheckMessage, setRecipientCheckMessage] = useState<string | null>(null);
  const [recipientResolutionStatus, setRecipientResolutionStatus] = useState<'idle' | 'checking' | 'resolved' | 'unsupported'>('idle');
  const [sendAmountError, setSendAmountError] = useState('');
  const [requestAssetKey, setRequestAssetKey] = useState('usdc');
  const [requestAmount, setRequestAmount] = useState('');
  const [requestNote, setRequestNote] = useState('');
  const [requestAmountError, setRequestAmountError] = useState('');
  const [txState, setTxState] = useState<'idle' | 'pending' | 'confirming' | 'success' | 'error'>('idle');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txConfirmationTimedOut, setTxConfirmationTimedOut] = useState(false);
  const [txErrorDetail, setTxErrorDetail] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [assetBalances, setAssetBalances] = useState<Array<{ key: string; symbol: string; balance: string; decimals: number }>>([
    { key: 'usdc', symbol: 'USDC', balance, decimals: 6 },
  ]);
  const [tokenAssets, setTokenAssets] = useState<Array<{ key: string; symbol: string; balance: string; decimals: number }>>([]);
  const [showAssetBreakdown, setShowAssetBreakdown] = useState(false);
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

  // Wallet security state
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [isMigrating, setIsMigrating] = useState(false);
  const [unlockPin, setUnlockPin] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [migrationPin, setMigrationPin] = useState('');
  const [migrationPinConfirm, setMigrationPinConfirm] = useState('');
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showCreatePin, setShowCreatePin] = useState(false);
  const [createPin, setCreatePin] = useState('');
  const [createPinConfirm, setCreatePinConfirm] = useState('');
  const [createPinError, setCreatePinError] = useState<string | null>(null);
  const [pendingWalletData, setPendingWalletData] = useState<{ privateKey: string; wallet: ArcWallet } | null>(null);

  // Seed phrase reveal state
  const [pendingMnemonic, setPendingMnemonic] = useState<string | null>(null);
  const [showMnemonicReveal, setShowMnemonicReveal] = useState(false);
  const [hasConfirmedMnemonicSave, setHasConfirmedMnemonicSave] = useState(false);
  const [copiedPhrase, setCopiedPhrase] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerStreamRef = useRef<MediaStream | null>(null);
  const scannerLoopRef = useRef<number | null>(null);
  const fallbackReaderRef = useRef<BrowserQRCodeReader | null>(null);

  const provider = useMemo(() => new ethers.JsonRpcProvider(ARC_RPC_URL), []);

  // Initialize wallet state on mount
  useEffect(() => {
    // Check for keystore first (encrypted wallet)
    const keystore = getKeystoreFromStorage();
    if (keystore) {
      setIsUnlocking(true);
      return;
    }

    // Check for legacy key (plaintext - needs migration)
    if (hasLegacyKey()) {
      setIsMigrating(true);
      return;
    }

    // No wallet found, show create/import screen
  }, [provider]);

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
      setTransactions(nextTransactions);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Unable to fetch transaction history.');
      setTransactions([]);
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

  // Handle wallet unlock with PIN
  const handleUnlock = async (pin: string) => {
    setIsProcessing(true);
    setUnlockError(null);

    try {
      const keystore = getKeystoreFromStorage();
      if (!keystore) {
        throw new Error('Keystore not found');
      }

      const decryptedWallet = await decryptWallet(keystore, pin);
      const connectedWallet = decryptedWallet.connect(provider);
      setWallet(connectedWallet);
      setIsUnlocking(false);
      setUnlockPin('');
      void refreshWalletData(connectedWallet);
    } catch (err) {
      // Don't leak whether the keystore is malformed vs password is wrong
      setUnlockError('Incorrect PIN or corrupted wallet');
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle migration from legacy plaintext key to encrypted keystore
  const handleMigrate = async () => {
    if (migrationPin.length < 6) {
      setMigrationError('PIN must be at least 6 characters');
      return;
    }

    if (migrationPin !== migrationPinConfirm) {
      setMigrationError('PINs do not match');
      return;
    }

    setIsProcessing(true);
    setMigrationError(null);

    try {
      const legacyKey = localStorage.getItem(STORAGE_KEY_LEGACY);
      if (!legacyKey) {
        throw new Error('Legacy key not found');
      }

      // Create encrypted keystore
      const keystore = await encryptWallet(legacyKey, migrationPin);
      setKeystoreInStorage(keystore);

      // Remove legacy key
      localStorage.removeItem(STORAGE_KEY_LEGACY);

      // Load the wallet
      const decryptedWallet = await decryptWallet(keystore, migrationPin);
      const connectedWallet = decryptedWallet.connect(provider);
      setWallet(connectedWallet);
      setIsMigrating(false);
      setMigrationPin('');
      setMigrationPinConfirm('');
      void refreshWalletData(connectedWallet);
    } catch (err) {
      setMigrationError('Failed to secure wallet');
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle new wallet creation - show mnemonic first, then PIN
  const handleCreateWallet = async () => {
    setIsProcessing(true);
    setError(null);
    
    try {
      const created = ethers.Wallet.createRandom().connect(provider);
      const privateKeyValue = created.privateKey;

      // Extract mnemonic for new wallet creation
      const mnemonic = created.mnemonic?.phrase;
      if (mnemonic) {
        setPendingMnemonic(mnemonic);
        setShowMnemonicReveal(true);
      }

      // Store the wallet temporarily in state, but don't set it yet
      // We'll set it after the user confirms the mnemonic and creates a PIN
      setPendingWalletData({ privateKey: privateKeyValue, wallet: created });
    } catch (err) {
      setError('Wallet creation failed');
    } finally {
      setIsProcessing(false);
    }
  };

  // Finalize wallet creation after PIN is set
  const finalizeCreateWallet = async (pin: string) => {
    if (pin.length < 6) {
      setCreatePinError('PIN must be at least 6 characters');
      return;
    }

    if (pin !== createPinConfirm) {
      setCreatePinError('PINs do not match');
      return;
    }

    if (!pendingWalletData) {
      setCreatePinError('No wallet data to finalize');
      return;
    }

    setIsProcessing(true);
    setCreatePinError(null);

    try {
      // Encrypt immediately - never write plaintext to storage
      const keystore = await encryptWallet(pendingWalletData.privateKey, pin);
      setKeystoreInStorage(keystore);

      setWallet(pendingWalletData.wallet);
      setShowCreatePin(false);
      setCreatePin('');
      setCreatePinConfirm('');
      setPendingWalletData(null);
      // Clear mnemonic state as we're done with the creation flow
      setPendingMnemonic(null);
      setShowMnemonicReveal(false);
      void refreshWalletData(pendingWalletData.wallet);
    } catch (err) {
      setCreatePinError('Wallet creation failed');
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

      // Store temporarily in state, show PIN modal
      setPendingWalletData({ privateKey: privateKeyValue, wallet: imported });
      setShowCreatePin(true);
      setImportInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wallet import failed.');
    } finally {
      setIsLoading(false);
    }
  };

  // Finalize wallet import after PIN is set
  const finalizeImportWallet = async (pin: string) => {
    if (!pendingWalletData) {
      setCreatePinError('No wallet data to import');
      return;
    }

    if (pin.length < 6) {
      setCreatePinError('PIN must be at least 6 characters');
      return;
    }

    if (pin !== createPinConfirm) {
      setCreatePinError('PINs do not match');
      return;
    }

    setIsProcessing(true);
    setCreatePinError(null);

    try {
      // Encrypt immediately - never write plaintext to storage
      const keystore = await encryptWallet(pendingWalletData.privateKey, pin);
      setKeystoreInStorage(keystore);

      setWallet(pendingWalletData.wallet);
      setShowCreatePin(false);
      setCreatePin('');
      setCreatePinConfirm('');
      setPendingWalletData(null);
      // Don't show mnemonic reveal for imported wallets
      setPendingMnemonic(null);
      setShowMnemonicReveal(false);
      void refreshWalletData(pendingWalletData.wallet);
    } catch (err) {
      setCreatePinError('Wallet import failed');
    } finally {
      setIsProcessing(false);
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
    setIsUnlocking(true);
  };



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
    // Clear the mnemonic state and hide the reveal screen
    setPendingMnemonic(null);
    setShowMnemonicReveal(false);
    // Show the PIN creation screen
    setShowCreatePin(true);
    setCreatePin('');
    setCreatePinConfirm('');
    setCreatePinError(null);
  };

  const requestAssets = useMemo(() => {
    const sourceAssets = tokenAssets.length > 0 ? tokenAssets : assetBalances;
    const nonZeroAssets = filterNonZeroAssetBalances(sourceAssets);
    const hasUsdc = nonZeroAssets.some((asset) => asset.symbol === 'USDC');

    if (hasUsdc) {
      return nonZeroAssets;
    }

    return [
      { key: 'usdc', symbol: 'USDC', balance: '0', decimals: 6 },
      ...nonZeroAssets,
    ];
  }, [assetBalances, tokenAssets]);

  const openRequestModal = () => {
    const defaultAsset = requestAssets.find((asset) => asset.symbol === 'USDC')
      ?? requestAssets.find((asset) => Number(asset.balance) > 0)
      ?? { key: 'usdc', symbol: 'USDC', balance: '0', decimals: 6 };

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

  const sendAssets = useMemo(() => {
    return filterNonZeroAssetBalances(tokenAssets.length > 0 ? tokenAssets : assetBalances);
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

    setRecipientCheckMessage(null);
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
      setRecipientCheckMessage(null);
      setRecipientResolutionStatus('idle');
      return false;
    }

    const looksLikeAddress = /^0x[a-fA-F0-9]{40}$/.test(input);
    const looksLikeArcName = looksLikeArcNameHandle(input);

    if (looksLikeAddress) {
      const checksum = ethers.getAddress(input);
      setSendRecipientError('');
      setResolvedSendAddress(checksum);
      setRecipientCheckMessage(null);
      setRecipientResolutionStatus('idle');
      setIsResolvingArcName(false);
      return true;
    }

    if (looksLikeArcName) {
      setSendRecipientError('');
      setResolvedSendAddress(null);
      setRecipientCheckMessage(null);
      setRecipientResolutionStatus('idle');
      setIsResolvingArcName(false);
      return true;
    }

    setSendRecipientError('Enter a valid checksummed address or a handle ending in .arc.');
    setResolvedSendAddress(null);
    setRecipientCheckMessage(null);
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
          const decoded = result?.getText?.().trim();
          if (decoded) {
            window.clearInterval(scannerLoopRef.current ?? undefined);
            handleScanPayload(decoded);
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

      // Move to 'confirming' state immediately so UI shows hash + spinner
      setTxState('confirming');
      setSendReview(false);

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
            void refreshTransactionHistory();
          } else if (receipt?.status === 0) {
            setTxState('error');
            setTxErrorDetail('Transaction reverted on-chain.');
          } else {
            // Receipt without clear status after timeout — leave in confirming with timed-out flag
            setTxState('confirming');
          }
        } else if (receipt?.status === 1) {
          setTxState('success');
          void refreshTransactionHistory();
        } else if (receipt?.status === 0) {
          setTxState('error');
          setTxErrorDetail('Transaction reverted on-chain.');
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
        if (!isStableUsdPegged(asset.symbol)) {
          return total;
        }
        const numericBalance = Number.parseFloat(asset.balance.replace(/,/g, ''));
        return total + (Number.isFinite(numericBalance) ? numericBalance : 0);
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

  // Unlock screen - shown when keystore exists
  if (isUnlocking) {
    return (
      <div className="min-h-screen bg-[#050505] text-[#FAFAFA] flex items-center justify-center px-4 py-10">
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute -top-24 right-0 h-72 w-72 rounded-full bg-blue-600/10 blur-3xl" />
        </div>
        <div className="relative w-full max-w-md rounded-2xl border border-[#27272A] bg-[#121212]/80 p-8 shadow-[0_0_80px_rgba(0,0,0,0.35)] backdrop-blur-md">
          <div className="mb-8 flex items-center gap-3">
            <div className="rounded-full border border-[#27272A] bg-[#161616] p-2">
              <Lock className="h-5 w-5 text-[#3B82F6]" />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.3em] text-[#A1A1AA]">Secure</p>
              <h1 className="text-xl font-semibold tracking-tight text-[#FAFAFA]">Unlock Wallet</h1>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-sm text-[#A1A1AA]">Enter your PIN</label>
              <PinInput
                value={unlockPin}
                onChange={setUnlockPin}
                placeholder="Enter PIN"
                disabled={isProcessing}
                error={unlockError}
              />
              {unlockError && <p className="mt-2 text-sm text-red-400">{unlockError}</p>}
            </div>

            <button
              onClick={() => handleUnlock(unlockPin)}
              disabled={isProcessing || unlockPin.length === 0}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-[#3B82F6] px-4 py-3 font-medium text-white transition hover:bg-[#2563EB] disabled:opacity-70"
            >
              {isProcessing ? (
                <>
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  Unlocking...
                </>
              ) : 'Unlock Wallet'}
            </button>
          </div>
        </div>
      </div>
    );
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
      <div className="min-h-screen bg-[#050505] text-[#FAFAFA] flex items-center justify-center px-4 py-10">
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute -top-24 right-0 h-72 w-72 rounded-full bg-blue-600/10 blur-3xl" />
        </div>
        <div className="relative w-full max-w-md rounded-2xl border border-[#27272A] bg-[#121212]/80 p-8 shadow-[0_0_80px_rgba(0,0,0,0.35)] backdrop-blur-md">
          <div className="mb-8 flex items-center gap-3">
            <div className="rounded-full border border-[#27272A] bg-[#161616] p-2">
              <Wallet className="h-5 w-5 text-[#3B82F6]" />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.3em] text-[#A1A1AA]">Backup</p>
              <h1 className="text-xl font-semibold tracking-tight text-[#FAFAFA]">Save your recovery phrase</h1>
            </div>
          </div>

          <div className="space-y-6">
            <div className="space-y-4">
              <p className="text-sm text-[#A1A1AA]">
                This is your 12-word recovery phrase. Write it down and store it securely. This is the only way to recover your wallet if you lose access to this device.
              </p>
              
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {mnemonicWords.map((word, index) => (
                  <div 
                    key={index} 
                    className="flex items-center gap-2 rounded-lg border border-[#27272A] bg-[#161616] px-3 py-2 text-sm text-[#FAFAFA]"
                  >
                    <span className="text-[#A1A1AA] text-xs font-medium w-5">{index + 1}.</span>
                    <span>{word}</span>
                  </div>
                ))}
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={copyMnemonic}
                  className="flex items-center gap-2 rounded-full border border-[#27272A] bg-[#161616] px-4 py-2 text-sm text-[#FAFAFA] transition hover:border-[#3B82F6]"
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
                  className="mt-1 h-4 w-4 rounded border-[#27272A] bg-[#0a0a0a] text-[#3B82F6] focus:ring-[#3B82F6] focus:ring-offset-0"
                />
                <label htmlFor="confirmMnemonic" className="text-sm text-[#A1A1AA]">
                  I have saved my recovery phrase somewhere safe.
                </label>
              </div>

              <button
                type="button"
                onClick={handleConfirmMnemonicSave}
                disabled={!hasConfirmedMnemonicSave}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-[#3B82F6] px-4 py-3 font-medium text-white transition hover:bg-[#2563EB] disabled:opacity-70"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Migration screen - shown when legacy plaintext key exists
  if (isMigrating) {
    return (
      <div className="min-h-screen bg-[#050505] text-[#FAFAFA] flex items-center justify-center px-4 py-10">
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute -top-24 right-0 h-72 w-72 rounded-full bg-blue-600/10 blur-3xl" />
        </div>
        <div className="relative w-full max-w-md rounded-2xl border border-[#27272A] bg-[#121212]/80 p-8 shadow-[0_0_80px_rgba(0,0,0,0.35)] backdrop-blur-md">
          <div className="mb-8 flex items-center gap-3">
            <div className="rounded-full border border-[#27272A] bg-[#161616] p-2">
              <Lock className="h-5 w-5 text-[#3B82F6]" />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.3em] text-[#A1A1AA]">Security Upgrade</p>
              <h1 className="text-xl font-semibold tracking-tight text-[#FAFAFA]">Secure Your Wallet</h1>
            </div>
          </div>

          <div className="space-y-6">
            <p className="text-sm text-[#A1A1AA]">
              For enhanced security, your wallet is now protected by a PIN.
              Please set a PIN to secure your wallet.
            </p>

            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-sm text-[#A1A1AA]">Create PIN (min 6 characters)</label>
                <PinInput
                  value={migrationPin}
                  onChange={setMigrationPin}
                  placeholder="Create PIN"
                  disabled={isProcessing}
                  error={migrationError}
                />
              </div>

              <div>
                <label className="mb-2 block text-sm text-[#A1A1AA]">Confirm PIN</label>
                <PinInput
                  value={migrationPinConfirm}
                  onChange={setMigrationPinConfirm}
                  placeholder="Confirm PIN"
                  disabled={isProcessing}
                  error={migrationError}
                />
              </div>

              {migrationError && <p className="text-sm text-red-400">{migrationError}</p>}
            </div>

            <button
              onClick={handleMigrate}
              disabled={isProcessing || migrationPin.length === 0 || migrationPinConfirm.length === 0}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-[#3B82F6] px-4 py-3 font-medium text-white transition hover:bg-[#2563EB] disabled:opacity-70"
            >
              {isProcessing ? (
                <>
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  Securing...
                </>
              ) : 'Secure Wallet'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Create PIN modal for new wallet creation/import
  if (showCreatePin) {
    return (
      <div className="min-h-screen bg-[#050505] text-[#FAFAFA] flex items-center justify-center px-4 py-10">
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute -top-24 right-0 h-72 w-72 rounded-full bg-blue-600/10 blur-3xl" />
        </div>
        <div className="relative w-full max-w-md rounded-2xl border border-[#27272A] bg-[#121212]/80 p-8 shadow-[0_0_80px_rgba(0,0,0,0.35)] backdrop-blur-md">
          <div className="mb-8 flex items-center gap-3">
            <div className="rounded-full border border-[#27272A] bg-[#161616] p-2">
              <Lock className="h-5 w-5 text-[#3B82F6]" />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.3em] text-[#A1A1AA]">Security</p>
              <h1 className="text-xl font-semibold tracking-tight text-[#FAFAFA]">Set PIN</h1>
            </div>
          </div>

          <div className="space-y-6">
            <p className="text-sm text-[#A1A1AA]">
              Create a PIN to protect your wallet. You will need this PIN to unlock your wallet on this device.
            </p>

            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-sm text-[#A1A1AA]">Create PIN (min 6 characters)</label>
                <PinInput
                  value={createPin}
                  onChange={setCreatePin}
                  placeholder="Create PIN"
                  disabled={isProcessing}
                  error={createPinError}
                />
              </div>

              <div>
                <label className="mb-2 block text-sm text-[#A1A1AA]">Confirm PIN</label>
                <PinInput
                  value={createPinConfirm}
                  onChange={setCreatePinConfirm}
                  placeholder="Confirm PIN"
                  disabled={isProcessing}
                  error={createPinError}
                />
              </div>

              {createPinError && <p className="text-sm text-red-400">{createPinError}</p>}
            </div>

            <button
              onClick={() => pendingWalletData ? finalizeImportWallet(createPin) : finalizeCreateWallet(createPin)}
              disabled={isProcessing || createPin.length === 0 || createPinConfirm.length === 0}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-[#3B82F6] px-4 py-3 font-medium text-white transition hover:bg-[#2563EB] disabled:opacity-70"
            >
              {isProcessing ? (
                <>
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  {pendingWalletData ? 'Importing...' : 'Creating...'}
                </>
              ) : pendingWalletData ? 'Import Wallet' : 'Create Wallet'}
            </button>

            <button
              onClick={() => {
                setShowCreatePin(false);
                setCreatePin('');
                setCreatePinConfirm('');
                setCreatePinError(null);
                setPendingWalletData(null);
                // Also clear mnemonic state if we're in the creation flow
                setPendingMnemonic(null);
                setShowMnemonicReveal(false);
                setError('Wallet creation cancelled');
              }}
              className="w-full text-sm text-[#A1A1AA] hover:text-[#FAFAFA]"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // No wallet - show create/import screen
  if (!wallet) {
    return (
      <div className="min-h-screen bg-[#050505] text-[#FAFAFA] flex items-center justify-center px-4 py-10">
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute -top-24 right-0 h-72 w-72 rounded-full bg-blue-600/10 blur-3xl" />
        </div>
        <div className="relative w-full max-w-md rounded-2xl border border-[#27272A] bg-[#121212]/80 p-8 shadow-[0_0_80px_rgba(0,0,0,0.35)] backdrop-blur-md">
          <div className="mb-8 flex items-center gap-3">
            <div className="rounded-full border border-[#27272A] bg-[#161616] p-2">
              <Wallet className="h-5 w-5 text-[#3B82F6]" />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.3em] text-[#A1A1AA]">Self-custodial</p>
              <h1 className="text-xl font-semibold tracking-tight">Arc Wallet</h1>
            </div>
          </div>

          <div className="mb-6 space-y-2">
            <h2 className="text-2xl font-semibold tracking-tight">Secure your Arc Testnet wallet</h2>
            <p className="text-sm text-[#A1A1AA]">Create a fresh wallet or import an existing one directly in your browser.</p>
          </div>

          <div className="space-y-3">
            <button
              onClick={handleCreateWallet}
              disabled={isLoading || isProcessing}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#3B82F6] px-4 py-3 font-medium text-white transition hover:bg-[#2563EB]"
            >
              <Download className="h-4 w-4" />
              {isLoading || isProcessing ? 'Preparing…' : 'Create New Wallet'}
            </button>

            <div className="rounded-xl border border-[#27272A] bg-[#161616]/70 p-4">
              <label className="mb-2 block text-[11px] uppercase tracking-[0.32em] text-[#A1A1AA]">Import wallet</label>
              <textarea
                value={importInput}
                onChange={(e) => setImportInput(e.target.value)}
                rows={4}
                placeholder="12-word seed phrase or 0x private key"
                className="w-full rounded-lg border border-[#27272A] bg-[#0a0a0a] px-3 py-2 text-sm text-[#FAFAFA] outline-none ring-0"
              />
              <button
                onClick={handleImportWallet}
                disabled={isLoading || isProcessing}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-[#27272A] bg-[#121212] px-4 py-3 text-sm font-medium text-[#FAFAFA] transition hover:border-[#3B82F6]"
              >
                <Upload className="h-4 w-4" />
                Import Wallet
              </button>
            </div>
          </div>

          {error ? <p className="mt-4 text-sm text-red-400">{error}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050505] text-[#FAFAFA] px-4 py-5 pb-28 sm:px-6 lg:px-8">
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 right-0 h-72 w-72 rounded-full bg-blue-600/10 blur-3xl" />
      </div>
      <div className="relative mx-auto flex max-w-md flex-col gap-4">
        <header className="flex items-center justify-between border-b border-[#27272A] pb-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[#27272A] bg-[#161616] p-1.5">
              <img src={logoUrl} alt="ArcPay" className="h-full w-full object-contain" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.32em] text-[#A1A1AA]">Arc Network</p>
              <h1 className="text-lg font-semibold tracking-tight">ArcPay</h1>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={copyAddress}
              className="flex items-center gap-2 rounded-full border border-[#27272A] bg-[#161616] px-3 py-2 text-xs text-[#FAFAFA]"
              aria-label="Copy wallet address"
            >
              <span className="font-mono">{address.slice(0, 6)}...{address.slice(-4)}</span>
              <Copy className="h-3.5 w-3.5 text-[#A1A1AA]" />
            </button>
            <button
              onClick={handleLock}
              className="rounded-full border border-[#27272A] bg-[#161616] p-2 text-[#A1A1AA] transition hover:text-[#FAFAFA]"
              aria-label="Lock wallet"
            >
              <Lock className="h-4 w-4" />
            </button>
          </div>
        </header>

        <section className="rounded-xl border border-[#27272A] bg-[#121212]/80 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] uppercase tracking-[0.28em] text-[#A1A1AA]">Portfolio value</p>
              <h2 className="mt-2 font-mono text-3xl font-semibold tracking-tight">${totalPortfolioValue} <span className="text-base font-medium text-[#A1A1AA]">USD</span></h2>
              <p className="mt-2 text-xs text-[#A1A1AA]">{ARC_NETWORK_NAME} · Chain ID {ARC_CHAIN_ID}</p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => void refreshWalletData()}
                className="flex items-center justify-center rounded-full border border-[#27272A] bg-[#161616] h-8 w-8"
                aria-label="Refresh"
              >
                <RefreshCcw className="h-4 w-4 text-[#A1A1AA]" />
              </button>
              <button
                onClick={() => setShowHistory(true)}
                className="flex items-center justify-center rounded-full border border-[#27272A] bg-[#161616] h-8 w-8"
                aria-label="History"
              >
                <Clock className="h-4 w-4 text-[#A1A1AA]" />
              </button>
            </div>
          </div>

          {showAssetBreakdown ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {visibleAssets.map((asset) => (
                <button
                  key={asset.key}
                  className="flex items-center gap-2 rounded-full border border-[#27272A] bg-[#161616] px-3 py-2 text-xs text-[#FAFAFA]"
                >
                  <img
                    src={ASSET_ICON_URLS[asset.symbol] ?? `https://cryptologos.cc/logos/${asset.symbol.toLowerCase()}-${asset.symbol.toLowerCase()}-logo.png`}
                    alt={`${asset.symbol} icon`}
                    className="h-5 w-5 rounded-full"
                    onError={(event) => {
                      event.currentTarget.style.display = 'none';
                    }}
                  />
                  <span>{asset.symbol}</span>
                  <span className="font-mono text-[#A1A1AA]">{asset.balance}</span>
                </button>
              ))}
            </div>
          ) : null}
        </section>

        <section className="rounded-xl border border-[#27272A] bg-[#121212]/80 p-4">
          <div className="mb-3 flex items-center justify-between border-b border-[#27272A] pb-3">
            <p className="text-[10px] uppercase tracking-[0.28em] text-[#A1A1AA]">Wallet actions</p>
          </div>
          <div className="flex flex-nowrap gap-1.5 overflow-x-auto">
            <button onClick={() => openSendModal()} className="flex shrink-0 items-center justify-center gap-1.5 rounded-full bg-[#3B82F6] px-3 py-2 text-sm font-medium text-white transition hover:scale-105 hover:bg-[#2563EB] active:scale-95">
              <Send className="h-3.5 w-3.5" />
              Send
            </button>
            <button onClick={() => setShowReceive(true)} className="flex shrink-0 items-center justify-center gap-1.5 rounded-full border border-[#27272A] bg-[#161616] px-3 py-2 text-sm font-medium text-[#FAFAFA] transition hover:border-[#3B82F6]">
              <Download className="h-3.5 w-3.5" />
              Receive
            </button>
            <button onClick={openRequestModal} className="flex shrink-0 items-center justify-center gap-1.5 rounded-full border border-[#27272A] bg-[#161616] px-3 py-2 text-sm font-medium text-[#FAFAFA] transition hover:border-[#3B82F6]">
              <QrCode className="h-3.5 w-3.5" />
              Request
            </button>
          </div>
        </section>

        <section className="rounded-xl border border-[#27272A] bg-[#121212]/80 p-4">
          <div className="mb-3 flex items-center justify-between border-b border-[#27272A] pb-3">
            <p className="text-[10px] uppercase tracking-[0.28em] text-[#A1A1AA]">Holdings</p>
            <span className="text-[11px] text-[#A1A1AA]">{visibleAssets.length} assets</span>
          </div>
          {visibleAssets.length > 0 ? (
            <div className="space-y-3">
              {visibleAssets.map((asset) => (
                <button
                  key={asset.key}
                  type="button"
                  onClick={() => setSelectedAssetDetail(asset.key)}
                  className="flex w-full items-center justify-between gap-3 border-b border-[#27272A] pb-3 last:border-b-0 last:pb-0 text-left transition hover:border-[#3B82F6]/40"
                >
                  <div className="flex items-center gap-3">
                    <img
                      src={ASSET_ICON_URLS[asset.symbol] ?? `https://cryptologos.cc/logos/${asset.symbol.toLowerCase()}-${asset.symbol.toLowerCase()}-logo.png`}
                      alt={`${asset.symbol} icon`}
                      className="h-9 w-9 rounded-full"
                      onError={(event) => {
                        event.currentTarget.style.display = 'none';
                        const fallback = document.createElement('div');
                        fallback.className = 'flex h-9 w-9 items-center justify-center rounded-full border border-[#3B82F6]/30 bg-[#3B82F6]/10 text-[11px] font-semibold text-[#93C5FD]';
                        fallback.textContent = asset.symbol.slice(0, 2).toUpperCase();
                        event.currentTarget.parentElement?.appendChild(fallback);
                      }}
                    />
                    <div>
                      <p className="text-sm font-medium text-[#FAFAFA]">{asset.symbol}</p>
                      <p className="text-xs text-[#A1A1AA]">Available balance</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <p className="font-mono text-sm font-semibold text-[#FAFAFA]">{asset.balance}</p>
                    <ChevronRight className="h-4 w-4 text-[#A1A1AA]" />
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[#A1A1AA]">No balances above zero yet.</p>
          )}
        </section>

        {copied ? <p className="text-center text-xs text-[#3B82F6]">Address copied</p> : null}
      </div>

      {selectedAssetDetail ? (() => {
        const detailAsset = visibleAssets.find((a) => a.key === selectedAssetDetail)
          ?? { key: selectedAssetDetail, symbol: 'TOKEN', balance: '0', decimals: 6 };
        const assetTransactions = transactions.filter((tx) => tx.tokenSymbol === detailAsset.symbol);
        const iconUrl = ASSET_ICON_URLS[detailAsset.symbol] ?? `https://cryptologos.cc/logos/${detailAsset.symbol.toLowerCase()}-${detailAsset.symbol.toLowerCase()}-logo.png`;

        return (
          <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 px-4">
            <div className="w-full max-w-2xl rounded-3xl border border-[#27272A] bg-[#121212] p-6 shadow-[0_0_80px_rgba(0,0,0,0.35)]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <img
                    src={iconUrl}
                    alt={`${detailAsset.symbol} icon`}
                    className="h-10 w-10 rounded-full"
                    onError={(event) => {
                      event.currentTarget.style.display = 'none';
                    }}
                  />
                  <div>
                    <h3 className="text-xl font-semibold">{detailAsset.symbol}</h3>
                    <p className="text-xs text-[#A1A1AA]">Available: {detailAsset.balance}</p>
                  </div>
                </div>
                <button onClick={() => setSelectedAssetDetail(null)} className="text-sm text-[#A1A1AA]">Close</button>
              </div>

              <div className="mt-5">
                <button
                  onClick={() => {
                    const assetKey = selectedAssetDetail;
                    setSelectedAssetDetail(null);
                    openSendModal({ presetAssetKey: assetKey });
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#3B82F6] px-4 py-3 text-sm font-medium text-white transition hover:bg-[#2563EB]"
                >
                  <Send className="h-4 w-4" />
                  Send {detailAsset.symbol}
                </button>
              </div>

              <div className="mt-5">
                <div className="mb-3 flex items-center justify-between border-b border-[#27272A] pb-2">
                  <p className="text-[11px] uppercase tracking-[0.28em] text-[#A1A1AA]">Activity</p>
                  <button onClick={() => void refreshTransactionHistory()} className="flex items-center gap-1.5 text-xs text-[#A1A1AA] transition hover:text-[#FAFAFA]">
                    <RefreshCcw className="h-3 w-3" />
                    Refresh
                  </button>
                </div>

                <div className="max-h-[360px] space-y-3 overflow-y-auto pr-1">
                  {isHistoryLoading && transactions.length === 0 ? (
                    Array.from({ length: 3 }).map((_, index) => (
                      <div key={index} className="flex items-center justify-between rounded-2xl border border-[#27272A] bg-[#161616] p-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#27272A]">
                            <LoaderCircle className="h-4 w-4 animate-spin text-[#A1A1AA]" />
                          </div>
                          <div className="space-y-2">
                            <div className="h-3 w-24 rounded-full bg-[#27272A]" />
                            <div className="h-2.5 w-36 rounded-full bg-[#27272A]" />
                          </div>
                        </div>
                        <div className="h-3 w-16 rounded-full bg-[#27272A]" />
                      </div>
                    ))
                  ) : null}

                  {!isHistoryLoading && assetTransactions.length === 0 ? (
                    <div className="rounded-2xl border border-[#27272A] bg-[#161616] p-6 text-center text-sm text-[#A1A1AA]">
                      No {detailAsset.symbol} transactions yet.
                    </div>
                  ) : null}

                  {assetTransactions.map((transaction) => {
                    const counterparty = transaction.direction === 'sent' ? transaction.to : transaction.from;
                    const tokenDisplay = formatDisplayBalance(transaction.value);
                    const statusDisplay = STATUS_DISPLAY[transaction.status] ?? STATUS_DISPLAY.pending;
                    const directionIcon = transaction.direction === 'received' ? (
                      <ArrowDownLeft className="h-4 w-4 text-emerald-400" />
                    ) : (
                      <ArrowUpRight className="h-4 w-4 text-red-400" />
                    );

                    return (
                      <button
                        key={transaction.hash}
                        onClick={() => window.open(`${EXPLORER_URL}/tx/${transaction.hash}`, '_blank', 'noopener,noreferrer')}
                        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-[#27272A] bg-[#161616] p-4 text-left transition hover:border-[#3B82F6]"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[#27272A] bg-[#121212]">
                            {directionIcon}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-[#FAFAFA]">{transaction.direction === 'received' ? 'Received' : 'Sent'}</p>
                            <p className="text-xs text-[#A1A1AA]">{truncateAddress(counterparty)}</p>
                            <p className="mt-1 text-[11px] text-[#A1A1AA]">{formatTimestamp(transaction.timestamp)}</p>
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          <p className="text-sm font-semibold text-[#FAFAFA]">
                            {transaction.direction === 'received' ? '+' : '-'}{tokenDisplay} {transaction.tokenSymbol}
                          </p>
                          <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.24em] ${statusDisplay.className}`}>
                            {statusDisplay.label}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        );
      })() : null}

      {showHistory ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-2xl rounded-3xl border border-[#27272A] bg-[#121212] p-6 shadow-[0_0_80px_rgba(0,0,0,0.35)]">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">Transaction History</h3>
              <div className="flex items-center gap-2">
                <button onClick={() => void refreshTransactionHistory()} className="flex items-center gap-2 rounded-full border border-[#27272A] bg-[#161616] px-3 py-2 text-xs text-[#FAFAFA]">
                  <RefreshCcw className="h-3.5 w-3.5" />
                  Refresh
                </button>
                <button onClick={() => setShowHistory(false)} className="text-sm text-[#A1A1AA]">Close</button>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              {isHistoryLoading ? (
                Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="flex items-center justify-between rounded-2xl border border-[#27272A] bg-[#161616] p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#27272A]">
                        <LoaderCircle className="h-4 w-4 animate-spin text-[#A1A1AA]" />
                      </div>
                      <div className="space-y-2">
                        <div className="h-3 w-24 rounded-full bg-[#27272A]" />
                        <div className="h-2.5 w-36 rounded-full bg-[#27272A]" />
                      </div>
                    </div>
                    <div className="h-3 w-16 rounded-full bg-[#27272A]" />
                  </div>
                ))
              ) : null}

              {!isHistoryLoading && historyError ? (
                <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">{historyError}</div>
              ) : null}

              {!isHistoryLoading && !historyError && transactions.length === 0 ? (
                <div className="rounded-2xl border border-[#27272A] bg-[#161616] p-6 text-sm text-[#A1A1AA]">No transactions yet.</div>
              ) : null}

              {!isHistoryLoading && !historyError && transactions.length > 0 ? (
                <div className="max-h-[420px] space-y-3 overflow-y-auto pr-1">
                  {transactions.map((transaction) => {
                    const counterparty = transaction.direction === 'sent' ? transaction.to : transaction.from;
                    const tokenDisplay = formatDisplayBalance(transaction.value);
                    const statusDisplay = STATUS_DISPLAY[transaction.status] ?? STATUS_DISPLAY.pending;
                    const directionIcon = transaction.direction === 'received' ? (
                      <ArrowDownLeft className="h-4 w-4 text-emerald-400" />
                    ) : (
                      <ArrowUpRight className="h-4 w-4 text-red-400" />
                    );

                    return (
                      <button
                        key={transaction.hash}
                        onClick={() => window.open(`${EXPLORER_URL}/tx/${transaction.hash}`, '_blank', 'noopener,noreferrer')}
                        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-[#27272A] bg-[#161616] p-4 text-left transition hover:border-[#3B82F6]"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[#27272A] bg-[#121212]">
                            {directionIcon}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-[#FAFAFA]">{transaction.direction === 'received' ? 'Received' : 'Sent'}</p>
                            <p className="text-xs text-[#A1A1AA]">{truncateAddress(counterparty)}</p>
                            <p className="mt-1 text-[11px] text-[#A1A1AA]">{formatTimestamp(transaction.timestamp)}</p>
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          <p className="text-sm font-semibold text-[#FAFAFA]">
                            {transaction.direction === 'received' ? '+' : '-'}{tokenDisplay} {transaction.tokenSymbol}
                          </p>
                          <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.24em] ${statusDisplay.className}`}>
                            {statusDisplay.label}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {showSettings ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-3xl border border-[#27272A] bg-[#121212] p-6 shadow-[0_0_80px_rgba(0,0,0,0.35)]">
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
                className="flex w-full items-center justify-between rounded-2xl border border-[#27272A] bg-[#161616] px-4 py-3 text-left text-[#FAFAFA] transition hover:border-[#3B82F6]"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[#27272A] bg-[#121212]">
                    <Users className="h-4 w-4 text-[#93C5FD]" />
                  </div>
                  <span className="text-sm font-medium">Manage Contacts</span>
                </div>
                <ChevronRight className="h-4 w-4 text-[#A1A1AA]" />
              </button>
              
              <div className="pt-4 border-t border-[#27272A]">
                <p className="text-[11px] uppercase tracking-[0.28em] text-red-400 mb-3">Danger Zone</p>
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
                          removeKeystoreFromStorage();
                          localStorage.removeItem(STORAGE_KEY_LEGACY);
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
                          setIsUnlocking(false);
                          setIsMigrating(false);
                        }}
                        className="flex-1 rounded-2xl bg-red-500 px-4 py-3 text-sm font-medium text-white transition hover:bg-red-600"
                      >
                        Yes, remove wallet
                      </button>
                      <button
                        onClick={() => setConfirmRemoval(false)}
                        className="flex-1 rounded-2xl border border-[#27272A] bg-[#161616] px-4 py-3 text-sm font-medium text-[#FAFAFA] transition hover:border-[#3B82F6]"
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
          <div className="w-full max-w-md rounded-3xl border border-[#27272A] bg-[#121212] p-6 shadow-[0_0_80px_rgba(0,0,0,0.35)]">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">Receive</h3>
              <button onClick={() => setShowReceive(false)} className="text-sm text-[#A1A1AA]">Close</button>
            </div>
            <div className="mt-6 flex flex-col items-center gap-4">
              <div className="rounded-2xl border border-[#27272A] bg-[#161616] p-4">
                <QRCodeSVG value={address} size={180} includeMargin bgColor="#161616" fgColor="#FAFAFA" />
              </div>
              <p className="break-all text-center font-mono text-sm text-[#A1A1AA]">{address}</p>
              <button onClick={copyAddress} className="flex items-center gap-2 rounded-full border border-[#27272A] bg-[#161616] px-4 py-2 text-sm text-[#FAFAFA]">
                <Copy className="h-4 w-4" />
                Copy address
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showRequest ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-3xl border border-[#27272A] bg-[#121212] p-6 shadow-[0_0_80px_rgba(0,0,0,0.35)]">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">Request</h3>
              <button onClick={() => {
                setShowRequest(false);
                setRequestAssetKey('usdc');
                setRequestAmount('');
                setRequestNote('');
                setRequestAmountError('');
              }} className="text-sm text-[#A1A1AA]">Close</button>
            </div>
            <div className="mt-6 space-y-4">
              <label className="block text-sm text-[#A1A1AA]">
                Asset
                <select
                  value={requestAssetKey}
                  onChange={(e) => {
                    setRequestAssetKey(e.target.value);
                    setRequestAmountError('');
                  }}
                  className="mt-2 w-full rounded-xl border border-[#27272A] bg-[#0a0a0a] px-3 py-3 text-sm text-[#FAFAFA] outline-none"
                >
                  {requestAssets.map((asset) => (
                    <option key={asset.key} value={asset.key}>
                      {asset.symbol}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-sm text-[#A1A1AA]">
                Amount
                <div className="mt-2 flex items-center gap-2 rounded-xl border border-[#27272A] bg-[#0a0a0a] px-3 py-3">
                  <input
                    value={requestAmount}
                    onChange={(e) => {
                      setRequestAmount(e.target.value);
                      validateRequestAmount(e.target.value);
                    }}
                    className="w-full bg-transparent text-sm text-[#FAFAFA] outline-none"
                    placeholder="12.50"
                  />
                  <span className="text-[11px] text-[#A1A1AA]">{selectedRequestAsset.symbol}</span>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-[#A1A1AA]">
                  <span>Precision: {selectedRequestAssetDecimals}</span>
                  <span>Default: {selectedRequestAsset.symbol}</span>
                </div>
                {requestAmountError ? <p className="mt-2 text-xs text-red-400">{requestAmountError}</p> : null}
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
                  className="mt-2 w-full rounded-xl border border-[#27272A] bg-[#0a0a0a] px-3 py-3 text-sm text-[#FAFAFA] outline-none"
                  placeholder="Dinner split"
                />
                <div className="mt-2 text-right text-[11px] text-[#A1A1AA]">{requestNote.length}/140</div>
              </label>

              {requestLink ? (
                <div className="space-y-3 rounded-2xl border border-[#27272A] bg-[#161616] p-4">
                  <div className="flex flex-col items-center gap-4">
                    <div className="rounded-2xl border border-[#27272A] bg-[#161616] p-4">
                      <QRCodeSVG value={requestLink} size={180} includeMargin bgColor="#161616" fgColor="#FAFAFA" />
                    </div>
                    <label className="w-full text-sm text-[#A1A1AA]">
                      Deep link
                      <input
                        readOnly
                        value={requestLink}
                        className="mt-2 w-full rounded-xl border border-[#27272A] bg-[#0a0a0a] px-3 py-3 text-sm text-[#FAFAFA] outline-none"
                      />
                    </label>
                    <button
                      onClick={async () => {
                        if (!requestLink) return;
                        await navigator.clipboard.writeText(requestLink);
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1300);
                      }}
                      className="flex items-center gap-2 rounded-full border border-[#27272A] bg-[#161616] px-4 py-2 text-sm text-[#FAFAFA]"
                    >
                      <Copy className="h-4 w-4" />
                      Copy request link
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-[#27272A] bg-[#161616] p-4 text-sm text-[#A1A1AA]">
                  Enter a valid positive amount to generate a shareable request QR code and deep link.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {showScanner ? (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-3xl border border-[#27272A] bg-[#121212] p-5 shadow-[0_0_80px_rgba(0,0,0,0.35)]">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xl font-semibold">Scan QR</h3>
                <p className="text-xs text-[#A1A1AA]">Point your camera at an ArcPay deep link.</p>
              </div>
              <button onClick={() => setShowScanner(false)} className="text-sm text-[#A1A1AA]">Close</button>
            </div>

            <div className="mt-4 overflow-hidden rounded-2xl border border-[#27272A] bg-[#0a0a0a]">
              <div className="relative aspect-[4/5] w-full bg-black">
                <video ref={videoRef} className="h-full w-full object-cover" playsInline muted autoPlay />
                <div className="pointer-events-none absolute inset-4 rounded-3xl border-2 border-[#3B82F6]/80" />
                <div className="pointer-events-none absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-white/20" />
                {scannerSuccess ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-[#3B82F6]/10 backdrop-blur-[1px]">
                    <div className="rounded-full border border-[#3B82F6]/40 bg-[#121212]/80 px-4 py-2 text-sm font-medium text-[#93C5FD]">
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
          <div className="w-full max-w-md rounded-3xl border border-[#27272A] bg-[#121212] p-6 shadow-[0_0_80px_rgba(0,0,0,0.35)]">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">Contacts</h3>
              <button onClick={() => setShowContacts(false)} className="text-sm text-[#A1A1AA]">Close</button>
            </div>

            <div className="mt-5 space-y-4">
              <div className="rounded-2xl border border-[#27272A] bg-[#161616] p-4">
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
                    className="w-full rounded-xl border border-[#27272A] bg-[#0a0a0a] px-3 py-2.5 text-sm text-[#FAFAFA] outline-none"
                    placeholder="0x... or name.arc"
                  />
                  <input
                    value={addContactLabel}
                    onChange={(e) => setAddContactLabel(e.target.value.trimStart())}
                    className="w-full rounded-xl border border-[#27272A] bg-[#0a0a0a] px-3 py-2.5 text-sm text-[#FAFAFA] outline-none"
                    placeholder="Label (optional)"
                  />

                  <div className="flex items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => void handleAddContact()}
                      disabled={!addContactInput.trim() || addContactStatus === 'resolving'}
                      className="rounded-xl bg-[#3B82F6] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#2563EB] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Add
                    </button>
                    {addContactStatus === 'resolving' ? (
                      <div className="inline-flex items-center gap-2 rounded-full border border-[#3B82F6]/30 bg-[#0a0a0a] px-3 py-1 text-[11px] text-[#93C5FD]">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-[#3B82F6]" />
                        Resolving…
                      </div>
                    ) : null}
                  </div>

                  {addContactError ? <p className="text-xs text-red-400">{addContactError}</p> : null}
                </div>
              </div>

              {contacts.length === 0 ? (
                <div className="rounded-2xl border border-[#27272A] bg-[#161616] p-4 text-sm text-[#A1A1AA]">
                  No saved contacts yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {contacts.map((contact) => (
                    <div key={contact.id} className="flex items-center justify-between gap-3 rounded-2xl border border-[#27272A] bg-[#161616] p-3">
                      <button
                        type="button"
                        onClick={() => {
                          setSendAddress(contact.address);
                          setResolvedSendAddress(contact.address);
                          setRecipientCheckMessage(null);
                          setRecipientResolutionStatus('idle');
                          validateSendRecipient(contact.address);
                          setShowContacts(false);
                        }}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#3B82F6]/15 text-[11px] font-semibold text-[#93C5FD]">
                          {formatContactLabel(contact)
                            .split(/\s+/)
                            .filter(Boolean)
                            .slice(0, 2)
                            .map((part) => part[0]?.toUpperCase() ?? '')
                            .join('') || contact.address.slice(2, 4).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-[#FAFAFA]">{formatContactLabel(contact)}</p>
                          <p className="truncate text-xs text-[#A1A1AA]">{contact.address}</p>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const nextContacts = removeContact(contact.address);
                          setContacts(nextContacts);
                        }}
                        className="flex h-8 w-8 items-center justify-center rounded-full border border-[#27272A] bg-[#0a0a0a] text-[#A1A1AA] transition hover:border-red-500/50 hover:text-red-300"
                        aria-label={`Delete ${formatContactLabel(contact)}`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {showSend ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-3xl border border-[#27272A] bg-[#121212] p-6 shadow-[0_0_80px_rgba(0,0,0,0.35)]">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">Send</h3>
              <button onClick={() => {
                setShowSend(false);
                setShowContacts(false);
                setShowContactLabelInput(false);
                setContactLabelDraft('');
                setSendReview(false);
                setSendAmount('');
                setSendAddress('');
                setSendAmountError('');
                setSendRecipientError('');
                setRecipientCheckMessage(null);
                setRecipientResolutionStatus('idle');
                setResolvedSendAddress(null);
                setScannedRequestNote('');
                setIsResolvingArcName(false);
              }} className="text-sm text-[#A1A1AA]">Close</button>
            </div>
            <div className="mt-6 space-y-4">
              {sendReview ? (
                <div className="space-y-4">
                  <div className="rounded-2xl border border-[#27272A] bg-[#161616] p-4">
                    <div className="flex items-center justify-between text-sm text-[#A1A1AA]">
                      <span>Asset</span>
                      <span className="text-[#FAFAFA]">{selectedSendAsset.symbol}</span>
                    </div>
                    <div className="mt-3 flex items-center justify-between text-sm text-[#A1A1AA]">
                      <span>Amount</span>
                      <span className="text-[#FAFAFA]">{sendAmount} {selectedSendAsset.symbol}</span>
                    </div>
                    <div className="mt-3 flex items-center justify-between text-sm text-[#A1A1AA]">
                      <span>Recipient</span>
                      <span className="break-all text-right text-[#FAFAFA]">{sendTarget}</span>
                    </div>
                    {isResolvingArcName ? (
                      <div className="mt-3 rounded-xl border border-[#3B82F6]/30 bg-[#0a0a0a] p-3 text-sm text-[#93C5FD]">
                        Resolving ArcName handle…
                      </div>
                    ) : null}
                  </div>

                  <button
                    onClick={() => void handleSend()}
                    disabled={txState === 'pending' || isResolvingArcName}
                    className="w-full rounded-2xl bg-[#3B82F6] px-4 py-3 font-medium text-white transition hover:bg-[#2563EB] disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {txState === 'pending' ? 'Sending…' : 'Send Now'}
                  </button>
                </div>
              ) : (
                <>
                  <label className="block text-sm text-[#A1A1AA]">
                    Asset
                    <select
                      value={sendAssetKey}
                      onChange={(e) => {
                        setSendAssetKey(e.target.value);
                        setSendAmountError('');
                      }}
                      className="mt-2 w-full rounded-xl border border-[#27272A] bg-[#0a0a0a] px-3 py-3 text-sm text-[#FAFAFA] outline-none"
                    >
                      {sendAssets.map((asset) => (
                        <option key={asset.key} value={asset.key}>
                          {asset.symbol}
                        </option>
                      ))}
                    </select>
                  </label>

                  {scannedRequestNote ? (
                    <div className="rounded-2xl border border-[#3B82F6]/30 bg-[#0a0a0a] p-3 text-sm text-[#93C5FD]">
                      <p className="text-[11px] uppercase tracking-[0.28em] text-[#A1A1AA]">Requested</p>
                      <p className="mt-2 break-words text-[#FAFAFA]">{scannedRequestNote}</p>
                    </div>
                  ) : null}

                  <label className="block text-sm text-[#A1A1AA]">
                    <span className="mb-2 block">Recipient address or ArcName</span>

                    {contacts.length > 0 ? (
                      <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                        {contacts.map((contact) => {
                          const initials = formatContactLabel(contact)
                            .split(/\s+/)
                            .filter(Boolean)
                            .slice(0, 2)
                            .map((part) => part[0]?.toUpperCase() ?? '')
                            .join('') || contact.address.slice(2, 4).toUpperCase();

                          return (
                            <button
                              key={contact.id}
                              type="button"
                              onClick={() => {
                                setSendAddress(contact.address);
                                setResolvedSendAddress(contact.address);
                                setRecipientCheckMessage(null);
                                setRecipientResolutionStatus('idle');
                                validateSendRecipient(contact.address);
                              }}
                              className="inline-flex shrink-0 items-center gap-2 rounded-full border border-[#27272A] bg-[#161616] px-2.5 py-1.5 text-left text-[#FAFAFA] transition hover:border-[#3B82F6]"
                            >
                              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#3B82F6]/15 text-[10px] font-semibold text-[#93C5FD]">
                                {initials}
                              </span>
                              <span className="max-w-[9rem] truncate text-xs">{formatContactLabel(contact)}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}

                    <div className="relative mt-2">
                      <div className={`flex items-center gap-2 rounded-xl border bg-[#0a0a0a] px-3 py-2 ${sendRecipientError ? 'border-red-500' : 'border-[#27272A]'}`}>
                        <input
                          value={sendAddress}
                          onChange={(e) => {
                            setSendAddress(e.target.value);
                            setResolvedSendAddress(null);
                            setRecipientCheckMessage(null);
                            setRecipientResolutionStatus('idle');
                            setShowContactLabelInput(false);
                            setContactLabelDraft('');
                            setShowContactPicker(false);
                            validateSendRecipient(e.target.value);
                          }}
                          className="w-full bg-transparent text-sm text-[#FAFAFA] outline-none"
                          placeholder="0x... or name.arc"
                        />
                        <button
                          type="button"
                          onClick={() => setShowContactPicker((current) => !current)}
                          className="flex h-7 w-7 items-center justify-center rounded-full border border-[#27272A] bg-[#121212] text-[#A1A1AA] transition hover:border-[#3B82F6] hover:text-[#FAFAFA]"
                          aria-label="Open contacts"
                        >
                          <Users className="h-4 w-4" />
                        </button>
                        {recipientResolutionStatus === 'resolved' ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                        ) : null}
                        {recipientResolutionStatus === 'idle' && getContactTargetAddress() ? (
                          <button
                            type="button"
                            onClick={() => setShowContactLabelInput((current) => !current)}
                            className="rounded-full border border-[#27272A] bg-[#121212] px-2.5 py-1 text-[11px] font-medium text-[#FAFAFA] transition hover:border-[#3B82F6]"
                          >
                            Save
                          </button>
                        ) : null}
                        {looksLikeArcNameHandle(sendAddress) && recipientResolutionStatus !== 'resolved' ? (
                          <button
                            type="button"
                            onClick={() => void handleCheckArcName()}
                            disabled={isResolvingArcName || recipientResolutionStatus === 'checking'}
                            className="rounded-full border border-[#3B82F6]/40 bg-[#121212] px-2.5 py-1 text-[11px] font-medium text-[#93C5FD] transition hover:border-[#3B82F6] disabled:cursor-not-allowed disabled:opacity-70"
                          >
                            {recipientResolutionStatus === 'checking' ? 'Checking…' : 'Check'}
                          </button>
                        ) : null}
                      </div>

                      {showContactPicker ? (
                        <div className="mt-2 rounded-2xl border border-[#27272A] bg-[#121212] p-2 shadow-[0_0_30px_rgba(0,0,0,0.25)]">
                          {contacts.length === 0 ? (
                            <div className="rounded-xl border border-[#27272A] bg-[#161616] px-3 py-3 text-xs text-[#A1A1AA]">
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
                                    setRecipientCheckMessage(null);
                                    setRecipientResolutionStatus('idle');
                                    setShowContactPicker(false);
                                    validateSendRecipient(contact.address);
                                  }}
                                  className="flex w-full items-center gap-2 rounded-xl border border-[#27272A] bg-[#161616] px-3 py-2 text-left transition hover:border-[#3B82F6]"
                                >
                                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#3B82F6]/15 text-[10px] font-semibold text-[#93C5FD]">
                                    {formatContactLabel(contact)
                                      .split(/\s+/)
                                      .filter(Boolean)
                                      .slice(0, 2)
                                      .map((part) => part[0]?.toUpperCase() ?? '')
                                      .join('') || contact.address.slice(2, 4).toUpperCase()}
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-xs font-medium text-[#FAFAFA]">{formatContactLabel(contact)}</p>
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
                          className="w-full rounded-xl border border-[#27272A] bg-[#0a0a0a] px-3 py-2 text-sm text-[#FAFAFA] outline-none"
                          placeholder="Optional label"
                        />
                        <button
                          type="button"
                          onClick={handleSaveCurrentContact}
                          className="rounded-xl bg-[#3B82F6] px-3 py-2 text-xs font-medium text-white"
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

                    {sendRecipientError ? <p className="mt-2 text-xs text-red-400">{sendRecipientError}</p> : null}
                    {recipientResolutionStatus === 'resolved' && resolvedSendAddress ? (
                      <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald-400">
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
                      <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-[#3B82F6]/30 bg-[#0a0a0a] px-3 py-1 text-[11px] text-[#93C5FD]">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-[#3B82F6]" />
                        Resolving ArcName handle…
                      </div>
                    ) : null}
                  </label>

                  <label className="block text-sm text-[#A1A1AA]">
                    Amount
                    <div className="mt-2 flex items-center gap-2 rounded-xl border border-[#27272A] bg-[#0a0a0a] px-3 py-3">
                      <input
                        value={sendAmount}
                        onChange={(e) => {
                          setSendAmount(e.target.value);
                          validateSendAmount(e.target.value);
                        }}
                        className="w-full bg-transparent text-sm text-[#FAFAFA] outline-none"
                        placeholder="0.10"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setSendAmount(selectedSendAsset.balance);
                          setSendAmountError('');
                        }}
                        disabled={txState === 'pending'}
                        className="rounded-full border border-[#27272A] px-2 py-1 text-[11px] text-[#A1A1AA]"
                      >
                        Max
                      </button>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-[#A1A1AA]">
                      <span>Available: {formatDisplayBalance(selectedSendAsset.balance)} {selectedSendAsset.symbol}</span>
                      <span>Decimals: {selectedSendAssetDecimals}</span>
                    </div>
                    {sendAmountError ? <p className="mt-2 text-xs text-red-400">{sendAmountError}</p> : null}
                  </label>

                  <button
                    onClick={() => void handleSendReview()}
                    disabled={txState === 'pending' || isResolvingArcName}
                    className="w-full rounded-2xl bg-[#3B82F6] px-4 py-3 font-medium text-white transition hover:bg-[#2563EB] disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {txState === 'pending' ? 'Confirming…' : 'Confirm payment'}
                  </button>
                </>
              )}

              {txState === 'confirming' && txHash ? (
                <div className="rounded-2xl border border-[#3B82F6]/40 bg-[#3B82F6]/10 p-3 text-sm text-[#93C5FD]">
                  <div className="flex items-center gap-2">
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    <p>{txConfirmationTimedOut ? 'Still confirming — check the explorer' : 'Confirming on-chain…'}</p>
                  </div>
                  <a href={`${EXPLORER_URL}/tx/${txHash}`} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-2 text-[#93C5FD]">
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

      {/* Bottom bar */}
      <div className="fixed bottom-0 left-0 right-0 z-10 h-20 border-t border-[#27272A] bg-[#0A0A0A] backdrop-blur-md">
        <div className="relative mx-auto h-full max-w-md">
          <div className="absolute left-1/2 top-0 flex -translate-x-1/2 items-center justify-between px-4 pt-3 w-64">
            <button
              onClick={() => setShowContacts(true)}
              className="h-10 w-10 rounded-full bg-[#161616] border border-[#27272A] text-[#FAFAFA] flex items-center justify-center"
              aria-label="Contacts"
            >
              <Users className="h-5 w-5" />
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="h-10 w-10 rounded-full bg-[#161616] border border-[#27272A] text-[#FAFAFA] flex items-center justify-center"
              aria-label="Settings"
            >
              <Settings className="h-5 w-5" />
            </button>
          </div>
          <button
            onClick={() => setShowScanner(true)}
            aria-label="Scan QR code"
            className="absolute -top-8 left-1/2 flex h-16 w-16 -translate-x-1/2 flex-col items-center justify-center gap-0.5 rounded-full border-4 border-[#050505] bg-[#3B82F6] text-white shadow-glow transition hover:scale-105 hover:bg-[#2563EB] active:scale-95"
          >
            <ScanLine className="h-5 w-5" />
            <span className="text-[9px] font-medium">Scan</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;