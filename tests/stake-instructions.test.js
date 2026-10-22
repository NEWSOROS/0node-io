import { describe, expect, test } from 'bun:test';
import { AccountRole, address, createNoopSigner, generateKeyPairSigner } from '@solana/kit';
import {
  STAKE_PROGRAM_ADDRESS,
  getDeactivateInstructionDataDecoder,
  getDelegateStakeInstructionDataDecoder,
  getInitializeInstructionDataDecoder,
  getMergeInstructionDataDecoder,
  getSplitInstructionDataDecoder,
  getWithdrawInstructionDataDecoder,
} from '@solana-program/stake';
import {
  SYSTEM_PROGRAM_ADDRESS,
  getCreateAccountInstructionDataDecoder,
} from '@solana-program/system';
import {
  STAKE_ACCOUNT_SPACE,
  buildCreateAndDelegateInstructions,
  buildDeactivateInstruction,
  buildDelegateInstruction,
  buildMergeInstruction,
  buildSplitInstructions,
  buildWithdrawInstruction,
} from '../src/modules/stake-instructions.js';

const WALLET = '11111111111111111111111111111111';
const VOTE = '6cvBCfFXugkTqgSFVPvzhoWaLbhHWvZfSsZadWP5rryR';
const STAKE_ONE = 'Stake11111111111111111111111111111111111111';
const STAKE_TWO = 'Vote111111111111111111111111111111111111111';

describe('stake instruction builders', () => {
  test('builds create + initialize + delegate with decoded values', async () => {
    const walletSigner = createNoopSigner(address(WALLET));
    const stakeSigner = await generateKeyPairSigner();
    const instructions = buildCreateAndDelegateInstructions({
      walletAddress: WALLET,
      walletSigner,
      stakeSigner,
      voteAddress: VOTE,
      depositLamports: 1_000_000_000n,
      rentLamports: 2_282_880n,
    });

    expect(instructions).toHaveLength(3);
    expect(instructions.map(instruction => instruction.programAddress)).toEqual([
      SYSTEM_PROGRAM_ADDRESS,
      STAKE_PROGRAM_ADDRESS,
      STAKE_PROGRAM_ADDRESS,
    ]);
    const createData = getCreateAccountInstructionDataDecoder().decode(instructions[0].data);
    expect(createData.lamports).toBe(1_002_282_880n);
    expect(createData.space).toBe(STAKE_ACCOUNT_SPACE);
    expect(() => getInitializeInstructionDataDecoder().decode(instructions[1].data)).not.toThrow();
    expect(() => getDelegateStakeInstructionDataDecoder().decode(instructions[2].data)).not.toThrow();
  });

  test('encodes every supported stake-management operation', async () => {
    const walletSigner = createNoopSigner(address(WALLET));
    const newStakeSigner = await generateKeyPairSigner();
    const delegate = buildDelegateInstruction({ stakeAddress: STAKE_ONE, voteAddress: VOTE, walletSigner });
    const deactivate = buildDeactivateInstruction({ stakeAddress: STAKE_ONE, walletSigner });
    const withdraw = buildWithdrawInstruction({
      stakeAddress: STAKE_ONE,
      walletAddress: WALLET,
      walletSigner,
      lamports: 1_002_282_880n,
    });
    const split = buildSplitInstructions({
      stakeAddress: STAKE_ONE,
      walletSigner,
      newStakeSigner,
      lamports: 1_000_000_000n,
      rentLamports: 2_282_880n,
    });
    const merge = buildMergeInstruction({
      destinationAddress: STAKE_ONE,
      sourceAddress: STAKE_TWO,
      walletSigner,
    });

    expect(() => getDelegateStakeInstructionDataDecoder().decode(delegate.data)).not.toThrow();
    expect(() => getDeactivateInstructionDataDecoder().decode(deactivate.data)).not.toThrow();
    expect(getWithdrawInstructionDataDecoder().decode(withdraw.data).args).toBe(1_002_282_880n);
    expect(split).toHaveLength(2);
    expect(() => getCreateAccountInstructionDataDecoder().decode(split[0].data)).not.toThrow();
    expect(getSplitInstructionDataDecoder().decode(split[1].data).args).toBe(1_000_000_000n);
    expect(() => getMergeInstructionDataDecoder().decode(merge.data)).not.toThrow();
  });

  // Stake program v5 no longer needs the Clock / Rent / StakeHistory sysvars
  // or StakeConfig; these minimal lists were dry-run on mainnet with
  // simulateTransaction before adopting @solana-program/stake 0.11.
  test('passes only the accounts the stake program reads', async () => {
    const walletSigner = createNoopSigner(address(WALLET));
    const newStakeSigner = await generateKeyPairSigner();
    const roles = instruction => instruction.accounts.map(account => [account.address, account.role]);
    const { WRITABLE, READONLY, READONLY_SIGNER, WRITABLE_SIGNER } = AccountRole;

    const [create, initialize, delegate] = buildCreateAndDelegateInstructions({
      walletAddress: WALLET,
      walletSigner,
      stakeSigner: newStakeSigner,
      voteAddress: VOTE,
      depositLamports: 1_000_000_000n,
      rentLamports: 1_666_240n,
    });
    expect(roles(create)).toEqual([[WALLET, WRITABLE_SIGNER], [newStakeSigner.address, WRITABLE_SIGNER]]);
    expect(roles(initialize)).toEqual([[newStakeSigner.address, WRITABLE]]);
    expect(roles(delegate)).toEqual([[newStakeSigner.address, WRITABLE], [VOTE, READONLY], [WALLET, READONLY_SIGNER]]);

    expect(roles(buildDeactivateInstruction({ stakeAddress: STAKE_ONE, walletSigner })))
      .toEqual([[STAKE_ONE, WRITABLE], [WALLET, READONLY_SIGNER]]);
    expect(roles(buildWithdrawInstruction({ stakeAddress: STAKE_ONE, walletAddress: WALLET, walletSigner, lamports: 1n })))
      .toEqual([[STAKE_ONE, WRITABLE], [WALLET, WRITABLE], [WALLET, READONLY_SIGNER]]);
    const [, split] = buildSplitInstructions({
      stakeAddress: STAKE_ONE, walletSigner, newStakeSigner, lamports: 1_000_000_000n, rentLamports: 1_666_240n,
    });
    expect(roles(split)).toEqual([[STAKE_ONE, WRITABLE], [newStakeSigner.address, WRITABLE], [WALLET, READONLY_SIGNER]]);
    expect(roles(buildMergeInstruction({ destinationAddress: STAKE_ONE, sourceAddress: STAKE_TWO, walletSigner })))
      .toEqual([[STAKE_ONE, WRITABLE], [STAKE_TWO, WRITABLE], [WALLET, READONLY_SIGNER]]);
  });
});
