import { describe, expect, test } from 'bun:test';
import {
  address,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getSolanaErrorFromJsonRpcError,
  getSolanaErrorFromTransactionError,
  getTransactionEncoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
} from '@solana/kit';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { buildDeactivateInstruction } from '../src/modules/stake-instructions.js';
import { TX_MESSAGES, describeTxError, readSignedBlockhash } from '../src/modules/tx-utils.js';

const STAKE = 'StakeAccount1111111111111111111111111111111';

// What kit throws when preflight simulation rejects a transaction.
function preflightFailure(err, logs = []) {
  return getSolanaErrorFromJsonRpcError({
    code: -32002,
    message: 'Transaction simulation failed',
    data: { err, logs, accounts: null, unitsConsumed: 0 },
  });
}

describe('transaction error messages', () => {
  test('explains the epoch-rewards lock instead of an opaque kit code', () => {
    expect(describeTxError(preflightFailure({ InstructionError: [1, { Custom: 16 }] })))
      .toBe(TX_MESSAGES.epochRewards);
    expect(describeTxError(new Error('custom program error: 0x10'))).toBe(TX_MESSAGES.epochRewards);
  });

  test('recognises a short balance from codes, logs and wallet text', () => {
    expect(describeTxError(getSolanaErrorFromTransactionError('InsufficientFundsForFee')))
      .toBe(TX_MESSAGES.insufficient);
    const systemShortfall = preflightFailure(
      { InstructionError: [0, { Custom: 1 }] },
      ['Transfer: insufficient lamports 1000, need 1002282880'],
    );
    expect(describeTxError(systemShortfall)).toBe(TX_MESSAGES.insufficient);
    expect(describeTxError(new Error('custom program error: 0x1'))).toBe(TX_MESSAGES.insufficient);
    // 0x11 is a different error, not "0x1".
    expect(describeTxError(new Error('custom program error: 0x11'))).not.toBe(TX_MESSAGES.insufficient);
  });

  test('maps expiry, cancellation and network failures', () => {
    expect(describeTxError(getSolanaErrorFromTransactionError('BlockhashNotFound'))).toBe(TX_MESSAGES.expired);
    expect(describeTxError(new Error(TX_MESSAGES.expired))).toBe(TX_MESSAGES.expired);
    expect(describeTxError({ code: 4001, message: 'User rejected the request.' })).toBe(TX_MESSAGES.cancelled);
    expect(describeTxError(new TypeError('Failed to fetch'))).toBe(TX_MESSAGES.network);
  });

  test('falls back to a short code, never kit\'s decode instructions or RPC URLs', () => {
    const mergeMismatch = describeTxError(preflightFailure({ InstructionError: [0, { Custom: 6 }] }));
    expect(mergeMismatch).toBe('Transaction failed: program error 0x6');
    expect(describeTxError(preflightFailure('SignatureFailure')))
      .toMatch(/^The network rejected this transaction in simulation \(error \d+\)$/);
    const leaky = describeTxError(new Error('request to https://rpc.example.com/?api-key=secret failed'));
    expect(leaky).not.toContain('example.com');
    expect(leaky).not.toContain('secret');
  });
});

describe('signed blockhash', () => {
  test('reads the blockhash the wallet actually signed', async () => {
    const wallet = Keypair.generate();
    const walletSigner = createNoopSigner(address(wallet.publicKey.toBase58()));
    const ours = blockhash((await generateKeyPairSigner()).address);
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      m => setTransactionMessageFeePayerSigner(walletSigner, m),
      m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: ours, lastValidBlockHeight: 1n }, m),
      m => appendTransactionMessageInstructions([buildDeactivateInstruction({ stakeAddress: STAKE, walletSigner })], m),
    );
    const wireBytes = new Uint8Array(getTransactionEncoder().encode(await partiallySignTransactionMessageWithSigners(message)));
    expect(readSignedBlockhash(wireBytes)).toBe(ours);

    // A wallet that refreshes the blockhash before signing (as Phantom may).
    const refreshed = (await generateKeyPairSigner()).address;
    const tx = VersionedTransaction.deserialize(wireBytes);
    tx.message.recentBlockhash = refreshed;
    tx.sign([wallet]);
    expect(readSignedBlockhash(tx.serialize())).toBe(refreshed);
  });
});
