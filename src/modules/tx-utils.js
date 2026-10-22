import {
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__INSTRUCTION_ERROR__INSUFFICIENT_FUNDS,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE,
  SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_RENT,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  isSolanaError,
} from '@solana/kit';
import { STAKE_ERROR__EPOCH_REWARDS_ACTIVE } from '@solana-program/stake';

export const TX_MESSAGES = {
  cancelled: 'Transaction cancelled by user',
  insufficient: 'Insufficient balance for this transaction',
  expired: 'Transaction expired. Please try again',
  epochRewards: 'Staking is paused while this epoch\'s rewards are paid out (usually a few minutes). Please try again shortly',
  network: 'Network error. Check your connection and try again',
};

// The blockhash a signed transaction actually carries. Some wallets (Phantom)
// replace ours with a fresher one while the user decides.
export function readSignedBlockhash(wireBytes) {
  const { messageBytes } = getTransactionDecoder().decode(wireBytes);
  return getCompiledTransactionMessageDecoder().decode(messageBytes).lifetimeToken;
}

function errorChain(err) {
  const chain = [];
  for (let e = err; e && chain.length < 8; e = e.cause) chain.push(e);
  return chain;
}

// Plain-text errors: wallet extensions, fetch failures, our own throws.
function describeMessage(raw) {
  if (!raw) return null;
  const msg = String(raw);
  if (/user rejected|rejected the request|cancel/i.test(msg)) return TX_MESSAGES.cancelled;
  if (/custom program error: 0x10\b/i.test(msg)) return TX_MESSAGES.epochRewards;
  if (/insufficient (funds|lamports)|custom program error: 0x1\b/i.test(msg)) return TX_MESSAGES.insufficient;
  if (/blockhash not found|block height exceeded|expired/i.test(msg)) return TX_MESSAGES.expired;
  if (/already deactivated|not delegated/i.test(msg)) return 'This stake is already deactivated or not delegated';
  if (/stake is not active|merge mismatch/i.test(msg)) return 'Stakes must be in compatible states to merge';
  if (/too small|minimum delegation/i.test(msg)) return 'Amount is below the minimum required for staking';
  if (/network request failed|fetch failed|failed to fetch/i.test(msg)) return TX_MESSAGES.network;
  return null;
}

// Never echo RPC URLs or IPs back into the page.
function sanitize(msg) {
  return String(msg)
    .replace(/https?:\/\/[^\s,)]+/g, 'RPC')
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, '');
}

// Kit's production errors carry opaque messages ("Solana error #-32002;
// Decode this error by running ..."), so classify by error code along the
// cause chain the RPC client builds: preflight failure -> instruction error.
export function describeTxError(err) {
  const chain = errorChain(err);

  for (const e of chain) {
    if (isSolanaError(e, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)
      && e.context.code === STAKE_ERROR__EPOCH_REWARDS_ACTIVE) {
      return TX_MESSAGES.epochRewards;
    }
    if (isSolanaError(e, SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND)) return TX_MESSAGES.expired;
    if (isSolanaError(e, SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE)
      || isSolanaError(e, SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_RENT)
      || isSolanaError(e, SOLANA_ERROR__INSTRUCTION_ERROR__INSUFFICIENT_FUNDS)) {
      return TX_MESSAGES.insufficient;
    }
    // The System program reports a short payer as a custom error whose code
    // other programs reuse; its log line is unambiguous.
    if (isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)
      && (e.context.logs ?? []).some(line => /insufficient (lamports|funds)/i.test(line))) {
      return TX_MESSAGES.insufficient;
    }
  }

  for (const e of chain) {
    if (isSolanaError(e)) continue;
    const described = describeMessage(e?.message);
    if (described) return described;
  }

  const custom = chain.find(e => isSolanaError(e, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM));
  if (custom) return `Transaction failed: program error 0x${Number(custom.context.code).toString(16)}`;
  const solanaErrors = chain.filter(e => isSolanaError(e));
  if (solanaErrors.length > 0) {
    // The innermost code is the most specific one, useful for support.
    const code = solanaErrors[solanaErrors.length - 1].context.__code;
    return isSolanaError(solanaErrors[0], SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)
      ? `The network rejected this transaction in simulation (error ${code})`
      : `Transaction failed (Solana error ${code})`;
  }

  const msg = sanitize(err?.message || 'Transaction failed');
  return msg.length > 100 ? `${msg.slice(0, 100)}...` : msg;
}
