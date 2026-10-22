import { describe, expect, test } from 'bun:test';
import {
  activationToState,
  canMergeStakeAccounts,
  fallbackStakeState,
  hasStakeAuthority,
  hasWithdrawAuthority,
  isStakeLocked,
  isValidPubkey,
  normalizeRpcUrl,
} from '../src/modules/stake-utils.js';

const WALLET = '11111111111111111111111111111111';
const OTHER = 'Vote111111111111111111111111111111111111111';
const VALIDATOR = 'Stake11111111111111111111111111111111111111';

function stakeAccount({
  pubkey = 'StakeAccount1111111111111111111111111111111',
  state = 'active',
  effective = 100n,
  activating = 0n,
  deactivating = 0n,
  staker = WALLET,
  withdrawer = WALLET,
  voter = VALIDATOR,
  creditsObserved = '42',
  activationEpoch = '700',
  deactivationEpoch = '18446744073709551615',
  lockupEpoch = '0',
} = {}) {
  return {
    pubkey,
    activation: { state, label: state, effective, activating, deactivating },
    parsed: {
      type: voter ? 'delegated' : 'initialized',
      info: {
        meta: {
          authorized: { staker, withdrawer },
          lockup: { custodian: WALLET, epoch: lockupEpoch, unixTimestamp: '0' },
        },
        ...(voter ? {
          stake: {
            creditsObserved,
            delegation: {
              activationEpoch,
              deactivationEpoch,
              stake: '100',
              voter,
            },
          },
        } : {}),
      },
    },
  };
}

describe('stake state', () => {
  test('uses effective/activating/deactivating amounts instead of epoch guesses', () => {
    expect(activationToState({ effective: 50n, activating: 50n, deactivating: 0n }).state).toBe('activating');
    expect(activationToState({ effective: 50n, activating: 0n, deactivating: 50n }).state).toBe('deactivating');
    expect(activationToState({ effective: 100n, activating: 0n, deactivating: 0n }).state).toBe('active');
    expect(activationToState({ effective: 0n, activating: 0n, deactivating: 0n }).state).toBe('inactive');
  });

  test('fallback is conservative after a deactivation epoch', () => {
    const account = stakeAccount({ activationEpoch: '699', deactivationEpoch: '700' });
    expect(fallbackStakeState(account, 701).state).toBe('unknown');
  });

  test('an account without parsed data is unknown, never inactive', () => {
    expect(fallbackStakeState({ pubkey: 'StakeAccount1111111111111111111111111111111' }, 701).state).toBe('unknown');
    expect(fallbackStakeState(stakeAccount({ voter: '' }), 701).state).toBe('inactive');
  });
});

describe('pubkey validation', () => {
  test('accepts base58 addresses and rejects markup or ambiguous characters', () => {
    expect(isValidPubkey('6cvBCfFXugkTqgSFVPvzhoWaLbhHWvZfSsZadWP5rryR')).toBe(true);
    expect(isValidPubkey('6cvBCfFXugkTqgSFVPvzhoWaLbhHWvZfSsZadWP5rry0')).toBe(false);
    expect(isValidPubkey('<img src=x onerror=alert(1)>')).toBe(false);
    expect(isValidPubkey(null)).toBe(false);
  });
});

describe('authorities', () => {
  test('distinguishes stake and withdraw authorities', () => {
    const account = stakeAccount({ staker: WALLET, withdrawer: OTHER });
    expect(hasStakeAuthority(account, WALLET)).toBe(true);
    expect(hasWithdrawAuthority(account, WALLET)).toBe(false);
  });

  test('detects epoch and timestamp lockups', () => {
    const epochLocked = stakeAccount({ lockupEpoch: '800' });
    expect(isStakeLocked(epochLocked, 700, 1_000)).toBe(true);
    expect(isStakeLocked(epochLocked, null, 1_000)).toBe(true);
    epochLocked.parsed.info.meta.lockup.epoch = '0';
    epochLocked.parsed.info.meta.lockup.unixTimestamp = '2000';
    expect(isStakeLocked(epochLocked, 700, 1_000)).toBe(true);
    expect(isStakeLocked(epochLocked, 700, 3_000)).toBe(false);
  });
});

describe('merge eligibility', () => {
  test('allows active accounts only with matching metadata and vote credits', () => {
    const destination = stakeAccount();
    const source = stakeAccount({ pubkey: 'StakeAccount2222222222222222222222222222222' });
    expect(canMergeStakeAccounts(destination, source, 701)).toBe(true);
    source.parsed.info.stake.creditsObserved = '41';
    expect(canMergeStakeAccounts(destination, source, 701)).toBe(false);
  });

  test('rejects accounts with different authorities or lockups', () => {
    const destination = stakeAccount();
    const source = stakeAccount({
      pubkey: 'StakeAccount2222222222222222222222222222222',
      withdrawer: OTHER,
    });
    expect(canMergeStakeAccounts(destination, source, 701)).toBe(false);
    source.parsed.info.meta.authorized.withdrawer = WALLET;
    source.parsed.info.meta.lockup.epoch = '5';
    expect(canMergeStakeAccounts(destination, source, 701)).toBe(false);
  });

  test('allows only zero-effective activating accounts during their activation epoch', () => {
    const destination = stakeAccount({ state: 'activating', effective: 0n, activating: 100n });
    const source = stakeAccount({
      pubkey: 'StakeAccount2222222222222222222222222222222',
      state: 'inactive',
      effective: 0n,
      voter: '',
    });
    expect(canMergeStakeAccounts(destination, source, 700)).toBe(true);
    destination.activation.effective = 1n;
    expect(canMergeStakeAccounts(destination, source, 700)).toBe(false);
  });
});

describe('custom RPC URL', () => {
  test('accepts HTTPS and rejects credentials or plaintext HTTP', () => {
    expect(normalizeRpcUrl('https://rpc.example.com')).toBe('https://rpc.example.com/');
    expect(() => normalizeRpcUrl('http://rpc.example.com')).toThrow();
    expect(() => normalizeRpcUrl('https://user:pass@rpc.example.com')).toThrow();
  });
});
