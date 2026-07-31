import { useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { ChevronDown, ChevronUp, Copy, ExternalLink, Lock, RefreshCcw, Send, Wallet, Download, Upload } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { filterNonZeroAssetBalances, formatDisplayBalance, formatTokenBalance } from './balance';
import { resolveArcName } from './utils/arcName';

const STORAGE_KEY = 'arc_wallet_pk';
const ARC_RPC_URL = 'https://5042002.rpc.thirdweb.com';
const ARC_CHAIN_ID = 5042002;
const ARC_NETWORK_NAME = 'Arc Testnet';
const ARC_CURRENCY_SYMBOL = 'USDC';
const EXPLORER_URL = 'https://testnet.arcscan.app';
const ARC_EXPLORER_API_URL = 'https://testnet.arcscan.app/api/v2';
const ASSET_ICON_URLS: Record<string, string> = {
  USDC: 'https://cryptologos.cc/logos/usd-coin-usdc-logo.png',
  EURC: 'https://orbmarkets.io/api/icons/euroCoin.png',
};

const isValidPrivateKey = (input: string) => {
  const normalized = input.trim();
  if (!normalized) return false;
  if (/^0x[0-9a-fA-F]{64}$/.test(normalized)) return true;
  const parts = normalized.split(/\s+/);
  return parts.length === 12 && parts.every((part) => part.length > 0);
};

type ArcWallet = ethers.Wallet | ethers.HDNodeWallet;

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

function App() {
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [wallet, setWallet] = useState<ArcWallet | null>(null);
  const [balance, setBalance] = useState<string>('0');
  const [isLoading, setIsLoading] = useState(false);
  const [importInput, setImportInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showReceive, setShowReceive] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [sendAddress, setSendAddress] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [sendAssetKey, setSendAssetKey] = useState('usdc');
  const [sendReview, setSendReview] = useState(false);
  const [sendRecipientError, setSendRecipientError] = useState('');
  const [sendAmountError, setSendAmountError] = useState('');
  const [txState, setTxState] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [assetBalances, setAssetBalances] = useState<Array<{ key: string; symbol: string; balance: string; decimals: number }>>([
    { key: 'usdc', symbol: 'USDC', balance, decimals: 6 },
  ]);
  const [tokenAssets, setTokenAssets] = useState<Array<{ key: string; symbol: string; balance: string; decimals: number }>>([]);
  const [showAssetBreakdown, setShowAssetBreakdown] = useState(false);
  const [resolvedSendAddress, setResolvedSendAddress] = useState<string | null>(null);
  const [isResolvingArcName, setIsResolvingArcName] = useState(false);

  const provider = useMemo(() => new ethers.JsonRpcProvider(ARC_RPC_URL), []);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const parsed = new ethers.Wallet(stored, provider);
        setPrivateKey(stored);
        setWallet(parsed);
        void refreshBalance(parsed);
      } catch {
        localStorage.removeItem(STORAGE_KEY);
        setPrivateKey(null);
        setWallet(null);
      }
    }
  }, [provider]);

  const refreshBalance = async (currentWallet?: ArcWallet | null) => {
    const targetWallet = currentWallet ?? wallet;
    if (!targetWallet) return;
    setIsLoading(true);
    setError(null);
    try {
      const address = targetWallet.address;
      const explorerResponse = await fetch(`${ARC_EXPLORER_API_URL}/addresses/${address}/token-balances`);
      if (!explorerResponse.ok) {
        throw new Error('Unable to fetch token balances from Arc explorer.');
      }
      const tokens = (await explorerResponse.json()) as Array<{
        token?: { symbol?: string; name?: string; decimals?: string; address_hash?: string };
        value?: string;
      }>;

      const normalizedAssets = tokens
        .filter((token) => token.token?.symbol && token.value)
        .map((token) => {
          const decimals = Number(token.token?.decimals ?? 18);
          const normalizedBalance = formatTokenBalance(BigInt(token.value ?? '0'), Number.isFinite(decimals) ? decimals : 18);
          const symbol = token.token?.symbol ?? 'TOKEN';
          return {
            key: token.token?.address_hash ?? symbol,
            symbol,
            balance: normalizedBalance,
            decimals: Number.isFinite(decimals) ? decimals : 18,
          };
        })
        .filter((asset) => Number(asset.balance) > 0);

      const usdcAsset = normalizedAssets.find((asset) => asset.symbol === 'USDC');
      if (usdcAsset) {
        setBalance(usdcAsset.balance);
      } else {
        setBalance('0');
      }
      setTokenAssets(normalizedAssets);
      setAssetBalances(
        normalizedAssets.length > 0
          ? normalizedAssets
          : [{ key: 'usdc', symbol: 'USDC', balance: usdcAsset?.balance ?? '0', decimals: 6 }],
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to fetch balance.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateWallet = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const created = ethers.Wallet.createRandom().connect(provider);
      const privateKeyValue = created.privateKey;
      localStorage.setItem(STORAGE_KEY, privateKeyValue);
      setPrivateKey(privateKeyValue);
      setWallet(created);
      setImportInput('');
      void refreshBalance(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wallet creation failed.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleImportWallet = async () => {
    try {
      setIsLoading(true);
      setError(null);
      if (!isValidPrivateKey(importInput)) {
        throw new Error('Enter a valid 12-word seed phrase or a raw private key.');
      }
      const imported = parseWalletInput(importInput).connect(provider);
      const privateKeyValue = imported.privateKey;
      localStorage.setItem(STORAGE_KEY, privateKeyValue);
      setPrivateKey(privateKeyValue);
      setWallet(imported);
      setImportInput('');
      void refreshBalance(imported);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wallet import failed.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLock = () => {
    localStorage.removeItem(STORAGE_KEY);
    setPrivateKey(null);
    setWallet(null);
    setBalance('0');
    setError(null);
    setShowReceive(false);
    setShowSend(false);
    setTxHash(null);
    setTxState('idle');
  };

  const openSendModal = () => {
    const defaultAsset = [
      ...tokenAssets,
      ...assetBalances,
    ].find((asset) => asset.symbol === 'USDC') ?? [
      ...tokenAssets,
      ...assetBalances,
    ].find((asset) => Number(asset.balance) > 0) ?? { key: 'usdc', symbol: 'USDC', balance: '0', decimals: 6 };

    setSendAssetKey(defaultAsset.key);
    setSendAddress('');
    setSendAmount('');
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

  const sendAssets = useMemo(() => {
    return filterNonZeroAssetBalances(tokenAssets.length > 0 ? tokenAssets : assetBalances);
  }, [assetBalances, tokenAssets]);

  const selectedSendAsset = useMemo(() => {
    return sendAssets.find((asset) => asset.key === sendAssetKey)
      ?? sendAssets.find((asset) => asset.symbol === 'USDC')
      ?? sendAssets[0]
      ?? { key: 'usdc', symbol: 'USDC', balance: '0', decimals: 6 };
  }, [sendAssetKey, sendAssets]);

  const selectedSendAssetDecimals = selectedSendAsset.decimals ?? 6;

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
      return false;
    }

    const looksLikeAddress = /^0x[a-fA-F0-9]{40}$/.test(input);
    const looksLikeArcName = input.toLowerCase().endsWith('.arc');

    if (looksLikeAddress) {
      const checksum = ethers.getAddress(input);
      setSendRecipientError('');
      setResolvedSendAddress(checksum);
      setIsResolvingArcName(false);
      return true;
    }

    if (looksLikeArcName) {
      setSendRecipientError('');
      setResolvedSendAddress(null);
      setIsResolvingArcName(false);
      return true;
    }

    setSendRecipientError('Enter a valid checksummed address or a handle ending in .arc.');
    setResolvedSendAddress(null);
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

  const handleSendReview = async () => {
    const recipientValid = validateSendRecipient(sendAddress);
    const amountValid = validateSendAmount(sendAmount);
    if (!recipientValid || !amountValid || !wallet) {
      return;
    }

    try {
      await resolveRecipientAddress(sendAddress);
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

    try {
      const resolvedRecipient = await resolveRecipientAddress(sendAddress);
      const value = ethers.parseUnits(sendAmount, selectedSendAssetDecimals);
      const tx = {
        to: resolvedRecipient,
        value,
      };
      const response = await wallet.sendTransaction(tx);
      setTxHash(response.hash);
      setTxState('success');
      setSendReview(false);
    } catch (err) {
      setTxState('error');
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
        const numericBalance = Number.parseFloat(asset.balance.replace(/,/g, ''));
        return total + (Number.isFinite(numericBalance) ? numericBalance : 0);
      }, 0),
    );
  }, [visibleAssets]);

  useEffect(() => {
    setAssetBalances((current) => current.map((asset) => (asset.key === 'usdc' ? { ...asset, balance } : asset)));
  }, [balance]);

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
              <h1 className="text-xl font-semibold tracking-tight text-[#FAFAFA]">Arc Wallet</h1>
            </div>
          </div>

          <div className="mb-6 space-y-2">
            <h2 className="text-2xl font-semibold tracking-tight">Secure your Arc Testnet wallet</h2>
            <p className="text-sm text-[#A1A1AA]">Create a fresh wallet or import an existing one directly in your browser.</p>
          </div>

          <div className="space-y-3">
            <button
              onClick={handleCreateWallet}
              disabled={isLoading}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#3B82F6] px-4 py-3 font-medium text-white transition hover:bg-[#2563EB]"
            >
              <Download className="h-4 w-4" />
              {isLoading ? 'Preparing…' : 'Create New Wallet'}
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
                disabled={isLoading}
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
    <div className="min-h-screen bg-[#050505] text-[#FAFAFA] px-4 py-5 sm:px-6 lg:px-8">
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 right-0 h-72 w-72 rounded-full bg-blue-600/10 blur-3xl" />
      </div>
      <div className="relative mx-auto flex max-w-md flex-col gap-4">
        <header className="flex items-center justify-between border-b border-[#27272A] pb-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1F4ED8]/20 text-[#93C5FD]">
              <Wallet className="h-5 w-5" />
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

        <section className="rounded-2xl border border-[#27272A] bg-[#121212]/80 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] uppercase tracking-[0.32em] text-[#A1A1AA]">Portfolio value</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight">${totalPortfolioValue} <span className="text-base font-medium text-[#A1A1AA]">USD</span></h2>
              <p className="mt-2 text-xs text-[#A1A1AA]">{ARC_NETWORK_NAME} · Chain ID {ARC_CHAIN_ID}</p>
            </div>
            <button
              onClick={() => setShowAssetBreakdown((current) => !current)}
              className="flex items-center gap-1 rounded-full border border-[#27272A] bg-[#161616] px-3 py-2 text-[11px] text-[#FAFAFA]"
            >
              {showAssetBreakdown ? 'Hide' : 'Assets'}
              {showAssetBreakdown ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
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
                  <span className="text-[#A1A1AA]">{asset.balance}</span>
                </button>
              ))}
            </div>
          ) : null}
        </section>

        <section className="rounded-2xl border border-[#27272A] bg-[#121212]/80 p-4">
          <div className="mb-3 flex items-center justify-between border-b border-[#27272A] pb-3">
            <p className="text-[10px] uppercase tracking-[0.32em] text-[#A1A1AA]">Wallet actions</p>
            <button onClick={() => void refreshBalance()} className="flex items-center gap-1 text-xs text-[#A1A1AA]">
              <RefreshCcw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={openSendModal} className="flex items-center justify-center gap-2 rounded-xl bg-[#3B82F6] px-4 py-3 text-sm font-medium text-white transition hover:bg-[#2563EB]">
              <Send className="h-4 w-4" />
              Send
            </button>
            <button onClick={() => setShowReceive(true)} className="flex items-center justify-center gap-2 rounded-xl border border-[#27272A] bg-[#161616] px-4 py-3 text-sm font-medium text-[#FAFAFA] transition hover:border-[#3B82F6]">
              <Download className="h-4 w-4" />
              Receive
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-[#27272A] bg-[#121212]/80 p-4">
          <div className="mb-3 flex items-center justify-between border-b border-[#27272A] pb-3">
            <p className="text-[10px] uppercase tracking-[0.32em] text-[#A1A1AA]">Holdings</p>
            <span className="text-[11px] text-[#A1A1AA]">{visibleAssets.length} assets</span>
          </div>
          {visibleAssets.length > 0 ? (
            <div className="space-y-3">
              {visibleAssets.map((asset) => (
                <div key={asset.key} className="flex items-center justify-between gap-3 border-b border-[#27272A] pb-3 last:border-b-0 last:pb-0">
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
                  <p className="text-sm font-semibold text-[#FAFAFA]">{asset.balance}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[#A1A1AA]">No balances above zero yet.</p>
          )}
        </section>

        {copied ? <p className="text-center text-xs text-[#3B82F6]">Address copied</p> : null}
      </div>

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

      {showSend ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-3xl border border-[#27272A] bg-[#121212] p-6 shadow-[0_0_80px_rgba(0,0,0,0.35)]">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">Send</h3>
              <button onClick={() => {
                setShowSend(false);
                setSendReview(false);
                setSendAmount('');
                setSendAddress('');
                setSendAmountError('');
                setSendRecipientError('');
                setResolvedSendAddress(null);
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
                      <span className="break-all text-right text-[#FAFAFA]">{sendAddress}</span>
                    </div>
                    {isResolvingArcName ? (
                      <div className="mt-3 rounded-xl border border-[#3B82F6]/30 bg-[#0a0a0a] p-3 text-xs text-[#93C5FD]">
                        Resolving ArcName handle…
                      </div>
                    ) : null}
                    {resolvedSendAddress ? (
                      <div className="mt-3 flex items-center justify-between text-sm text-[#A1A1AA]">
                        <span>Resolved address</span>
                        <span className="break-all text-right text-[#FAFAFA]">{resolvedSendAddress}</span>
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

                  <label className="block text-sm text-[#A1A1AA]">
                    Recipient address or ArcName
                    <input
                      value={sendAddress}
                      onChange={(e) => {
                        setSendAddress(e.target.value);
                        validateSendRecipient(e.target.value);
                      }}
                      className={`mt-2 w-full rounded-xl border bg-[#0a0a0a] px-3 py-3 text-sm text-[#FAFAFA] outline-none ${sendRecipientError ? 'border-red-500' : 'border-[#27272A]'}`}
                      placeholder="0x... or name.arc"
                    />
                    {sendRecipientError ? <p className="mt-2 text-xs text-red-400">{sendRecipientError}</p> : null}
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

              {txState === 'success' && txHash ? (
                <div className="rounded-2xl border border-emerald-700/40 bg-emerald-500/10 p-3 text-sm text-emerald-300">
                  <p>Transaction sent successfully.</p>
                  <a href={`${EXPLORER_URL}/tx/${txHash}`} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-2 text-emerald-200">
                    View on explorer <ExternalLink className="h-4 w-4" />
                  </a>
                </div>
              ) : null}
              {txState === 'error' ? <p className="text-sm text-red-400">{error}</p> : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
