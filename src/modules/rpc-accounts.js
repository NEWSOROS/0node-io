import { isValidPubkey } from './stake-utils.js';

// ============================================
// RPC account lookups
//
// Free public RPCs no longer agree on what they serve: the ones that still
// answer getProgramAccounts (an indexed query) return raw base64 even when
// jsonParsed is requested, while the jsonParsed-capable ones refuse indexed
// queries. Every lookup is therefore split in two: discover pubkeys with a
// zero-length data slice, then read parsed data with getMultipleAccounts.
// ============================================

export const STAKE_PROGRAM = 'Stake11111111111111111111111111111111111111';
export const CONFIG_PROGRAM = 'Config1111111111111111111111111111111111111';
export const VALIDATOR_INFO_PROGRAM = 'Va1idator1nfo111111111111111111111111111111';
export const MULTIPLE_ACCOUNTS_LIMIT = 100;

const STAKE_ACCOUNT_SIZE = 200n;
// Stake account: 4-byte state tag + 8-byte rent reserve, then the staker
// (offset 12) and withdrawer (offset 44) authorities.
export const STAKE_AUTHORITY_OFFSETS = [12n, 44n];
// Config account: 1-byte key count, then 33-byte (pubkey + signer flag)
// entries; validator-info stores the validator identity as the second key.
const VALIDATOR_INFO_IDENTITY_OFFSET = 34n;

const PUBKEYS_ONLY = { encoding: 'base64', dataSlice: { offset: 0, length: 0 } };

export function stakeDiscoveryConfig(authorityOffset, walletAddress) {
  return {
    ...PUBKEYS_ONLY,
    filters: [
      { dataSize: STAKE_ACCOUNT_SIZE },
      { memcmp: { offset: authorityOffset, bytes: walletAddress, encoding: 'base58' } },
    ],
  };
}

export function validatorInfoDiscoveryConfig(identity) {
  return {
    ...PUBKEYS_ONLY,
    filters: [
      { memcmp: { offset: VALIDATOR_INFO_IDENTITY_OFFSET, bytes: identity, encoding: 'base58' } },
    ],
  };
}

export function chunk(items, size = MULTIPLE_ACCOUNTS_LIMIT) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

export function isRateLimitError(err) {
  return err?.context?.statusCode === 429;
}

// The provider never took the request: an HTTP error status or a network
// failure (fetch rejects with TypeError). A JSON-RPC error is a node's answer.
export function isTransportError(err) {
  return err?.context?.statusCode != null || err instanceof TypeError;
}

// Some providers silently answer a jsonParsed request with raw base64.
export function hasParsedData(account) {
  const parsed = account?.data?.parsed;
  return !!parsed && typeof parsed === 'object';
}

// getMultipleAccounts(jsonParsed) results → the { pubkey, lamports, parsed }
// records the stake UI renders. Anything that is not a parsed Stake-program
// account (closed since discovery, unparsed, malformed) is dropped.
export function toStakeRecords(pubkeys, accounts) {
  const records = [];
  pubkeys.forEach((pubkey, i) => {
    const account = accounts[i];
    if (!isValidPubkey(pubkey) || account?.owner !== STAKE_PROGRAM) return;
    if (!hasParsedData(account)) return;
    const parsed = account.data.parsed;
    // The voter ends up in href/title attributes downstream.
    const voter = parsed.info?.stake?.delegation?.voter;
    if (voter && !isValidPubkey(voter)) return;
    records.push({ pubkey, lamports: BigInt(account.lamports), parsed });
  });
  return records;
}

// The Config program only enforces signatures for keys flagged as signers, so
// anyone can publish a "validatorInfo" record that merely lists another
// validator's identity. Only a record the identity actually signed is theirs.
export function selectValidatorInfo(accounts, identity) {
  for (const account of accounts) {
    if (account?.owner !== CONFIG_PROGRAM) continue;
    const parsed = account.data?.parsed;
    if (parsed?.type !== 'validatorInfo') continue;
    const keys = Array.isArray(parsed.info?.keys) ? parsed.info.keys : [];
    if (keys[0]?.pubkey !== VALIDATOR_INFO_PROGRAM) continue;
    if (!keys.some(key => key?.pubkey === identity && key?.signer === true)) continue;
    const configData = parsed.info?.configData;
    return configData && typeof configData === 'object' ? configData : {};
  }
  return null;
}
