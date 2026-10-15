import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Swap from '../../components/Swap';
import { getSwapQuote } from '../../features/swap/swap';

// Mock getSwapQuote to return a fixed quote for testing
vi.mock('../../swap', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual as Record<string, unknown>,
    getSwapQuote: vi.fn().mockResolvedValue({
      from: 'USDC',
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
    { key: 'eurc', symbol: 'EURC', balance: '500', decimals: 6 },
    { key: 'cirbtc', symbol: 'cirBTC', balance: '0', decimals: 18 },
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
    expect(screen.queryByText('Swap Tokens')).not.toBeInTheDocument();
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

  it('shows all three quote rows after clicking Get Quote', async () => {
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
      expect(screen.getByText('Network Fee (USDC)')).toBeInTheDocument();
      expect(screen.getByText('Exchange Rate')).toBeInTheDocument();
      expect(screen.getByText('Estimated Output')).toBeInTheDocument();
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
    (getSwapQuote as any).mockRejectedValueOnce(
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

  // Dropdown (portal) tests
  describe('Token Selector Dropdown', () => {
    it('opens the "From" dropdown and renders all token options when clicked', () => {
      render(
        <Swap
          provider={mockProvider}
          wallet={mockWallet}
          assetBalances={mockAssetBalances}
          tokenAssets={mockTokenAssets}
        />
      );

      // Initially dropdown should not be visible
      expect(screen.queryByRole('listbox', { name: 'From token options' })).not.toBeInTheDocument();

      // Click the "From" button
      fireEvent.click(screen.getByLabelText('From: USDC'));

      // Dropdown should now be visible
      const fromDropdown = screen.getByRole('listbox', { name: 'From token options' });
      expect(fromDropdown).toBeInTheDocument();

      // All token options should be rendered
      const options = screen.getAllByRole('option');
      expect(options.length).toBeGreaterThan(0);

      // USDC, EURC, and cirBTC should all be present
      expect(screen.getByRole('option', { name: /USDC/ })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /EURC/ })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /cirBTC/ })).toBeInTheDocument();
    });

    it('opens the "To" dropdown and renders all token options when clicked', () => {
      render(
        <Swap
          provider={mockProvider}
          wallet={mockWallet}
          assetBalances={mockAssetBalances}
          tokenAssets={mockTokenAssets}
        />
      );

      // Initially dropdown should not be visible
      expect(screen.queryByRole('listbox', { name: 'To token options' })).not.toBeInTheDocument();

      // Click the "To" button
      fireEvent.click(screen.getByLabelText('To: EURC'));

      // Dropdown should now be visible
      const toDropdown = screen.getByRole('listbox', { name: 'To token options' });
      expect(toDropdown).toBeInTheDocument();

      // All token options should be rendered
      const options = screen.getAllByRole('option');
      expect(options.length).toBeGreaterThan(0);
    });

    it('selecting a token closes the dropdown and updates the token', () => {
      render(
        <Swap
          provider={mockProvider}
          wallet={mockWallet}
          assetBalances={mockAssetBalances}
          tokenAssets={mockTokenAssets}
        />
      );

      // Click "From" button to open dropdown
      fireEvent.click(screen.getByLabelText('From: USDC'));
      expect(screen.getByRole('listbox', { name: 'From token options' })).toBeInTheDocument();

      // Click EURC option
      fireEvent.click(screen.getByRole('option', { name: /EURC/ }));

      // Dropdown should be closed
      expect(screen.queryByRole('listbox', { name: 'From token options' })).not.toBeInTheDocument();

      // From token should be updated
      expect(screen.getByLabelText('From: EURC')).toBeInTheDocument();
    });

    it('closes the dropdown when clicking outside', () => {
      render(
        <Swap
          provider={mockProvider}
          wallet={mockWallet}
          assetBalances={mockAssetBalances}
          tokenAssets={mockTokenAssets}
        />
      );

      // Open the "From" dropdown
      fireEvent.click(screen.getByLabelText('From: USDC'));
      expect(screen.getByRole('listbox', { name: 'From token options' })).toBeInTheDocument();

      // Click outside on the swap button
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('listbox', { name: 'From token options' })).not.toBeInTheDocument();
    });

    it('dropdown options are rendered in the DOM (portal renders to document.body)', () => {
      render(
        <Swap
          provider={mockProvider}
          wallet={mockWallet}
          assetBalances={mockAssetBalances}
          tokenAssets={mockTokenAssets}
        />
      );

      // Open "From" dropdown
      fireEvent.click(screen.getByLabelText('From: USDC'));

      // Get all options - they should be in the document
      const options = screen.getAllByRole('option');
      expect(options.length).toBeGreaterThanOrEqual(3); // At least USDC, EURC, cirBTC

      // Verify options are present in the DOM.
      // In the "From" dropdown: USDC is the current selection (not disabled),
      // EURC is disabled (same as "To"), cirBTC is available.
      const usdcOption = screen.getByRole('option', { name: /USDC/ });
      const eurcOption = screen.getByRole('option', { name: /EURC/ });
      const cirbtcOption = screen.getByRole('option', { name: /cirBTC/ });

      expect(usdcOption).not.toBeDisabled();  // USDC is the current selection, selectable
      expect(eurcOption).toBeDisabled();      // EURC matches "To" token, disabled
      expect(cirbtcOption).not.toBeDisabled();
    });

    it('disables options that would cause duplicate token selection', () => {
      render(
        <Swap
          provider={mockProvider}
          wallet={mockWallet}
          assetBalances={mockAssetBalances}
          tokenAssets={mockTokenAssets}
        />
      );

      // "From" is USDC, "To" is EURC
      // Clicking "From" dropdown - EURC should be disabled (same as "To")
      fireEvent.click(screen.getByLabelText('From: USDC'));
      
      const fromDropdown = screen.getByRole('listbox', { name: 'From token options' });
      expect(fromDropdown).toBeInTheDocument();

      // EURC should be disabled in "From" dropdown (same as "To")
      const eurcOption = screen.getByRole('option', { name: /EURC/ });
      expect(eurcOption).toBeDisabled();

      // USDC is the current "From" selection; it is selectable (not disabled by duplicate rule)
      const usdcOption = screen.getByRole('option', { name: /USDC/ });
      expect(usdcOption).not.toBeDisabled();

      fireEvent.mouseDown(document.body); // close dropdown

      // Now test "To" dropdown - USDC should be disabled (same as "From")
      fireEvent.click(screen.getByLabelText('To: EURC'));
      
      const toDropdown = screen.getByRole('listbox', { name: 'To token options' });
      expect(toDropdown).toBeInTheDocument();

      const toUsdcOption = screen.getByRole('option', { name: /USDC/ });
      expect(toUsdcOption).toBeDisabled();

      const toEurcOption = screen.getByRole('option', { name: /EURC/ });
      expect(toEurcOption).toBeDisabled();
    });
  });
});