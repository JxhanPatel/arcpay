import fs from 'fs';
import path from 'path';

const appPath = path.resolve(process.cwd(), 'src/App.tsx');
let content = fs.readFileSync(appPath, 'utf8');

// 1. Modify useEffect mount to load active account index
content = content.replace(
  `// Initialize wallet state on mount
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
  }, [provider]);`,
  `// Initialize wallet state on mount
  useEffect(() => {
    // Sync account metadata state on mount
    setAccounts(getStoredAccountsMeta());
    const activeIndex = getActiveAccountIndex();
    setActiveAccountIndexState(activeIndex);

    // Check for any derived account keystore first (encrypted wallet)
    const accountsMeta = getStoredAccountsMeta();
    const targetIndex = accountsMeta.length > 0 ? activeIndex : null;
    const keystore = targetIndex !== null ? getKeystoreForAccount(targetIndex) : getKeystoreFromStorage();
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
  }, [provider]);`
);

// 2. Modify handleUnlock to use active account keystore
content = content.replace(
  `  // Handle wallet unlock with PIN
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
  };`,
  `  // Handle wallet unlock with PIN
  const handleUnlock = async (pin: string) => {
    setIsProcessing(true);
    setUnlockError(null);

    try {
      const activeIndex = getActiveAccountIndex();
      const keystore = getKeystoreForAccount(activeIndex) ?? getKeystoreFromStorage();
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
  };`
);

// 3. Modify handleMigrate to create initial account metadata
content = content.replace(
  `      // Create encrypted keystore
      const keystore = await encryptWallet(legacyKey, migrationPin);
      setKeystoreInStorage(keystore);

      // Remove legacy key
      localStorage.removeItem(STORAGE_KEY_LEGACY);`,
  `      // Create encrypted keystore for the first account
      const keystore = await encryptWallet(legacyKey, migrationPin);
      setKeystoreInStorage(keystore);
      // Migration always represents account 0
      saveAccountsMeta([{ index: 0, label: 'Account 1', address: new ethers.Wallet(legacyKey).address }]);
      setActiveAccountIndex(0);
      setAccounts(getStoredAccountsMeta());
      setActiveAccountIndexState(0);

      // Remove legacy key
      localStorage.removeItem(STORAGE_KEY_LEGACY);`
);

// 4. Modify finalizeCreateWallet to derive account 0 and store metadata
content = content.replace(
  `    try {
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
  };`,
  `    try {
      // Encrypt immediately - never write plaintext to storage
      const keystore = await encryptWallet(pendingWalletData.privateKey, pin);
      setKeystoreInStorage(keystore);
      // Account 0 metadata for new wallet creation
      saveAccountsMeta([{ index: 0, label: 'Account 1', address: pendingWalletData.wallet.address }]);
      setActiveAccountIndex(0);
      setAccounts(getStoredAccountsMeta());
      setActiveAccountIndexState(0);

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
  };`
);

// 5. Modify finalizeImportWallet to create initial account metadata
content = content.replace(
  `    try {
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
  };`,
  `    try {
      // Encrypt immediately - never write plaintext to storage
      const keystore = await encryptWallet(pendingWalletData.privateKey, pin);
      setKeystoreInStorage(keystore);
      // Imported wallet starts as account 0
      saveAccountsMeta([{ index: 0, label: 'Account 1', address: pendingWalletData.wallet.address }]);
      setActiveAccountIndex(0);
      setAccounts(getStoredAccountsMeta());
      setActiveAccountIndexState(0);

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
  };`
);

// 6. Modify handleLock to clear active wallet session (not stored data)
content = content.replace(
  `  // Handle lock - preserve keystore, just clear state
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
  };`,
  `  // Handle lock - preserve keystore, just clear state
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
    // Clear mnemonic from any in-memory session state
    setPendingMnemonic(null);
  };`
);

fs.writeFileSync(appPath, content, 'utf8');
console.log('App.tsx updated');
