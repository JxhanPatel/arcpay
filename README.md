# ArcPay 

> A seamless, UPI-inspired Web3 personal payments application built on the **Arc Network Testnet**. Pay anyone instantly using human-readable identities and stablecoins, with zero crypto friction.



## Overview

**ArcPay** bridges the gap between Web2 payment simplicity (like UPI, Venmo, or Pix) and Web3 technology. By leveraging the **Arc Network's** sub-second finality and native USDC gas capabilities, ArcPay eliminates the UX friction points traditional crypto wallets face: long strings of hex addresses, volatile gas tokens, and slow transaction confirmations.

### Key Features

* **Scan to Pay:** Scan static or dynamic QR codes to automatically pull handles, amounts, and metadata.
* **ArcNames Integration (`.arc`):** No more copy-pasting `0x...` addresses. Enter a handle like `jxhan.arc` and the app resolves it natively on-chain.
* **Request Money (Pull via QR):** Generate dynamic QR codes embedded with request parameters (`amount`, `note`) for split bills or merchant checkouts.
* **Gasless Experience:** Powered by Circle Paymaster sponsorship, allowing users to pay zero network fees.
* **No Seed Phrases:** Embedded non-custodial onboarding powered by Circle Programmable Wallets (W3S) using device biometrics (FaceID/TouchID).



## Tech Stack

* **Frontend (Mobile):** React Native, Expo, NativeWind (Tailwind CSS)
* **Web3 Client Layer:** Viem, TanStack Query (v5)
* **Identity Resolution:** ArcNames Protocol Registry
* **Embedded Wallets:** Circle Programmable Wallets SDK
* **Network Infrastructure:** Arc Network Testnet (RPC: `[https://rpc.testnet.arc.network](https://rpc.testnet.arc.network)`)



## How It Works: Architecture & Schemes

ArcPay utilizes standard deep links to make QR codes scannable by regular smartphone cameras or the built-in app scanner.

### Deep Link Payload Formats

* **P2P Peer Lookup (Static QR):**
`arcpay://pay?id=jxhan.arc`
* **Request Payment (Dynamic QR):**
`arcpay://request?id=bob.arc&amount=12.50&note=DinnerSplit`

### Transaction Resolution Flow

```
[ Scan QR / Type ID ] ──> [ Extract "jxhan.arc" ]
                                  │
                                  ▼
[ User confirms ]    <─── [ Resolve EVM Address via ArcNames ]
        │
        ▼
[ Sign & Send ] ───> [ Arc Network (Instant Settlement via USDC) ]

```


## License

Distributed under the MIT License. See `LICENSE` for more information.
