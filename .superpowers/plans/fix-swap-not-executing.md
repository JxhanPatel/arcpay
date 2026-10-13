# Fix Swap Execution - Make the swap button actually execute the swap transaction

## Problem
The swap button in the Swap component shows a quote and allows clicking "Swap", but it only calls `onSwapSuccess()` as a placeholder without actually executing the blockchain transaction to swap tokens. The user sees the button working visually, but no actual token swap occurs on-chain.

Task 1: Implement actual swap transaction execution in handleSwap

## Requirements
1. When the user clicks the "Swap" button after getting a quote, the actual swap transaction should be executed
2. The swap execution should:
   - Use the `buildSwapTransactionPlan` to create a transaction plan from the quote
   - Execute the transaction using `wallet.sendTransaction()`
   - Handle token approval if needed (using `buildTokenApprovalPlan`)
   - Only execute if all validations pass
   - Set loading states appropriately
   - Call `onSwapSuccess()` on successful execution
   - Show errors if the transaction fails

## Global Constraints
- Must follow the existing code patterns in the Swap component
- Must maintain the same loading/disabled state logic (`isLoading || !quote || !amount`)
- Must handle native USDC (which doesn't require approval) vs ERC-20 tokens (which do)
- Must use the existing `getTokenAddress` function from swap.ts
- Must use ethers.js for contract interactions
- Must preserve existing error handling patterns
- Must not break existing tests
- Should follow the same style as other transaction executions in the codebase

## Task
Implement the actual swap execution in the `handleSwap` function in `/home/jahanhero1010/arcpay/src/components/Swap.tsx`.

## Success Criteria
- Clicking the Swap button executes an actual blockchain transaction
- The transaction properly swaps tokens (not just calls onSuccess)
- Loading states work correctly during execution
- Errors are properly caught and displayed
- Approval is handled when needed (for EURC and cirBTC)
- Native USDC swaps work without approval
- All existing tests continue to pass