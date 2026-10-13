Task brief for Task 1
Read this first — it is your requirements
===================================== 

**Task 1**: Fix the swap crash with "value out-of-bounds (argument="amountOutMinimum", value=-9800)"

## Requirements:

1. In src/swap.ts, the slippage multiplier must equal (1 - slippageTolerance)
   (for default 1%, must be 0.99), never negative.

2. Compute with BigInt: const slippageBps = BigInt(Math.round(slippageTolerance * 1e6))
   const minOutputBn = outputAmountBn * (1000000n - slippageBps) / 1000000n

3. getSwapQuote must never emit negative outputAmount.
   If outputAmountBn <= 0, throw: "Unable to determine a positive swap output"

4. In src/components/Swap.tsx, add guard around amountOutMinimum:
   if amountOutMinimum <= 0n, throw error and do not call exactInput.

5. Do not apply slippage a second time in Swap.tsx.
   Pass quote's output amount (converted to base units) directly as amountOutMinimum.

## Context:
- The bug is in src/swap.ts line 249: slippage calculation
- Fix: outputAmountBn * 0.99, not outputAmountBn * (-0.99)
- Current swap.ts line 249: const minOutputBn = outputAmountBn * (1n - BigInt(Math.round(slippageTolerance * 1e6))) / 1000000n
- Expected fix: const slippageBps = BigInt(Math.round(slippageTolerance * 1e6));
  const minOutputBn = outputAmountBn * (1000000n - slippageBps) / 1000000n

## Existing code patterns to follow:
- Use ethers.parseUnits/ether.formatUnits for amount conversions
- Use getAssetDecimals() for token decimals
- Follow existing error message patterns (e.g., 'Swap amount cannot be empty')

## Files to modify:
- src/swap.ts (lines 247-250)
- src/components/Swap.tsx (lines 204-207)

## Tests to add/update:
- src/swap.test.ts: Non-negative outputAmount test
- src/swap.test.ts: Correct slippage math test
- src/swap.test.ts: Negative output guard test
- src/components/ui/Swap.test.tsx: amountOutMinimum <= 0n guard test

## Reporting:
Create report file: task-1-report.md
Report status, commits, test summary, and concerns.

