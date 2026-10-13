import { useState, useRef, useEffect } from 'react';
import { ArrowUpDown, ChevronDown, CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';
import { ethers } from 'ethers';
import { getSwapQuote, buildSwapTransactionPlan, buildTokenApprovalPlan, validateSwapAmount, getTokenAddress, UNISWAP_V3_ROUTER_ABI, UNISWAP_V3_ROUTER_ADDRESS, DEFAULT_SLIPPAGE_TOLERANCE, SWAP_DEADLINE_SECONDS } from '../swap';
import { getAssetUsdPrice, getAssetUsdValue, formatTokenBalance, getAssetDecimals } from '../balance';
import usdcSvg from '../assets/usdc.svg';
import eurcSvg from '../assets/eurc.svg';
import cirbtcSvg from '../assets/cirbtc.svg';

const ASSET_ICON_URLS: Record<string, string> = {
  USDC: usdcSvg,
  EURC: eurcSvg,
  CIRBTC: cirbtcSvg,
  cirBTC: cirbtcSvg,
};

type AssetOption = {
  key: string;
  symbol: string;
  balance: string;
  decimals?: number;
};

type SwapProps = {
  provider: any;
  wallet: any;
  assetBalances: AssetOption[];
  tokenAssets: AssetOption[];
  onSwapSuccess?: () => void;
};

export default function Swap({ provider, wallet, assetBalances, tokenAssets, onSwapSuccess }: SwapProps) {
  const [fromToken, setFromToken] = useState('USDC');
  const [toToken, setToToken] = useState('EURC');
  const [amount, setAmount] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [quote, setQuote] = useState<{ inputAmount: string; outputAmount: string; rate: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openDropdown, setOpenDropdown] = useState<'from' | 'to' | null>(null);

  const fromDropdownRef = useRef<HTMLDivElement>(null);
  const toDropdownRef = useRef<HTMLDivElement>(null);

  // Combine all assets for dropdown display, deduplicating by symbol
  const seen = new Set<string>();
  const combinedAssets: AssetOption[] = [];

  // Helper to add an asset if its symbol hasn't been seen yet
  const addIfUnique = (asset: AssetOption) => {
    if (!seen.has(asset.symbol)) {
      seen.add(asset.symbol);
      combinedAssets.push(asset);
    }
  };

  // Add USDC first if present in assetBalances
  const usdcFromBalances = assetBalances.find((a) => a.symbol === 'USDC');
  if (usdcFromBalances) addIfUnique(usdcFromBalances);

  // Add remaining tokens from assetBalances (skip USDC since we handled it)
  for (const asset of assetBalances) {
    if (asset.symbol !== 'USDC') addIfUnique(asset);
  }

  // Add tokens from tokenAssets that haven't been seen yet
  for (const asset of tokenAssets) {
    if (asset.symbol !== 'USDC') addIfUnique(asset);
  }

  // Ensure all supported tokens are present (fill in missing ones)
  const SUPPORTED_TOKENS = ['USDC', 'EURC', 'cirBTC'] as const;
  for (const symbol of SUPPORTED_TOKENS) {
    if (!seen.has(symbol)) {
      // Find the asset from either source
      const existing = assetBalances.find((a) => a.symbol === symbol) || tokenAssets.find((a) => a.symbol === symbol);
      if (existing) addIfUnique(existing);
    }
  }

  const assetOptions: AssetOption[] = combinedAssets;

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (openDropdown === 'from' && fromDropdownRef.current && !fromDropdownRef.current.contains(event.target as Node)) {
        setOpenDropdown(null);
      }
      if (openDropdown === 'to' && toDropdownRef.current && !toDropdownRef.current.contains(event.target as Node)) {
        setOpenDropdown(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [openDropdown]);

  // Prevent selecting the same token for both from and to
  const canSelectFrom = (token: string) => token !== toToken;
  const canSelectTo = (token: string) => token !== fromToken;

  const getTokenBalance = (symbol: string): string => {
    const asset = assetBalances.find((a) => a.symbol === symbol);
    if (asset) return asset.balance;
    const token = tokenAssets.find((a) => a.symbol === symbol);
    return token?.balance ?? '0';
  };

  const getTokenOption = (symbol: string): AssetOption | undefined => {
    const asset = assetBalances.find((a) => a.symbol === symbol);
    if (asset) return asset;
    return tokenAssets.find((a) => a.symbol === symbol);
  };

  const handleGetQuote = async () => {
    setIsLoading(true);
    setError(null);
    try {
      validateSwapAmount(amount, fromToken, getTokenBalance(fromToken));
      const result = await getSwapQuote(fromToken, toToken, amount);
      setQuote({ inputAmount: result.inputAmount, outputAmount: result.outputAmount, rate: result.rate });
    } catch (e: any) {
      setError(e.message || 'Invalid swap amount');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTokenSwap = () => {
    // Swap fromToken and toToken
    const temp = fromToken;
    setFromToken(toToken);
    setToToken(temp as 'USDC' | 'EURC' | 'cirBTC');
    // Clear any existing quote and error states
    setQuote(null);
    setError(null);
  };

  const handleSwap = async () => {
    if (!quote) return;

    setIsLoading(true);
    setError(null);

    try {
      validateSwapAmount(amount, fromToken, getTokenBalance(fromToken));
    } catch (e: any) {
      setError(e.message || 'Invalid swap amount');
      setIsLoading(false);
      return;
    }

    if (!wallet?.address) {
      setError('Wallet not connected');
      setIsLoading(false);
      return;
    }

    if (!onSwapSuccess) {
      setError('Swap callback not available');
      setIsLoading(false);
      return;
    }

    try {
      // Check if token approval is needed (ERC-20 tokens only)
      const approvalPlan = buildTokenApprovalPlan(fromToken, wallet.address);

      if (approvalPlan) {
        // Send approval transaction first — use ERC-20 approve ABI (not transfer)
        const approveInterface = new ethers.Interface([
          'function approve(address spender, uint256 value) external returns (bool)',
        ]);
        const approvalCalldata = approveInterface.encodeFunctionData('approve', [
          approvalPlan.spender,
          approvalPlan.amount,
        ]);

        const approvalTx = await wallet.sendTransaction({
          to: approvalPlan.tokenAddress,
          data: approvalCalldata,
          value: 0n,
        });
        await approvalTx.wait();
      }

      // Build the swap transaction (Uniswap V2)
      const tokensFrom = getTokenAddress(fromToken);
      const tokensTo = getTokenAddress(toToken);
      
      // Check if user has enough USDC balance (getTokenBalance returns string)
      const usdcBalance = getTokenBalance(fromToken);
      if (Number(usdcBalance) <= 0) {
        setError('Insufficient USDC balance to perform swap.');
        setIsLoading(false);
        return;
      }

      const path = [tokensFrom, tokensTo];

      const amountIn = ethers.parseUnits(quote.inputAmount, getAssetDecimals(fromToken));
      const amountOutMinimum = ethers.parseUnits(quote.outputAmount, getAssetDecimals(toToken));
      if (amountOutMinimum <= 0n) {
        throw new Error('Unable to determine a positive swap output; check pool liquidity.');
      }

      const recipients = wallet.address;
      const deadline = quote.deadline ?? (Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS);

      const routerInterface = new ethers.Interface(UNISWAP_V3_ROUTER_ABI);
      const calldata = routerInterface.encodeFunctionData('swapExactTokensForTokens', [
        amountIn,
        amountOutMinimum,
        path,
        recipients,
        deadline,
      ]);

      const tx = await wallet.sendTransaction({
        to: UNISWAP_V3_ROUTER_ADDRESS,
        data: calldata,
        value: 0n,
      });
      await tx.wait();

      onSwapSuccess();
    } catch (e: any) {
      setError(e.message || 'Swap failed');
    } finally {
      setIsLoading(false);
    }
  };

  const isFromSelected = (symbol: string) => fromToken === symbol;
  const isToSelected = (symbol: string) => toToken === symbol;

  return (
    <div className="swap-modal">
      <h2 className="text-xl font-semibold text-[#F5F3FF] mb-4">Swap Tokens</h2>

      {/* --- Send Card --- */}
      <div className="send-card mb-4 rounded-2xl border border-white/[0.06] bg-[#0B0C11] p-4">
        <span className="text-xs font-medium text-[#71717A] mb-3 block">Send</span>

        <div className="flex items-end gap-3">
          {/* Amount input on left */}
          <div className="flex-1">
            <input
              type="text"
              placeholder="Amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full bg-transparent text-3xl font-display font-medium text-[#F5F3FF] placeholder:text-[#71717A] focus:outline-none"
            />
            {/* Fiat value underneath */}
            <div className="mt-1 flex items-center gap-1 text-sm text-[#71717A]">
              {amount && !isNaN(Number(amount)) ? (
                <>
                  {(() => {
                    const usdValue = getAssetUsdValue(fromToken, amount);
                    if (usdValue === null || !Number.isFinite(usdValue)) return '$--';
                    return `≈ $${usdValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                  })()}
                  <span className="mb-1 text-xs">↓</span>
                </>
              ) : (
                '≈ $0.00'
              )}
            </div>
          </div>

          {/* Token selector on right */}
          <div ref={fromDropdownRef} className="relative">
            <button
              type="button"
              className="group flex items-center gap-2 rounded-full border border-white/[0.06] bg-[#16171C] px-3 py-2 transition-all duration-200 hover:border-[#069494]/30 hover:bg-[#1A1B21] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#069494]/40"
              onClick={() => setOpenDropdown(openDropdown === 'from' ? null : 'from')}
              aria-label={`From: ${fromToken}`}
              aria-haspopup="listbox"
              aria-expanded={openDropdown === 'from'}
            >
              <img
                src={ASSET_ICON_URLS[fromToken] ?? ASSET_ICON_URLS.CIRBTC}
                alt=""
                className="h-6 w-6 rounded-full"
              />
              <span className="text-sm font-medium text-[#F5F3FF]">{fromToken}</span>
              <ChevronDown className="h-3 w-3 text-[#069494] opacity-70" />
            </button>

            {openDropdown === 'from' && (
              <div
                role="listbox"
                aria-label="From token options"
                className="absolute z-50 mt-1 w-full max-h-[90vh] sm:max-h-72 overflow-y-auto overflow-x-hidden rounded-xl border border-white/[0.08] bg-[#12141B]/95 backdrop-blur-xl shadow-[0_16px_50px_rgba(0,0,0,0.5)] p-1"
              >
                {assetOptions.map((option) => {
                  const isSelected = isFromSelected(option.symbol);
                  const isZero = Number(option.balance ?? 0) <= 0;
                  const canSelect = canSelectFrom(option.symbol);
                  return (
                    <button
                      key={option.key}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      aria-label={`${option.symbol}, ${option.balance ?? '0'} available`}
                      onClick={() => {
                        if (canSelect) {
                          setFromToken(option.symbol as 'USDC' | 'EURC' | 'cirBTC');
                          setOpenDropdown(null);
                        }
                      }}
                      disabled={!canSelect}
                      className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-fast ${
                        isSelected ? 'bg-[#069494]/10' : 'hover:bg-white/[0.04]'
                      } ${!canSelect ? 'opacity-60 cursor-not-allowed' : ''}`}
                    >
                      <img
                        src={ASSET_ICON_URLS[option.key] ?? ASSET_ICON_URLS[option.symbol] ?? ASSET_ICON_URLS.CIRBTC}
                        alt=""
                        className="h-8 w-8 rounded-full shadow-sm"
                      />
                      <div className="min-w-0 flex-1">
                        <span className={`block text-sm font-medium truncate ${isZero ? 'text-[#71717A]' : 'text-[#F5F3FF]'}`}>
                          {option.symbol}
                        </span>
                        <span className={`block text-[11px] font-variant-numeric-tabular ${isZero ? 'text-[#555]' : 'text-[#71717A]'}`}>
                          {option.balance ?? '0'} available
                        </span>
                      </div>
                      {isSelected && <CheckCircle2 className="h-4 w-4 shrink-0 text-[#069494]" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* --- Center Divider (Swap Direction) --- */}
      <div className="my-4 flex justify-center">
        <button
          onClick={handleTokenSwap}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.06] bg-[#16171C] shadow-sm transition-all duration-200 hover:border-[#069494]/50 hover:bg-[#1A1B21] hover:scale-105 cursor-pointer"
          aria-label="Swap tokens"
        >
          <ArrowUpDown className="h-5 w-5 text-[#069494]" />
        </button>
      </div>

      {/* --- Receive Card --- */}
      <div className="receive-card mb-4 rounded-2xl border border-white/[0.06] bg-[#0B0C11] p-4">
        <span className="text-xs font-medium text-[#71717A] mb-3 block">Receive</span>

        <div className="flex items-end gap-3">
          {/* Output amount on left */}
          <div className="flex-1">
            <input
              type="text"
              placeholder="0.0"
              value={quote?.outputAmount ?? ''}
              readOnly
              className="w-full bg-transparent text-3xl font-display font-medium text-[#F5F3FF] placeholder:text-[#71717A] focus:outline-none"
            />
            {/* Fiat value underneath */}
            <div className="mt-1 flex items-center gap-1 text-sm text-[#71717A]">
              {quote?.outputAmount ? (
                <>
                  {(() => {
                    const usdValue = getAssetUsdValue(toToken, quote.outputAmount);
                    if (usdValue === null || !Number.isFinite(usdValue)) return '≈ $--';
                    return `≈ $${usdValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                  })()}
                  <span className="mb-1 text-xs">↓</span>
                </>
              ) : (
                '≈ $0.00'
              )}
            </div>
          </div>

          {/* Token selector on right */}
          <div ref={toDropdownRef} className="relative">
            <button
              type="button"
              className="group flex items-center gap-2 rounded-full border border-white/[0.06] bg-[#16171C] px-3 py-2 transition-all duration-200 hover:border-[#069494]/30 hover:bg-[#1A1B21] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#069494]/40"
              onClick={() => setOpenDropdown(openDropdown === 'to' ? null : 'to')}
              aria-label={`To: ${toToken}`}
              aria-haspopup="listbox"
              aria-expanded={openDropdown === 'to'}
            >
              <img
                src={ASSET_ICON_URLS[toToken] ?? ASSET_ICON_URLS.CIRBTC}
                alt=""
                className="h-6 w-6 rounded-full"
              />
              <span className="text-sm font-medium text-[#F5F3FF]">{toToken}</span>
              <ChevronDown className="h-3 w-3 text-[#069494] opacity-70" />
            </button>

            {openDropdown === 'to' && (
              <div
                role="listbox"
                aria-label="To token options"
                className="absolute z-50 mt-1 w-full max-h-[90vh] sm:max-h-72 overflow-y-auto overflow-x-hidden rounded-xl border border-white/[0.08] bg-[#12141B]/95 backdrop-blur-xl shadow-[0_16px_50px_rgba(0,0,0,0.5)] p-1"
              >
                {assetOptions.map((option) => {
                  const isSelected = isToSelected(option.symbol);
                  const isZero = Number(option.balance ?? 0) <= 0;
                  const canSelect = canSelectTo(option.symbol);
                  return (
                    <button
                      key={option.key}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      aria-label={`${option.symbol}, ${option.balance ?? '0'} available`}
                      onClick={() => {
                        if (canSelect) {
                          setToToken(option.symbol as 'USDC' | 'EURC' | 'cirBTC');
                          setOpenDropdown(null);
                        }
                      }}
                      disabled={!canSelect}
                      className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-fast ${
                        isSelected ? 'bg-[#069494]/10' : 'hover:bg-white/[0.04]'
                      } ${!canSelect ? 'opacity-60 cursor-not-allowed' : ''}`}
                    >
                      <img
                        src={ASSET_ICON_URLS[option.key] ?? ASSET_ICON_URLS[option.symbol] ?? ASSET_ICON_URLS.CIRBTC}
                        alt=""
                        className="h-8 w-8 rounded-full shadow-sm"
                      />
                      <div className="min-w-0 flex-1">
                        <span className={`block text-sm font-medium truncate ${isZero ? 'text-[#71717A]' : 'text-[#F5F3FF]'}`}>
                          {option.symbol}
                        </span>
                        <span className={`block text-[11px] font-variant-numeric-tabular ${isZero ? 'text-[#555]' : 'text-[#71717A]'}`}>
                          {option.balance ?? '0'} available
                        </span>
                      </div>
                      {isSelected && <CheckCircle2 className="h-4 w-4 shrink-0 text-[#069494]" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* --- Get Quote --- */}
      <div className="mb-4">
        <button
          onClick={handleGetQuote}
          disabled={isLoading || !amount}
          className="w-full rounded-2xl bg-[#069494] px-4 py-3 font-medium text-white transition hover:bg-[#058A8A] disabled:cursor-not-allowed disabled:opacity-70"
        >
          {isLoading ? <Loader2 className="h-4 w-4 inline mr-2 animate-spin" /> : 'Get Quote'}
        </button>
      </div>

      {/* --- Quote & Exchange Rate --- */}
      {quote && (
        <>
          <div className="mb-3 rounded-2xl border border-white/[0.06] bg-[#16171C] p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-[#71717A]">Exchange Rate</span>
              <span className="font-medium text-[#F5F3FF]">1 {fromToken} ≈ {quote.rate} {toToken}</span>
            </div>
            <div className="mt-3 flex items-center justify-between text-sm border-t border-white/[0.06] pt-3">
              <span className="text-[#71717A]">Estimated Output</span>
              <div className="text-right">
                <span className="font-medium text-[#F5F3FF]">{quote.outputAmount} {toToken}</span>
                <span className="ml-2 text-xs text-[#71717A]">{(() => {
                  const usdValue = getAssetUsdValue(toToken, quote.outputAmount);
                  if (usdValue === null || !Number.isFinite(usdValue)) return '≈ $--';
                  return `≈ $${usdValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                })()}</span>
              </div>
            </div>
          </div>

          {/* Swap Execution Button */}
          <button
            type="button"
            onClick={handleSwap}
            disabled={isLoading || !quote || !amount}
            className="w-full rounded-2xl bg-[#069494] px-4 py-3 font-medium text-white transition hover:bg-[#058A8A] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isLoading ? <Loader2 className="h-4 w-4 inline mr-2 animate-spin" /> : 'Swap'}
          </button>
        </>
      )}

      {/* --- Error Display --- */}
      {error && (
        <div className="mt-4 rounded-2xl border border-red-700/40 bg-red-500/10 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-red-400" />
            <div className="flex-1">
              <p className="text-sm text-red-300 font-medium">Swap Error</p>
              <p className="mt-1 text-xs text-red-400/80">{error}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}