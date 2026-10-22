import { address } from '@solana/kit';
import {
  STAKE_PROGRAM_ADDRESS,
  getDeactivateInstruction,
  getDelegateStakeInstruction,
  getInitializeInstruction,
  getMergeInstruction,
  getSplitInstruction,
  getWithdrawInstruction,
} from '@solana-program/stake';
import { getCreateAccountInstruction } from '@solana-program/system';

export const STAKE_ACCOUNT_SPACE = 200n;

export function buildCreateAndDelegateInstructions({
  walletAddress,
  walletSigner,
  stakeSigner,
  voteAddress,
  depositLamports,
  rentLamports,
}) {
  return [
    getCreateAccountInstruction({
      payer: walletSigner,
      newAccount: stakeSigner,
      lamports: BigInt(depositLamports) + BigInt(rentLamports),
      space: STAKE_ACCOUNT_SPACE,
      programAddress: STAKE_PROGRAM_ADDRESS,
    }),
    getInitializeInstruction({
      stake: stakeSigner.address,
      arg0: { staker: address(walletAddress), withdrawer: address(walletAddress) },
      arg1: { unixTimestamp: 0, epoch: 0, custodian: address(walletAddress) },
    }),
    buildDelegateInstruction({
      stakeAddress: stakeSigner.address,
      voteAddress,
      walletSigner,
    }),
  ];
}

export function buildDelegateInstruction({ stakeAddress, voteAddress, walletSigner }) {
  return getDelegateStakeInstruction({
    stake: address(stakeAddress),
    vote: address(voteAddress),
    stakeAuthority: walletSigner,
  });
}

export function buildDeactivateInstruction({ stakeAddress, walletSigner }) {
  return getDeactivateInstruction({
    stake: address(stakeAddress),
    stakeAuthority: walletSigner,
  });
}

export function buildWithdrawInstruction({ stakeAddress, walletAddress, walletSigner, lamports }) {
  return getWithdrawInstruction({
    stake: address(stakeAddress),
    recipient: address(walletAddress),
    withdrawAuthority: walletSigner,
    args: BigInt(lamports),
  });
}

export function buildSplitInstructions({
  stakeAddress,
  walletSigner,
  newStakeSigner,
  lamports,
  rentLamports,
}) {
  return [
    getCreateAccountInstruction({
      payer: walletSigner,
      newAccount: newStakeSigner,
      lamports: BigInt(rentLamports),
      space: STAKE_ACCOUNT_SPACE,
      programAddress: STAKE_PROGRAM_ADDRESS,
    }),
    getSplitInstruction({
      stake: address(stakeAddress),
      splitStake: newStakeSigner.address,
      stakeAuthority: walletSigner,
      args: BigInt(lamports),
    }),
  ];
}

export function buildMergeInstruction({ destinationAddress, sourceAddress, walletSigner }) {
  return getMergeInstruction({
    destinationStake: address(destinationAddress),
    sourceStake: address(sourceAddress),
    stakeAuthority: walletSigner,
  });
}
