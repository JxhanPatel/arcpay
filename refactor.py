import re

with open('/workspaces/arcpay/src/App.tsx', 'r') as f:
    content = f.read()

# 1. Add pinVault imports
pinVault_import = """import {
  decryptPrivateKeyWithPin,
  encryptPrivateKeyWithPin,
  getVaultFromStorage,
  removeVaultFromStorage,
  setVaultInStorage,
} from './utils/pinVault';"""

content = content.replace(
    "import { resolveArcName } from './utils/arcName';",
    f"import {{ resolveArcName }} from './utils/arcName';\n{pinVault_import}"
)

# 2. Remove PinInput component
content = re.sub(
    r'// PIN Input component\nconst PinInput = \(\{[\s\S]*?\}\);\n',
    '',
    content
)

# 3. Add PasscodePad component before `function App()`
passcode_pad = """
type PasscodeMode = 'create' | 'confirm' | 'unlock';

const PasscodePad = ({
  mode,
  error,
  onComplete,
}: {
  mode: PasscodeMode;
  error?: string | null;
  onComplete: (pin: string) => void;
}) => {
  const [digits, setDigits] = useState<string[]>([]);
  const [isShaking, setIsShaking] = useState(false);

  useEffect(() => {
    if (error) {
      setIsShaking(true);
      setDigits([]);
      const t = setTimeout(() => setIsShaking(false), 400);
      return () => clearTimeout(t);
    }
  }, [error]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') {
        addDigit(e.key);
      } else if (e.key === 'Backspace') {
        removeDigit();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [digits]);

  const addDigit = (d: string) => {
    if (digits.length >= 4) return;
    const next = [...digits, d];
    setDigits(next);
    if (next.length === 4) {
      setTimeout(() => onComplete(next.join('')), 200);
    }
  };

  const removeDigit = () => {
    if (digits.length === 0) return;
    setDigits(digits.slice(0, -1));
  };

  const title = mode === 'create' ? 'Create your passcode' : mode === 'confirm' ? 'Confirm your passcode' : 'Enter your passcode';

  const keys = ['1','2','3','4','5','6','7','8','9','','0','back'];

  return (
    <div className="min-h-screen bg-[#050505] text-[#FAFAFA] flex items-center justify-center px-4 py-10">
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 right-0 h-72 w-72 rounded-full bg-blue-600/10 blur-3xl" />
      </div>
      <div className="relative w-full max-w-md rounded-2xl border border-[#27272A] bg-[#121212]/80 p-8 shadow-[0_0_80px_rgba(0,0,0,0.35)] backdrop-blur-md flex flex-col items-center">
        <div className="mb-8 flex items-center gap-3">
          <div className="rounded-full border border-[#27272A] bg-[#161616] p-2">
            <Lock className="h-5 w-5 text-[#3B82F6]" />
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-[0.3em] text-[#A1A1AA]">Secure</p>
            <h1 className="text-xl font-semibold tracking-tight text-[#FAFAFA]">{title}</h1>
          </div>
        </div>

        {error && <p className="mb-4 text-xs text-red-400">{error}</p>}

        <div className={`flex gap-4 mb-10 ${isShaking ? 'animate-shake' : ''}`}>
          {[0,1,2,3].map(i => (
            <div 
              key={i} 
              className={`h-11 w-11 rounded-full border transition-transform duration-150 ${
                digits.length > i 
                  ? 'bg-[#3B82F6] border-[#3B82F6]' 
                  : 'bg-transparent border-[#27272A]'
              }`}
              style={digits.length > i ? { transform: 'scale(1.08)' } : {}}
            />
          ))}
        </div>

        <div className="grid grid-cols-3 gap-4 w-full max-w-[280px]">
          {keys.map((k, i) => {
            if (k === '') return <div key={i} />;
            if (k === 'back') {
              return (
                <button 
                  key={i} 
                  onClick={removeDigit}
                  className="flex items-center justify-center h-16 rounded-xl border border-[#27272A] bg-[#161616] text-[#FAFAFA] text-2xl font-light hover:border-[#3B82F6] transition"
                >
                  <X className="h-6 w-6" />
                </button>
              );
            }
            return (
              <button 
                key={i} 
                onClick={() => addDigit(k)}
                className="flex items-center justify-center h-16 rounded-xl border border-[#27272A] bg-[#161616] text-[#FAFAFA] text-2xl font-light hover:border-[#3B82F6] transition"
              >
                {k}
              </button>
            );
          })}
        </div>
        
        {mode === 'unlock' && (
          <button
            onClick={() => {
              // This destroys the wallet locally and the user needs their seed phrase/key to recover.
              if (window.confirm('This will destroy the wallet locally. You will need your seed phrase or private key to recover. Continue?')) {
                removeVaultFromStorage();
                window.location.reload();
              }
            }}
            className="mt-8 text-xs text-[#A1A1AA] hover:text-[#FAFAFA] underline"
          >
            Forgot passcode? Reset wallet
          </button>
        )}
      </div>
    </div>
  );
};

"""

content = content.replace('function App() {', passcode_pad + 'function App() {')

# 4. Update State
old_states = [
    r'const \[isUnlocking, setIsUnlocking\] = useState\(false\);\n',
    r'const \[isMigrating, setIsMigrating\] = useState\(false\);\n',
    r'const \[unlockPin, setUnlockPin\] = useState\(\'\'\);\n',
    r'const \[unlockError, setUnlockError\] = useState<string \| null>\(null\);\n',
    r'const \[migrationPin, setMigrationPin\] = useState\(\'\'\);\n',
    r'const \[migrationPinConfirm, setMigrationPinConfirm\] = useState\(\'\'\);\n',
    r'const \[migrationError, setMigrationError\] = useState<string \| null>\(null\);\n',
    r'const \[showCreatePin, setShowCreatePin\] = useState\(false\);\n',
    r'const \[createPin, setCreatePin\] = useState\(\'\'\);\n',
    r'const \[createPinConfirm, setCreatePinConfirm\] = useState\(\'\'\);\n',
    r'const \[createPinError, setCreatePinError\] = useState<string \| null>\(null\);\n',
]
for s in old_states:
    content = re.sub(s, '', content)

new_states = """  const [appState, setAppState] = useState<'loading' | 'unlock' | 'create-passcode' | 'confirm-passcode' | 'setup' | 'dashboard'>('loading');
  const [passcodeError, setPasscodeError] = useState<string | null>(null);
  const [pinDraft, setPinDraft] = useState<string>('');
  const [pendingPrivateKey, setPendingPrivateKey] = useState<string | null>(null);
  const [pendingWallet, setPendingWallet] = useState<ArcWallet | null>(null);
  const [isLegacyMigration, setIsLegacyMigration] = useState(false);
"""
content = content.replace("  const [isProcessing, setIsProcessing] = useState(false);", new_states + "  const [isProcessing, setIsProcessing] = useState(false);")

# 5. Update Mount Effect
old_mount = r"""  // Initialize wallet state on mount
  useEffect\(\(\) => \{[\s\S]*?// No wallet found, show create/import screen\n  \}, \[provider\]\);"""

new_mount = """  // Initialize wallet state on mount
  useEffect(() => {
    // Sync account metadata state on mount
    setAccounts(getStoredAccountsMeta());
    const activeIndex = getActiveAccountIndex();
    setActiveAccountIndexState(activeIndex);

    const vault = getVaultFromStorage();
    if (vault) {
      setAppState('unlock');
      return;
    }

    const legacy = localStorage.getItem(STORAGE_KEY_LEGACY);
    if (legacy) {
      localStorage.removeItem(STORAGE_KEY_LEGACY);
      setPendingPrivateKey(legacy);
      setPendingWallet(new ethers.Wallet(legacy).connect(provider));
      setAppState('create-passcode');
      setIsLegacyMigration(true);
      return;
    }

    setAppState('setup');
  }, [provider]);"""

content = re.sub(old_mount, new_mount, content)

# 6. Update handleUnlock
old_unlock = r"""  // Handle wallet unlock with PIN
  const handleUnlock = async \(pin: string\) => \{[\s\S]*?  \};"""

new_unlock = """  // Handle wallet unlock with PIN
  const handleUnlock = async (pin: string) => {
    setIsProcessing(true);
    setPasscodeError(null);

    try {
      const vault = getVaultFromStorage();
      if (!vault) throw new Error('No vault');
      
      const decryptedKey = await decryptPrivateKeyWithPin(vault, pin);
      const activeIndex = getActiveAccountIndex();
      const keystore = getKeystoreForAccount(activeIndex);
      
      let connectedWallet: ArcWallet;
      if (keystore) {
        const decryptedWallet = await decryptWallet(keystore, pin);
        connectedWallet = decryptedWallet.connect(provider);
      } else {
        connectedWallet = new ethers.Wallet(decryptedKey).connect(provider);
      }

      const sessionMnemonic = (connectedWallet as { mnemonic?: { phrase?: string } }).mnemonic?.phrase;
      setActiveSessionSeed(typeof sessionMnemonic === 'string' && sessionMnemonic ? sessionMnemonic : null);
      sessionPinRef.current = pin;
      setWallet(connectedWallet);
      setAppState('dashboard');
      void refreshWalletData(connectedWallet);

      const legacyKeystore = getKeystoreFromStorage();
      if (legacyKeystore && !getKeystoreForAccount(0)) {
        migrateLegacyKeystoreToIndexZero(legacyKeystore, connectedWallet.address);
        setAccounts(getStoredAccountsMeta());
      }
    } catch (err) {
      setPasscodeError('Incorrect passcode');
    } finally {
      setIsProcessing(false);
    }
  };"""

content = re.sub(old_unlock, new_unlock, content)

# 7. Remove handleMigrate
content = re.sub(r'  // Handle migration from legacy plaintext key to encrypted keystore\n  const handleMigrate = async \(\) => \{[\s\S]*?  \};\n', '', content)

# 8. Update handleCreateWallet
old_create = r"""  // Handle new wallet creation - show mnemonic first, then PIN
  const handleCreateWallet = async \(\) => \{[\s\S]*?  \};"""

new_create = """  // Handle new wallet creation - show mnemonic first, then PIN
  const handleCreateWallet = async () => {
    setIsProcessing(true);
    setError(null);
    
    try {
      const created = ethers.Wallet.createRandom().connect(provider);
      const privateKeyValue = created.privateKey;

      const mnemonic = created.mnemonic?.phrase;
      if (mnemonic) {
        setPendingMnemonic(mnemonic);
        setPendingSessionSeed(mnemonic);
        setShowMnemonicReveal(true);
      }

      setPendingPrivateKey(privateKeyValue);
      setPendingWallet(created);
    } catch (err) {
      setError('Wallet creation failed');
    } finally {
      setIsProcessing(false);
    }
  };"""

content = re.sub(old_create, new_create, content)

# 9. Remove finalizeCreateWallet and finalizeImportWallet, replace with handlePasscodeComplete
old_finalize = r"""  // Finalize wallet creation after PIN is set
  const finalizeCreateWallet = async \(pin: string\) => \{[\s\S]*?  \};

  // Handle import wallet with PIN
  const handleImportWallet = async \(\) => \{[\s\S]*?  \};

  // Finalize wallet import after PIN is set
  const finalizeImportWallet = async \(pin: string\) => \{[\s\S]*?  \};"""

new_finalize = """  // Handle import wallet with PIN
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

        const vault = await encryptPrivateKeyWithPin(pendingPrivateKey, pin);
        setVaultInStorage(vault);

        const keystore = await encryptWallet(pendingPrivateKey, pin);
        setKeystoreInStorage(keystore);
        setKeystoreForAccount(0, keystore);
        
        saveAccountsMeta([{ index: 0, label: 'Account 1', address: pendingWallet.address }]);
        setActiveAccountIndex(0);
        setAccounts(getStoredAccountsMeta());
        setActiveAccountIndexState(0);

        setWallet(pendingWallet);
        setActiveSessionSeed(pendingSessionSeed);
        setPendingSessionSeed(null);
        sessionPinRef.current = pin;
        
        setPendingPrivateKey(null);
        setPendingWallet(null);
        setPinDraft('');
        setIsLegacyMigration(false);
        
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
  };"""

content = re.sub(old_finalize, new_finalize, content)

# 10. Update handleLock
old_lock = r"""  // Handle lock - preserve keystore, just clear state
  const handleLock = \(\) => \{[\s\S]*?  \};"""

new_lock = """  // Handle lock - preserve keystore, just clear state
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
    setActiveSessionSeed(null);
    setPendingSessionSeed(null);
    sessionPinRef.current = '';
  };"""

content = re.sub(old_lock, new_lock, content)

# 11. Update handleConfirmMnemonicSave
old_confirm_mnemonic = r"""  const handleConfirmMnemonicSave = \(\) => \{[\s\S]*?  \};"""
new_confirm_mnemonic = """  const handleConfirmMnemonicSave = () => {
    setPendingMnemonic(null);
    setShowMnemonicReveal(false);
    setAppState('create-passcode');
    setPasscodeError(null);
  };"""
content = re.sub(old_confirm_mnemonic, new_confirm_mnemonic, content)

# 12. Update Render Logic
content = re.sub(r'  // Unlock screen - shown when keystore exists\n  if \(isUnlocking\) \{[\s\S]*?  \}\n', '', content)
content = re.sub(r'  // Migration screen - shown when legacy plaintext key exists\n  if \(isMigrating\) \{[\s\S]*?  \}\n', '', content)
content = re.sub(r'  // Create PIN modal for new wallet creation/import\n  if \(showCreatePin\) \{[\s\S]*?  \}\n', '', content)

passcode_render = """  if (appState === 'unlock') {
    return <PasscodePad mode="unlock" error={passcodeError} onComplete={handlePasscodeComplete} />;
  }

  if (appState === 'create-passcode') {
    return <PasscodePad mode="create" error={passcodeError} onComplete={handlePasscodeComplete} />;
  }

  if (appState === 'confirm-passcode') {
    return <PasscodePad mode="confirm" error={passcodeError} onComplete={handlePasscodeComplete} />;
  }

"""
content = content.replace('  // Mnemonic reveal screen - shown immediately after wallet creation', passcode_render + '  // Mnemonic reveal screen - shown immediately after wallet creation')

content = content.replace('  // No wallet - show create/import screen\n  if (!wallet) {', '  // No wallet - show create/import screen\n  if (appState === \'setup\' && !wallet) {')

content = content.replace('  return (\n    <div className="min-h-screen bg-[#050505] text-[#FAFAFA] px-4 py-5 pb-28 sm:px-6 lg:px-8">', '  if (appState !== \'dashboard\' && !wallet) return null;\n\n  return (\n    <div className="min-h-screen bg-[#050505] text-[#FAFAFA] px-4 py-5 pb-28 sm:px-6 lg:px-8">')

# 13. Update Danger Zone remove wallet
old_danger = r"""                          removeAllAccountData\(\);\n                          localStorage\.removeItem\(STORAGE_KEY_LEGACY\);\n                          removeKeystoreFromStorage\(\);"""
new_danger = """                          removeAllAccountData();
                          localStorage.removeItem(STORAGE_KEY_LEGACY);
                          removeKeystoreFromStorage();
                          removeVaultFromStorage();"""
content = re.sub(old_danger, new_danger, content)

content = content.replace("setIsUnlocking(false);\n                          setIsMigrating(false);", "setAppState('setup');")

with open('/workspaces/arcpay/src/App.tsx', 'w') as f:
    f.write(content)
