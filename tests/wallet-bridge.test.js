import { describe, expect, test } from 'bun:test';
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
} from '@solana/kit';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { buildCreateAndDelegateInstructions } from '../src/modules/stake-instructions.js';

const VOTE = '6cvBCfFXugkTqgSFVPvzhoWaLbhHWvZfSsZadWP5rryR';

// staking.js hands kit-encoded wire bytes to wallet.signTransaction() through
// a web3.js VersionedTransaction. This pins that bridge across dependency
// updates: the wallet signature must land in the fee-payer slot without
// disturbing the message or the new stake account's partial signature.
describe('wallet signing bridge', () => {
  test('round-trips a kit v0 stake transaction through VersionedTransaction', async () => {
    const wallet = Keypair.generate();
    const walletAddress = address(wallet.publicKey.toBase58());
    const walletSigner = createNoopSigner(walletAddress);
    const stakeSigner = await generateKeyPairSigner();
    const recentBlockhash = blockhash((await generateKeyPairSigner()).address);

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      m => setTransactionMessageFeePayerSigner(walletSigner, m),
      m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: recentBlockhash, lastValidBlockHeight: 1n }, m),
      m => appendTransactionMessageInstructions(buildCreateAndDelegateInstructions({
        walletAddress,
        walletSigner,
        stakeSigner,
        voteAddress: VOTE,
        depositLamports: 1_000_000_000n,
        rentLamports: 2_282_880n,
      }), m),
    );
    const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
    const wireBytes = new Uint8Array(getTransactionEncoder().encode(partiallySigned));

    // What signViaWallet() does, with the wallet extension simulated by a keypair.
    const bridged = VersionedTransaction.deserialize(wireBytes);
    bridged.sign([wallet]);
    const signed = getTransactionDecoder().decode(bridged.serialize());

    expect(new Uint8Array(signed.messageBytes)).toEqual(new Uint8Array(partiallySigned.messageBytes));
    expect(signed.signatures[stakeSigner.address]).toEqual(partiallySigned.signatures[stakeSigner.address]);
    const walletPublicKey = await getPublicKeyFromAddress(walletAddress);
    expect(await verifySignature(walletPublicKey, signed.signatures[walletAddress], signed.messageBytes)).toBe(true);
  });
});
