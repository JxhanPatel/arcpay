const fs = require('fs');

const filePath = 'src/App.tsx';
let content = fs.readFileSync(filePath, 'utf8');

const helpers = `
  // --- Account management helpers ---
  const setActiveAccountIndexWithState = (index: number) => {
    setActiveAccountIndexState(index);
    setActiveAccountIndex(index);
  };

  const deriveAndAddAccount = async (pin: string) => {
    if (!wallet || !wallet.mnemonic) {
      throw new Error('No wallet session available');
    }

    const nextIndex = getNextDerivationIndex();
    const derived = deriveAccountAtIndex(wallet.mnemonic.phrase, nextIndex);
    const keystore = await encryptWallet(derived.privateKey, pin);
    const nextAccounts = [...accounts, { index: nextIndex, label: \`Account \${nextIndex + 1}\`, address: derived.address }];
    setKeystoreForAccount(nextIndex, keystore);
    saveAccountsMeta(nextAccounts);
    setAccounts(nextAccounts);
    setActiveAccountIndexWithState(nextIndex);

    const connectedWallet = new ethers.Wallet(derived.privateKey).connect(provider);
    setWallet(connectedWallet);
    void refreshWalletData(connectedWallet);
  };

  const switchAccount = async (index: number, pin: string) => {
    const keystore = getKeystoreForAccount(index);
    if (!keystore) {
      throw new Error('Keystore not found for this account');
    }

    const decrypted = await decryptWallet(keystore, pin);
    const connectedWallet = decrypted.connect(provider);
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

  const requestAccountPinAction = (
    action: { type: 'add' } | { type: 'switch'; index: number } | { type: 'remove'; index: number },
  ) => {
    setPendingAccountAction(action);
    setShowAccountPin(true);
    setAccountPin('');
    setAccountPinError(null);
  };

  const closeAccountPinModal = () => {
    setShowAccountPin(false);
    setAccountPin('');
    setAccountPinError(null);
    setPendingAccountAction(null);
  };

  const submitAccountPin = async () => {
    const pin = accountPin;
    if (!pendingAccountAction) return;

    setIsProcessing(true);
    setAccountPinError(null);

    try {
      if (pendingAccountAction.type === 'add') {
        await deriveAndAddAccount(pin);
      } else if (pendingAccountAction.type === 'switch') {
        await switchAccount(pendingAccountAction.index, pin);
      } else if (pendingAccountAction.type === 'remove') {
        const result = removeAccount(pendingAccountAction.index);
        if (result) {
          setAccounts(result.accounts);
          setActiveAccountIndexWithState(result.activeIndex);
          const nextKeystore = getKeystoreForAccount(result.activeIndex);
          if (nextKeystore) {
            const decrypted = await decryptWallet(nextKeystore, pin);
            const connectedWallet = decrypted.connect(provider);
            setWallet(connectedWallet);
            void refreshWalletData(connectedWallet);
          }
          setConfirmAccountRemoval(false);
          setRemovalTargetIndex(null);
        }
      }
      closeAccountPinModal();
    } catch (err) {
      setAccountPinError(err instanceof Error ? err.message : 'Invalid PIN or action failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const activeAccountLabel = useMemo(() => {
    return accounts.find((a) => a.index === activeAccountIndex)?.label ?? 'Account 1';
  }, [accounts, activeAccountIndex]);
  // --- End account management helpers ---
`;

const lockEndMarker = '  };\n\n\n\n  const openSendModal';
if (!content.includes('// --- Account management helpers ---')) {
  content = content.replace(
    lockEndMarker,
    '  };\n' + helpers + '\n\n\n\n  const openSendModal'
  );
}

const oldRemoval = `removeKeystoreFromStorage();
                          localStorage.removeItem(STORAGE_KEY_LEGACY);`;
const newRemoval = `removeAllAccountData();
                          localStorage.removeItem(STORAGE_KEY_LEGACY);
                          removeKeystoreFromStorage();`;
content = content.replace(oldRemoval, newRemoval);

const oldSettingsDanger = `              <div className="pt-4 border-t border-[#27272A]">
                <p className="text-[11px] uppercase tracking-[0.28em] text-red-400 mb-3">Danger Zone</p>`;

const accountsSection = `              <div className="pt-4 border-t border-[#27272A]">
                <p className="text-[11px] uppercase tracking-[0.28em] text-[#3B82F6] mb-3">Accounts</p>
                <div className="space-y-2">
                    {accounts.map((account) => {
                      const isActive = account.index === activeAccountIndex;
                      const isEditing = editingAccountIndex === account.index;
                      return (
                        <div
                          key={account.index}
                          className={\`flex items-center gap-2 rounded-2xl border px-3 py-2 \${
                            isActive
                              ? 'border-[#3B82F6]/50 bg-[#3B82F6]/10'
                              : 'border-[#27272A] bg-[#161616]'
                          }\`}
                        >
                          <div className="flex min-w-0 flex-1 flex-col">
                            {isEditing ? (
                              <input
                                autoFocus
                                value={editingAccountLabel}
                                onChange={(e) => setEditingAccountLabel(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    handleRenameAccount(account.index, editingAccountLabel);
                                    setEditingAccountIndex(null);
                                  }
                                  if (e.key === 'Escape') {
                                    setEditingAccountIndex(null);
                                  }
                                }}
                                onBlur={() => {
                                  handleRenameAccount(account.index, editingAccountLabel);
                                  setEditingAccountIndex(null);
                                }}
                                className="w-full rounded-lg border border-[#27272A] bg-[#0a0a0a] px-2 py-1 text-sm text-[#FAFAFA] outline-none"
                              />
                            ) : (
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-[#FAFAFA]">
                                  {account.label}
                                </span>
                                {isActive && (
                                  <span className="rounded-full bg-[#3B82F6]/20 px-2 py-0.5 text-[10px] font-medium text-[#93C5FD]">
                                    Active
                                  </span>
                                )}
                              </div>
                            )}
                            <span className="truncate font-mono text-[11px] text-[#A1A1AA]">
                              {account.address.slice(0, 6)}...{account.address.slice(-4)}
                            </span>
                          </div>
                          <button
                            onClick={() => {
                              setEditingAccountIndex(account.index);
                              setEditingAccountLabel(account.label);
                            }}
                            className="rounded-lg p-2 text-[#A1A1AA] transition hover:text-[#FAFAFA]"
                            aria-label="Rename account"
                            title="Rename"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                          </button>
                          {!isActive && (
                            <button
                              onClick={() => {
                                setRemovalTargetIndex(account.index);
                                setConfirmAccountRemoval(true);
                              }}
                              className="rounded-lg p-2 text-red-400 transition hover:text-red-300"
                              aria-label="Remove account"
                              title="Remove"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                          {!isActive && (
                            <button
                              onClick={() => requestAccountPinAction({ type: 'switch', index: account.index })}
                              className="rounded-lg bg-[#3B82F6] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[#2563EB]"
                            >
                              Switch
                            </button>
                          )}
                        </div>
                      );
                    })}
                    <button
                      onClick={() => requestAccountPinAction({ type: 'add' })}
                      className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-[#27272A] bg-[#161616] px-4 py-3 text-sm font-medium text-[#FAFAFA] transition hover:border-[#3B82F6]"
                    >
                      <Plus className="h-4 w-4" />
                      Add account
                    </button>
                  </div>
              </div>

              <div className="pt-4 border-t border-[#27272A]">
                <p className="text-[11px] uppercase tracking-[0.28em] text-red-400 mb-3">Danger Zone</p>`;

if (!content.includes('// --- Account management helpers ---')) {
  content = content.replace(oldSettingsDanger, accountsSection);
}

const settingsModalEnd = `      ) : null}\n\n      {showReceive ? (`;
const pinPromptModal = `      ) : null}\n\n      {showAccountPin ? (\n        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 px-4">\n          <div className="w-full max-w-md rounded-3xl border border-[#27272A] bg-[#121212] p-6 shadow-[0_0_80px_rgba(0,0,0,0.35)]">\n            <div className="flex items-center justify-between">\n              <h3 className="text-xl font-semibold">Confirm PIN</h3>\n              <button onClick={closeAccountPinModal} className="text-sm text-[#A1A1AA]">Close</button>\n            </div>\n            <p className="mt-2 text-sm text-[#A1A1AA]">\n              Enter your wallet PIN to {pendingAccountAction?.type === 'add'\n                ? 'add a new account'\n                : pendingAccountAction?.type === 'switch'\n                  ? 'switch accounts'\n                  : 'confirm this action'}.\n            </p>\n            <div className="mt-4 space-y-4">\n              <div>\n                <PinInput\n                  value={accountPin}\n                  onChange={setAccountPin}\n                  placeholder="Enter PIN"\n                  disabled={isProcessing}\n                  error={accountPinError}\n                />\n                {accountPinError && <p className="mt-2 text-sm text-red-400">{accountPinError}</p>}\n              </div>\n              <button\n                onClick={() => void submitAccountPin()}\n                disabled={isProcessing || accountPin.length === 0}\n                className="w-full flex items-center justify-center gap-2 rounded-xl bg-[#3B82F6] px-4 py-3 font-medium text-white transition hover:bg-[#2563EB] disabled:opacity-70"\n              >\n                {isProcessing ? (\n                  <>\n                    <LoaderCircle className="h-4 w-4 animate-spin" />\n                    Confirming…\n                  </>\n                ) : (\n                  'Confirm'\n                )}\n              </button>\n            </div>\n          </div>\n        </div>\n      ) : null}\n\n      {showReceive ? (`;

if (!content.includes('showAccountPin ? (')) {
  content = content.replace(settingsModalEnd, pinPromptModal);
}

fs.writeFileSync(filePath, content);
console.log('Updated', filePath);
