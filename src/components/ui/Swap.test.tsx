import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Swap from '../../components/Swap';
import { getSwapQuote } from '../../swap';

// Mock getSwapQuote to return a fixed quote for testing
vi.mock('../../swap', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getSwapQuote: vi.fn().mockResolvedValue({
      inputAmount: '100',
      outputAmount: '9.9',
      rate: '0.099',
    }),
  };
});

describe('Swap Component', () => {
  const mockProvider = { getBlock: vi.fn().mockResolvedValue({ timestamp: 1715000000 }) };
  const mockWallet = {
    address: '0x1234567890abcdef1234567890abcdef12345678',
    sendTransaction: vi.fn().mockResolvedValue({ wait: vi.fn().mockResolvedValue({}) }),
  };
  const mockAssetBalances = [
    { key: 'usdc', symbol: 'USDC', balance: '1000', decimals: 18 },
    { key: 'eurc', symbol: 'EURC', balance: '500', decimals: 6 },
  ];
  const mockTokenAssets = [
    { key: 'eurc', symbol: 'EURC' },
    { key: 'cirbtc', symbol: 'cirBTC' },
  ];

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders token selectors and amount input', () => {
    render(
      <Swap
        provider={mockProvider}
        wallet={mockWallet}
        assetBalances={mockAssetBalances}
        tokenAssets={mockTokenAssets}
      />
    );
    expect(screen.getByText('Swap Tokens')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Amount')).toBeInTheDocument();
    expect(screen.getByText('Get Quote')).toBeInTheDocument();
  });

  it('shows quote after clicking Get Quote', async () => {
    render(
      <Swap
        provider={mockProvider}
        wallet={mockWallet}
        assetBalances={mockAssetBalances}
        tokenAssets={mockTokenAssets}
      />
    );
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '100' } });
    fireEvent.click(screen.getByText('Get Quote'));
    await waitFor(() => {
      expect(screen.getByText('Exchange Rate')).toBeInTheDocument();
    });
  });

  it('swaps from/to tokens when the token swap button is clicked', () => {
    render(
      <Swap
        provider={mockProvider}
        wallet={mockWallet}
        assetBalances={mockAssetBalances}
        tokenAssets={mockTokenAssets}
      />
    );

    // Initially, From is USDC and To is EURC
    const fromButton = screen.getByLabelText('From: USDC');
    const toButton = screen.getByLabelText('To: EURC');
    expect(fromButton).toBeInTheDocument();
    expect(toButton).toBeInTheDocument();

    // Click the token swap button (circular arrow)
    const tokenSwapButton = screen.getByLabelText('Swap tokens');
    fireEvent.click(tokenSwapButton);

    // After swap, From should be EURC and To should be USDC
    expect(screen.getByLabelText('From: EURC')).toBeInTheDocument();
    expect(screen.getByLabelText('To: USDC')).toBeInTheDocument();
  });

  it('clears quote and error when tokens are swapped', () => {
    render(
      <Swap
        provider={mockProvider}
        wallet={mockWallet}
        assetBalances={mockAssetBalances}
        tokenAssets={mockTokenAssets}
      />
    );

    // Click the token swap button
    const tokenSwapButton = screen.getByLabelText('Swap tokens');
    fireEvent.click(tokenSwapButton);

    // After swap, no quote or error should be displayed
    expect(screen.queryByText('Exchange Rate')).not.toBeInTheDocument();
    expect(screen.queryByText('Swap Error')).not.toBeInTheDocument();
  });

  it('executes swap when the swap execution button is clicked', async () => {
    const onSwapSuccess = vi.fn();
    render(
      <Swap
        provider={mockProvider}
        wallet={mockWallet}
        assetBalances={mockAssetBalances}
        tokenAssets={mockTokenAssets}
        onSwapSuccess={onSwapSuccess}
      />
    );

    // Enter amount and get quote
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '100' } });
    fireEvent.click(screen.getByText('Get Quote'));
    
    // Wait for quote to appear
    await waitFor(() => {
      expect(screen.getByText('Exchange Rate')).toBeInTheDocument();
    });

    // Click the swap execution button (labeled "Swap")
    const swapButton = screen.getByText('Swap');
    fireEvent.click(swapButton);

    // Verify onSwapSuccess was called
    await waitFor(() => {
      expect(onSwapSuccess).toHaveBeenCalled();
    });
  });

  it('does not call onSwapSuccess when the swap transaction fails', async () => {
    const onSwapSuccess = vi.fn();
    const failingWallet = {
      address: '0x123',
      sendTransaction: vi.fn().mockRejectedValue(new Error('Transaction failed')),
    };

    render(
      <Swap
        provider={mockProvider}
        wallet={failingWallet}
        assetBalances={mockAssetBalances}
        tokenAssets={mockTokenAssets}
        onSwapSuccess={onSwapSuccess}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '100' } });
    fireEvent.click(screen.getByText('Get Quote'));
    await waitFor(() => expect(screen.getByText('Exchange Rate')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Swap'));
    await waitFor(() => expect(onSwapSuccess).not.toHaveBeenCalled());
  });

  it('sends approval transaction for ERC-20 tokens (EURC)', async () => {
    const onSwapSuccess = vi.fn();
    render(
      <Swap
        provider={mockProvider}
        wallet={mockWallet}
        assetBalances={mockAssetBalances}
        tokenAssets={mockTokenAssets}
        onSwapSuccess={onSwapSuccess}
      />
    );

    // Click token swap button to swap from/to tokens (from becomes EURC, to becomes USDC)
    fireEvent.click(screen.getByLabelText('Swap tokens'));

    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '100' } });
    fireEvent.click(screen.getByText('Get Quote'));
    await waitFor(() => expect(screen.getByText('Exchange Rate')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Swap'));
    await waitFor(() => expect(onSwapSuccess).toHaveBeenCalled());

    // Verify sendTransaction was called twice (approval + swap)
    expect(mockWallet.sendTransaction).toHaveBeenCalledTimes(2);
    
    // First call should be approval (non-empty data, not '0x')
    const firstCall = mockWallet.sendTransaction.mock.calls[0][0];
    expect(firstCall.to).toBeDefined();
    expect(firstCall.data).toBeDefined();
    expect(firstCall.data).not.toBe('0x');
    expect(firstCall.data).not.toBe('');
    
    // Second call should be swap (non-empty data, not '0x')
    const secondCall = mockWallet.sendTransaction.mock.calls[1][0];
    expect(secondCall.to).toBeDefined();
    expect(secondCall.data).toBeDefined();
    expect(secondCall.data).not.toBe('0x');
    expect(secondCall.data).not.toBe('');
  });

  it('sends approval transaction for USDC on Arc Testnet (ERC-20)', async () => {
    const onSwapSuccess = vi.fn();
    const mockAssetBalancesOnlyUSDC = [
      { key: 'usdc', symbol: 'USDC', balance: '1000', decimals: 18 },
    ];
    render(
      <Swap
        provider={mockProvider}
        wallet={mockWallet}
        assetBalances={mockAssetBalancesOnlyUSDC}
        tokenAssets={[]}
        onSwapSuccess={onSwapSuccess}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '100' } });
    fireEvent.click(screen.getByText('Get Quote'));
    await waitFor(() => expect(screen.getByText('Exchange Rate')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Swap'));
    await waitFor(() => expect(onSwapSuccess).toHaveBeenCalled());

    // Verify sendTransaction was called twice (approval + swap)
    // USDC on Arc Testnet is an ERC-20 and requires approval
    expect(mockWallet.sendTransaction).toHaveBeenCalledTimes(2);
    
    // First call should be approval (non-empty data, not '0x')
    const firstCall = mockWallet.sendTransaction.mock.calls[0][0];
    expect(firstCall.to).toBeDefined();
    expect(firstCall.data).toBeDefined();
    expect(firstCall.data).not.toBe('0x');
    expect(firstCall.data).not.toBe('');
    
    // Second call should be swap (non-empty data, not '0x')
    const secondCall = mockWallet.sendTransaction.mock.calls[1][0];
    expect(secondCall.to).toBeDefined();
    expect(secondCall.data).toBeDefined();
    expect(secondCall.data).not.toBe('0x');
    expect(secondCall.data).not.toBe('');
  });

  it('displays swap execution button after obtaining a quote', async () => {
    render(
      <Swap
        provider={mockProvider}
        wallet={mockWallet}
        assetBalances={mockAssetBalances}
        tokenAssets={mockTokenAssets}
        onSwapSuccess={vi.fn()}
      />
    );
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '100' } });
    fireEvent.click(screen.getByText('Get Quote'));
    await waitFor(() => {
      expect(screen.getByText('Swap')).toBeInTheDocument();
    });
  });

  it('swap execution button is not visible when no quote is available', () => {
    render(
      <Swap
        provider={mockProvider}
        wallet={mockWallet}
        assetBalances={mockAssetBalances}
        tokenAssets={mockTokenAssets}
        onSwapSuccess={vi.fn()}
      />
    );
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '100' } });
    expect(screen.queryByText('Swap')).not.toBeInTheDocument();
  });

  it('does not attempt exactInput when resolved amountOutMinimum would be <= 0n', async () => {
    const onSwapSuccess = vi.fn();
    const mockWalletNoSwap = {
      address: '0x1234567890abcdef1234567890abcdef12345678',
      sendTransaction: vi.fn().mockResolvedValue({ wait: vi.fn().mockResolvedValue({}) }),
    };
    
    // Mock getSwapQuote to return a quote that would produce amountOutMinimum <= 0n
    // Reset the mock to reject first, then use it
    getSwapQuote.mockRejectedValueOnce(
      new Error('Unable to determine a positive swap output; check pool liquidity.')
    );

    render(
      <Swap
        provider={mockProvider}
        wallet={mockWalletNoSwap}
        assetBalances={mockAssetBalances}
        tokenAssets={mockTokenAssets}
        onSwapSuccess={onSwapSuccess}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '100' } });
    fireEvent.click(screen.getByText('Get Quote'));
    await waitFor(() => {
      expect(screen.getByText('Swap Error')).toBeInTheDocument();
    });

    // Verify the component shows the error and does not attempt the swap
    expect(mockWalletNoSwap.sendTransaction).not.toHaveBeenCalled();
    expect(onSwapSuccess).not.toHaveBeenCalled();
  });
});