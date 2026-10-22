export const U64_MAX = '18446744073709551615';

// Solana addresses are base58 — exactly the characters [1-9A-HJ-NP-Za-km-z]
// with no 0/O/I/l. Length is 32-44 chars. Anything else is a malformed RPC
// response (or worse — an attacker-controlled custom RPC returning HTML).
// We reject malformed values at ingress so they never reach the renderer.
const BASE58_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function isValidPubkey(s) {
  return typeof s === 'string' && BASE58_PUBKEY_RE.test(s);
}

function asString(value) {
  return value == null ? '' : String(value);
}

export function getStakeDetails(account) {
  const info = account?.parsed?.info ?? {};
  const delegation = info.stake?.delegation ?? null;
  const meta = info.meta ?? {};

  return {
    activationEpoch: delegation ? asString(delegation.activationEpoch) : '',
    authorized: {
      staker: asString(meta.authorized?.staker),
      withdrawer: asString(meta.authorized?.withdrawer),
    },
    creditsObserved: asString(info.stake?.creditsObserved),
    deactivationEpoch: delegation ? asString(delegation.deactivationEpoch) : '',
    delegatedStake: delegation ? asString(delegation.stake) : '0',
    lockup: {
      custodian: asString(meta.lockup?.custodian),
      epoch: asString(meta.lockup?.epoch),
      unixTimestamp: asString(meta.lockup?.unixTimestamp),
    },
    type: asString(account?.parsed?.type),
    voter: asString(delegation?.voter),
  };
}

export function hasStakeAuthority(account, walletAddress) {
  return !!walletAddress && getStakeDetails(account).authorized.staker === walletAddress;
}

export function hasWithdrawAuthority(account, walletAddress) {
  return !!walletAddress && getStakeDetails(account).authorized.withdrawer === walletAddress;
}

export function isStakeLocked(account, currentEpoch, unixTimestampSeconds = Math.floor(Date.now() / 1000)) {
  const { lockup } = getStakeDetails(account);
  const lockupEpoch = Number(lockup.epoch || 0);
  const lockupTimestamp = Number(lockup.unixTimestamp || 0);
  return (lockupEpoch > 0 && (!Number.isFinite(currentEpoch) || lockupEpoch > currentEpoch))
    || (Number.isFinite(lockupTimestamp) && lockupTimestamp > unixTimestampSeconds);
}

export function activationToState(activation) {
  const effective = BigInt(activation?.effective ?? 0);
  const activating = BigInt(activation?.activating ?? 0);
  const deactivating = BigInt(activation?.deactivating ?? 0);

  if (deactivating > 0n) {
    return { state: 'deactivating', label: 'Deactivating', effective, activating, deactivating };
  }
  if (activating > 0n) {
    return { state: 'activating', label: 'Activating', effective, activating, deactivating };
  }
  if (effective > 0n) {
    return { state: 'active', label: 'Active', effective, activating, deactivating };
  }
  return { state: 'inactive', label: 'Inactive', effective, activating, deactivating };
}

// Conservative fallback for the rare case where Stake History cannot be read.
// It intentionally returns "unknown" whenever epoch numbers alone cannot prove
// that a delegated account is fully active or inactive.
export function fallbackStakeState(account, currentEpoch) {
  const details = getStakeDetails(account);
  const empty = { effective: 0n, activating: 0n, deactivating: 0n };

  // Without parsed account data we know nothing — never report such an
  // account as inactive, which would tell a staker their live stake is idle.
  if (!details.type) {
    return { state: 'unknown', label: 'State unavailable', ...empty };
  }
  if (details.type === 'initialized' || !details.voter) {
    return { state: 'inactive', label: 'Inactive', ...empty };
  }
  if (details.type !== 'delegated') {
    return { state: 'unknown', label: 'State unavailable', ...empty };
  }

  const activationEpoch = Number(details.activationEpoch);
  const deactivationEpoch = details.deactivationEpoch === U64_MAX
    ? Number.POSITIVE_INFINITY
    : Number(details.deactivationEpoch);

  if (activationEpoch === deactivationEpoch) {
    return { state: 'inactive', label: 'Inactive', ...empty };
  }
  if (Number.isFinite(currentEpoch) && currentEpoch === activationEpoch) {
    return { state: 'activating', label: 'Activating', ...empty };
  }
  if (Number.isFinite(currentEpoch) && currentEpoch === deactivationEpoch) {
    return { state: 'deactivating', label: 'Deactivating', ...empty };
  }
  return { state: 'unknown', label: 'State unavailable', ...empty };
}

function sameAuthoritiesAndLockup(left, right) {
  const a = getStakeDetails(left);
  const b = getStakeDetails(right);
  return a.authorized.staker === b.authorized.staker
    && a.authorized.withdrawer === b.authorized.withdrawer
    && a.lockup.custodian === b.lockup.custodian
    && a.lockup.epoch === b.lockup.epoch
    && a.lockup.unixTimestamp === b.lockup.unixTimestamp;
}

function sameDelegation(left, right) {
  const a = getStakeDetails(left);
  const b = getStakeDetails(right);
  return a.voter === b.voter && a.creditsObserved === b.creditsObserved;
}

export function canMergeStakeAccounts(destination, source, currentEpoch) {
  if (!destination || !source || destination.pubkey === source.pubkey) return false;
  if (!sameAuthoritiesAndLockup(destination, source)) return false;

  const destState = destination.activation;
  const srcState = source.activation;
  if (!destState || !srcState) return false;

  if (destState.state === 'inactive' && srcState.state === 'inactive') return true;

  const dest = getStakeDetails(destination);
  const src = getStakeDetails(source);
  const destIsFreshActivation = destState.state === 'activating'
    && destState.effective === 0n
    && Number(dest.activationEpoch) === currentEpoch;

  // The Stake program accepts an inactive source into a destination that is
  // still in its activation epoch and has no effective stake yet.
  if (destIsFreshActivation && srcState.state === 'inactive') return true;

  const srcIsFreshActivation = srcState.state === 'activating'
    && srcState.effective === 0n
    && Number(src.activationEpoch) === currentEpoch;
  if (destIsFreshActivation && srcIsFreshActivation) {
    return dest.activationEpoch === src.activationEpoch && sameDelegation(destination, source);
  }

  if (destState.state === 'active' && srcState.state === 'active') {
    return sameDelegation(destination, source);
  }

  return false;
}

export function normalizeRpcUrl(rawUrl) {
  const value = String(rawUrl ?? '').trim();
  if (!value) return '';

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Enter a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Custom RPC must use HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Credentials are not allowed in the RPC URL');
  }
  return parsed.href;
}
