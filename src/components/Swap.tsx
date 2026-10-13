import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpDown, ChevronDown, CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';
import { ethers } from 'ethers';
import { getSwapQuote, buildSwapTransactionPlan, buildTokenApprovalPlan, validateSwapAmount, getTokenAddress, UNISWAP_V3_ROUTER_ABI, UNISWAP_V3_ROUTER_ADDRESS, DEFAULT_SLIPPAGE_TOLERANCE, SWAP_DEADLINE_SECONDS } from '../swap';
import { formatGasFeeUsdc } from '../gasEstimate';
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
  type ActionStage = 'get-quote' | 'review' | 'swap';

  const [fromToken, setFromToken] = useState('USDC');
  const [toToken, setToToken] = useState('EURC');
  const [amount, setAmount] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [actionStage, setActionStage] = useState<ActionStage>('get-quote');
  const [quote, setQuote] = useState<{ inputAmount: string; outputAmount: string; rate: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openDropdown, setOpenDropdown] = useState<'from' | 'to' | null>(null);
  
  // Gas fee estimation states
  const [gasFeeUsdc, setGasFeeUsdc] = useState<string | null>(null);
  const [isEstimatingGasFee, setIsEstimatingGasFee] = useState(false);
  const [gasFeeError, setGasFeeError] = useState<string | null>(null);

  // State to store dropdown positions for portal rendering
  const [dropdownPositions, setDropdownPositions] = useState<Record<'from' | 'to', { x: number; y: number; width: number } | null>>({
    from: null,
    to: null
  });

  const fromDropdownRef = useRef<HTMLDivElement>(null);
  const toDropdownRef = useRef<HTMLDivElement>(null);

  // Update dropdown positions when refs change or open state changes
  useEffect(() => {
    const updatePosition = (type: 'from' | 'to') => {
      const ref = type === 'from' ? fromDropdownRef : toDropdownRef;
      if (ref.current && openDropdown === type) {
        const rect = ref.current.getBoundingClientRect();
        setDropdownPositions(prev => ({
          ...prev,
          [type]: { x: rect.left, y: rect.bottom, width: rect.width }
        }));
      } else if (openDropdown !== type) {
        // Clear position when dropdown is closed
        setDropdownPositions(prev => ({
          ...prev,
          [type]: null
        }));
      }
    };

    // Always update both positions when openDropdown changes
    updatePosition('from');
    updatePosition('to');
  }, [openDropdown, fromDropdownRef, toDropdownRef]);

  // Update positions on window resize or scroll
  useEffect(() => {
    const handleResize = () => {
      if (openDropdown === 'from' && fromDropdownRef.current) {
        const rect = fromDropdownRef.current.getBoundingClientRect();
        setDropdownPositions(prev => ({
          ...prev,
          from: { x: rect.left, y: rect.bottom, width: rect.width }
        }));
      }
      if (openDropdown === 'to' && toDropdownRef.current) {
        const rect = toDropdownRef.current.getBoundingClientRect();
        setDropdownPositions(prev => ({
          ...prev,
          to: { x: rect.left, y: rect.bottom, width: rect.width }
        }));
      }
    };

    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleResize);
    };
  }, [openDropdown]);

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
      const target = event.target as Node;

      // If the click is inside a dropdown option (rendered via portal), do not close.
      // The option's own onClick will handle selection and closing.
      if (target.closest?.('[role="listbox"]')) {
        return;
      }

      if (openDropdown === 'from' && fromDropdownRef.current && !fromDropdownRef.current.contains(target)) {
        setOpenDropdown(null);
      }
      if (openDropdown === 'to' && toDropdownRef.current && !toDropdownRef.current.contains(target)) {
        setOpenDropdown(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [openDropdown]);

  // Auto-transition to swap stage after quote is obtained (review stage)
  useEffect(() => {
    if (actionStage === 'review' && quote && !isLoading) {
      const timer = setTimeout(() => setActionStage('swap'), 0);
      return () => clearTimeout(timer);
    }
  }, [actionStage, quote, isLoading]);

  // Estimate gas fee when quote or tokens change
  useEffect(() => {
    if (quote && amount && wallet?.address) {
      estimateGasFee();
    } else {
      setGasFeeUsdc(null);
      setGasFeeError(null);
    }
  }, [quote, amount, fromToken, toToken]);

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
      setActionStage('review'); // Transition to review stage after getting quote
    } catch (e: any) {
      setError(e.message || 'Invalid swap amount');
    } finally {
      setIsLoading(false);
    }
  };

  const handleReviewSwap = () => {
    // In progressive flow: clicking Review Swap executes the swap directly
    // (combines the review and execution steps for backward compatibility)
    handleSwap();
  };

  const estimateGasFee = async () => {
    if (!quote || !amount) return;
    
    setIsEstimatingGasFee(true);
    setGasFeeError(null);
    
    try {
      // Build the swap transaction plan to get the router address
      const plan = buildSwapTransactionPlan(quote, wallet.address || '0x');
      
      // Build the swap calldata using the router interface
      const routerInterface = new ethers.Interface(UNISWAP_V3_ROUTER_ABI);
      const fromTokenAddress = getTokenAddress(fromToken);
      const toTokenAddress = getTokenAddress(toToken);
      const path = [fromTokenAddress, toTokenAddress];
      
      const inputAmount = ethers.parseUnits(quote.inputAmount, getAssetDecimals(fromToken));
      const amountOutMinimum = ethers.parseUnits(quote.outputAmount, getAssetDecimals(toToken));
      const deadline = quote.deadline || (Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS);
      
      const calldata = routerInterface.encodeFunctionData('swapExactTokensForTokens', [
        inputAmount,
        amountOutMinimum,
        path,
        wallet.address || '0x',
        deadline,
      ]);
      
      // Estimate gas limit for the swap transaction
      let gasLimit: bigint;
      try {
        gasLimit = await provider.estimateGas({
          from: wallet.address || '0x',
          to: plan.router,
          data: calldata,
        });
      } catch (err) {
        setGasFeeError('Unable to estimate gas');
        return;
      }
      
      // Fetch gas price
      let gasPrice: bigint | null = null;
      try {
        const feeData = await provider.getFeeData();
        gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
        
        if (!gasPrice) {
          setGasFeeError('Unable to retrieve gas price');
          return;
        }
      } catch (err) {
        setGasFeeError('Unable to retrieve gas price');
        return;
      }
      
      // Calculate and format the gas fee
      try {
        const formattedFee = formatGasFeeUsdc(gasLimit, gasPrice);
        setGasFeeUsdc(formattedFee);
      } catch (err) {
        setGasFeeError('Unable to calculate gas fee');
      }
      
    } catch (err) {
      setGasFeeError(err instanceof Error ? err.message : 'Gas estimation failed');
    } finally {
      setIsEstimatingGasFee(false);
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
    setActionStage('get-quote'); // Reset to initial stage
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

            {/* Dropdown rendered via portal to avoid clipping */}
            {openDropdown === 'from' && (
              createPortal(
                <div
                  role="listbox"
                  aria-label="From token options"
                  style={{
                    position: 'fixed',
                    zIndex: 50,
                    left: dropdownPositions.from?.x ?? 0,
                    top: dropdownPositions.from?.y ?? 0,
                    width: dropdownPositions.from?.width ?? 0,
                  }}
                  className="max-h-[90vh] sm:max-h-72 overflow-y-auto overflow-x-hidden rounded-xl border border-white/[0.08] bg-[#12141B]/95 backdrop-blur-xl shadow-[0_16px_50px_rgba(0,0,0,0.5)] p-1"
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
                </div>,
                document.body
              )
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

            {/* Dropdown rendered via portal to avoid clipping */}
            {openDropdown === 'to' && (
              createPortal(
                <div
                  role="listbox"
                  aria-label="To token options"
                  style={{
                    position: 'fixed',
                    zIndex: 50,
                    left: dropdownPositions.to?.x ?? 0,
                    top: dropdownPositions.to?.y ?? 0,
                    width: dropdownPositions.to?.width ?? 0,
                  }}
                  className="max-h-[90vh] sm:max-h-72 overflow-y-auto overflow-x-hidden rounded-xl border border-white/[0.08] bg-[#12141B]/95 backdrop-blur-xl shadow-[0_16px_50px_rgba(0,0,0,0.5)] p-1"
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
                </div>,
                document.body
              )
            )}
          </div>
        </div>
      </div>

      {/* --- Progressive Action Button --- */}
      <div className="mb-4">
        {/* Single Progressive Action Button */}
        <button
          onClick={
            actionStage === 'get-quote' ? handleGetQuote :
            actionStage === 'review' ? handleReviewSwap :
            handleSwap
          }
          disabled={
            actionStage === 'get-quote' ? (isLoading || !amount) :
            actionStage === 'review' ? isLoading :
            isLoading || !quote || !amount
          }
          className="w-full rounded-2xl bg-[#069494] px-4 py-3 font-medium text-white transition hover:bg-[#058A8A] disabled:cursor-not-allowed disabled:opacity-70"
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 inline mr-2 animate-spin" />
          ) : (
            actionStage === 'get-quote' ? 'Get Quote' :
            actionStage === 'review' ? 'Review Swap' :
            'Swap'
          )}
        </button>
      </div>

      {/* --- Quote & Exchange Rate --- */}
      {quote && (
        <div className="mb-3 rounded-2xl border border-white/[0.06] bg-[#16171C] p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-[#71717A]">Network Fee (USDC)</span>
            <span className="font-medium text-[#F5F3FF]">
              {isEstimatingGasFee ? 'Estimating...' : gasFeeError ? 'Unable to estimate' : gasFeeUsdc}
            </span>
          </div>
          <div className="mt-3 flex items-center justify-between text-sm border-t border-white/[0.06] pt-3">
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