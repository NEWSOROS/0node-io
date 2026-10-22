import { describe, expect, test } from 'bun:test';
import {
  CONFIG_PROGRAM,
  STAKE_AUTHORITY_OFFSETS,
  STAKE_PROGRAM,
  VALIDATOR_INFO_PROGRAM,
  chunk,
  hasParsedData,
  isRateLimitError,
  isTransportError,
  selectValidatorInfo,
  stakeDiscoveryConfig,
  toStakeRecords,
  validatorInfoDiscoveryConfig,
} from '../src/modules/rpc-accounts.js';

const WALLET = '11111111111111111111111111111111';
const IDENTITY = '6NDen7aDi65apHo8m1Vea4nuS6LyjQeM6pDNqcW4Q5Pg';
const VOTE = '6cvBCfFXugkTqgSFVPvzhoWaLbhHWvZfSsZadWP5rryR';
const OTHER = 'Vote111111111111111111111111111111111111111';
const STAKE_ONE = 'StakeAccount1111111111111111111111111111111';
const STAKE_TWO = 'StakeAccount2222222222222222222222222222222';
const STAKE_THREE = 'StakeAccount3333333333333333333333333333333';
const STAKE_FOUR = 'StakeAccount4444444444444444444444444444444';

function stakeAccount({ owner = STAKE_PROGRAM, voter = VOTE, parsed = true } = {}) {
  return {
    owner,
    lamports: 2_282_880n,
    data: parsed
      ? {
        program: 'stake',
        parsed: {
          type: 'delegated',
          info: {
            meta: { authorized: { staker: WALLET, withdrawer: WALLET } },
            stake: { delegation: { voter } },
          },
        },
      }
      : ['', 'base64'],
  };
}

function validatorInfoAccount({ identity = IDENTITY, signer = true, owner = CONFIG_PROGRAM, name = '0node.io' } = {}) {
  return {
    owner,
    data: {
      program: 'config',
      parsed: {
        type: 'validatorInfo',
        info: {
          configData: { name, website: 'https://0node.io' },
          keys: [
            { pubkey: VALIDATOR_INFO_PROGRAM, signer: false },
            { pubkey: identity, signer },
          ],
        },
      },
    },
  };
}

describe('account discovery queries', () => {
  test('stake discovery requests pubkeys only, filtered by staker or withdrawer', () => {
    expect(STAKE_AUTHORITY_OFFSETS).toEqual([12n, 44n]);
    const config = stakeDiscoveryConfig(44n, WALLET);
    expect(config.encoding).toBe('base64');
    expect(config.dataSlice).toEqual({ offset: 0, length: 0 });
    expect(config.filters).toEqual([
      { dataSize: 200n },
      { memcmp: { offset: 44n, bytes: WALLET, encoding: 'base58' } },
    ]);
  });

  test('validator-info discovery filters on the identity key', () => {
    const config = validatorInfoDiscoveryConfig(IDENTITY);
    expect(config.dataSlice).toEqual({ offset: 0, length: 0 });
    expect(config.filters).toEqual([
      { memcmp: { offset: 34n, bytes: IDENTITY, encoding: 'base58' } },
    ]);
  });

  test('getMultipleAccounts batches stay within the RPC limit', () => {
    const keys = Array.from({ length: 205 }, (_, i) => String(i));
    expect(chunk(keys).map(batch => batch.length)).toEqual([100, 100, 5]);
    expect(chunk([])).toEqual([]);
  });
});

describe('parsed stake records', () => {
  test('keeps parsed stake-program accounts in discovery order', () => {
    const records = toStakeRecords([STAKE_ONE, STAKE_TWO], [stakeAccount(), stakeAccount({ voter: OTHER })]);
    expect(records.map(record => record.pubkey)).toEqual([STAKE_ONE, STAKE_TWO]);
    expect(records[0].lamports).toBe(2_282_880n);
    expect(records[1].parsed.info.stake.delegation.voter).toBe(OTHER);
  });

  test('drops raw base64, foreign-owned, closed and malformed accounts', () => {
    const records = toStakeRecords(
      [STAKE_ONE, STAKE_TWO, STAKE_THREE, 'not a pubkey', STAKE_FOUR],
      [
        stakeAccount({ parsed: false }),
        stakeAccount({ owner: OTHER }),
        null,
        stakeAccount(),
        stakeAccount({ voter: '<img src=x onerror=alert(1)>' }),
      ],
    );
    expect(records).toEqual([]);
  });

  test('recognises a base64 answer to a jsonParsed request', () => {
    expect(hasParsedData(stakeAccount())).toBe(true);
    expect(hasParsedData(stakeAccount({ parsed: false }))).toBe(false);
    expect(hasParsedData(null)).toBe(false);
  });
});

describe('validator-info selection', () => {
  test('accepts the record the identity signed', () => {
    expect(selectValidatorInfo([validatorInfoAccount()], IDENTITY)).toEqual({
      name: '0node.io',
      website: 'https://0node.io',
    });
  });

  test('ignores records that list the identity without its signature', () => {
    const spoofed = validatorInfoAccount({ signer: false, name: 'Fake 0node' });
    expect(selectValidatorInfo([spoofed], IDENTITY)).toBeNull();
    expect(selectValidatorInfo([spoofed, validatorInfoAccount()], IDENTITY)?.name).toBe('0node.io');
  });

  test('ignores other identities, foreign owners and unparsed data', () => {
    expect(selectValidatorInfo([validatorInfoAccount({ identity: OTHER })], IDENTITY)).toBeNull();
    expect(selectValidatorInfo([validatorInfoAccount({ owner: STAKE_PROGRAM })], IDENTITY)).toBeNull();
    expect(selectValidatorInfo([null, { owner: CONFIG_PROGRAM, data: ['', 'base64'] }], IDENTITY)).toBeNull();
  });
});

describe('RPC error classification', () => {
  test('detects HTTP 429 raised by the kit transport', () => {
    expect(isRateLimitError({ context: { statusCode: 429 } })).toBe(true);
    expect(isRateLimitError({ context: { statusCode: 403 } })).toBe(false);
    expect(isRateLimitError(new Error('network down'))).toBe(false);
  });

  test('only transport failures allow re-broadcasting a signed transaction', () => {
    expect(isTransportError({ context: { statusCode: 503 } })).toBe(true);
    expect(isTransportError(new TypeError('Failed to fetch'))).toBe(true);
    // JSON-RPC errors (e.g. preflight failure) carry no HTTP status.
    expect(isTransportError({ context: { __code: -32002 } })).toBe(false);
    expect(isTransportError(new Error('Transaction simulation failed'))).toBe(false);
  });
});
