import {
  address,
  createSolanaRpc,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  partiallySignTransactionMessageWithSigners,
  createNoopSigner,
  generateKeyPairSigner,
  getSolanaErrorFromTransactionError,
  getTransactionEncoder,
} from '@solana/kit';

import { getStakeActivatingAndDeactivating } from '@anza-xyz/solana-rpc-get-stake-activation';

import {
  STAKE_PROGRAM_ADDRESS,
} from '@solana-program/stake';

// VersionedTransaction is the only piece we keep from web3.js v1 —
// it bridges kit-encoded wire bytes to wallet.signTransaction().
import { VersionedTransaction } from '@solana/web3.js';
import {
  U64_MAX,
  activationToState,
  canMergeStakeAccounts,
  fallbackStakeState,
  getStakeDetails,
  hasStakeAuthority,
  hasWithdrawAuthority,
  isStakeLocked,
  isValidPubkey,
  normalizeRpcUrl,
} from './stake-utils.js';
import {
  CONFIG_PROGRAM,
  STAKE_AUTHORITY_OFFSETS,
  chunk,
  hasParsedData,
  isRateLimitError,
  isTransportError,
  selectValidatorInfo,
  stakeDiscoveryConfig,
  toStakeRecords,
  validatorInfoDiscoveryConfig,
} from './rpc-accounts.js';
import { TX_MESSAGES, describeTxError, readSignedBlockhash } from './tx-utils.js';
import {
  STAKE_ACCOUNT_SPACE,
  buildCreateAndDelegateInstructions,
  buildDeactivateInstruction,
  buildDelegateInstruction,
  buildMergeInstruction,
  buildSplitInstructions,
  buildWithdrawInstruction,
} from './stake-instructions.js';

// ============================================
// 0node Staking Module — @solana/kit edition
// ============================================

const VALIDATOR_VOTE_ACCOUNT = '6cvBCfFXugkTqgSFVPvzhoWaLbhHWvZfSsZadWP5rryR';
const MIN_STAKE_FALLBACK_SOL = 1;
const LAMPORTS_PER_SOL = 1_000_000_000;
const STAKE_HISTORY_ADDRESS = 'SysvarStakeHistory1111111111111111111111111';

// --- Network Configuration ---
const NETWORKS = {
  'mainnet-beta': {
    label: 'Mainnet',
    // Public, no-API-key endpoints that accept browser (CORS) requests.
    // Re-checked 2026-10-21: drpc dropped Solana from its free plan, OnFinality
    // and Ankr require API keys, and api.mainnet-beta.solana.com answers 403
    // to any browser Origin. solana-rpc.publicnode.com stays excluded — it is
    // flagged by some antivirus / DNS-filter blocklists. Pocket Network leads
    // for everyday reads and broadcasting because it does not throttle bursts.
    endpoints: [
      'https://solana.api.pocket.network',
      'https://public.rpc.solanavibestation.com',
    ],
    // getProgramAccounts needs an account index. Of the free endpoints only
    // Solana Vibe Station still serves it (raw base64 only, ~3 requests/s).
    indexedEndpoints: ['https://public.rpc.solanavibestation.com'],
    validator: VALIDATOR_VOTE_ACCOUNT,
    explorerUrl: (type, id) => `https://solscan.io/${type}/${id}`,
  },
  testnet: {
    label: 'Testnet',
    endpoints: ['https://api.testnet.solana.com'],
    validator: 'A7A4r3mXENbuoPcfgTRezHfno46SxWnoCDZp5eJfncT3',
    explorerUrl: (type, id) => `https://solscan.io/${type}/${id}?cluster=testnet`,
  },
};

let currentNetwork = 'mainnet-beta';
let rpc = null;
let connectedWallet = null;
let walletAddr = null; // Address string (kit) — source of truth
let balance = 0;
let stakeAccounts = []; // cached; each: { pubkey, lamports, parsed }
let stakeRentLamports = null;
let minimumDelegationLamports = null;
let walletEventBindings = [];
let disconnectingWallet = false;
// Cached state per pubkey. Computed at render time, reused by showMergeModal /
// click handlers so the merge filter sees the same classification the user
// just clicked through. Otherwise a stale currentEpoch (race vs fetchCurrentEpoch)
// or a parsed-data difference between calls could let merge eligibility disagree
// with itself across the render → click boundary.
const stakeStateCache = new Map(); // pubkey → { state, label }

function cachedStakeState(acc) {
  const cached = stakeStateCache.get(acc.pubkey);
  if (cached) return cached;
  const s = fallbackStakeState(acc, currentEpoch);
  stakeStateCache.set(acc.pubkey, s);
  acc.activation = s;
  return s;
}

// --- Custom RPC ---
let customRpcUrl = (() => {
  try {
    return normalizeRpcUrl(localStorage.getItem('0node-custom-rpc') || '');
  } catch {
    try { localStorage.removeItem('0node-custom-rpc'); } catch (_) { /* storage unavailable */ }
    return '';
  }
})();

// --- Two-step redelegation intent ---
// Solana requires deactivation to finish before an existing stake account can
// be delegated to another validator. We persist the selected target locally so
// the UI can offer the second transaction when the account becomes inactive.
const PENDING_REDELEGATIONS_KEY = '0node-pending-redelegations';
let pendingRedelegations = (() => {
  try { return JSON.parse(localStorage.getItem(PENDING_REDELEGATIONS_KEY) || '{}'); }
  catch { return {}; }
})();

function pendingKey(stakePubkey) {
  return `${currentNetwork}:${stakePubkey}`;
}

function getPendingRedelegation(stakePubkey) {
  const pending = pendingRedelegations[pendingKey(stakePubkey)] || null;
  if (pending && !isValidPubkey(pending.targetValidator)) {
    clearPendingRedelegation(stakePubkey);
    return null;
  }
  return pending;
}

function setPendingRedelegation(stakePubkey, targetValidator) {
  pendingRedelegations[pendingKey(stakePubkey)] = { targetValidator, ts: Date.now() };
  persistPendingRedelegations();
}

function clearPendingRedelegation(stakePubkey) {
  delete pendingRedelegations[pendingKey(stakePubkey)];
  persistPendingRedelegations();
}

function persistPendingRedelegations() {
  try { localStorage.setItem(PENDING_REDELEGATIONS_KEY, JSON.stringify(pendingRedelegations)); }
  catch (_) { /* storage unavailable; the current session still works */ }
}

// --- Validator metadata cache ---
// Keyed by vote pubkey. Each entry: { name, website, iconUrl, iconDataUrl, ts }.
// Fetched from Stakewiz once per validator and persisted to localStorage so
// the second visit needs zero third-party requests for names/icons.
const VALIDATOR_META_KEY = '0node-validator-meta';
const VALIDATOR_META_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days for found
const VALIDATOR_META_MISS_TTL = 60 * 60 * 1000; // 1 hour for unpublished
const VALIDATOR_ICON_MAX_BYTES = 200_000; // skip oversize images
let validatorMetaCache = (() => {
  try { return JSON.parse(localStorage.getItem(VALIDATOR_META_KEY) || '{}'); }
  catch { return {}; }
})();

function persistValidatorMetaCache() {
  try {
    localStorage.setItem(VALIDATOR_META_KEY, JSON.stringify(validatorMetaCache));
  } catch {
    // Quota exceeded — drop oldest entries and retry once.
    const sorted = Object.entries(validatorMetaCache).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
    while (sorted.length > 5) delete validatorMetaCache[sorted.shift()[0]];
    try { localStorage.setItem(VALIDATOR_META_KEY, JSON.stringify(validatorMetaCache)); } catch (_) { /* storage unavailable */ }
  }
}

async function fetchImageAsDataUrl(url) {
  try {
    const resp = await fetch(url, { mode: 'cors' });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    if (blob.size > VALIDATOR_ICON_MAX_BYTES) return null;
    if (!blob.type.startsWith('image/')) return null;
    return await new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch { return null; }
}

// Pull name/website/iconUrl directly from on-chain validator-info (Solana
// Config program). This is what `solana validator-info publish` writes,
// signed by the validator's identity keypair — no third-party indexer
// involved. We still load the actual icon image from the validator's own
// declared iconUrl (their CDN/domain), but that's the canonical source.
async function fetchValidatorMetaOnChain(voteAddress) {
  try {
    // Vote → identity: read the vote account directly. Much lighter than
    // getVoteAccounts (which returns ~3000 entries) and per-validator-only.
    const voteAcc = await withRpcFallback(client => client.getAccountInfo(address(voteAddress), {
      encoding: 'jsonParsed',
    }).send());
    const identity = voteAcc?.value?.data?.parsed?.info?.nodePubkey;
    if (!isValidPubkey(identity)) return null;

    const found = await withIndexedRpc(client => client
      .getProgramAccounts(address(CONFIG_PROGRAM), validatorInfoDiscoveryConfig(identity))
      .send());
    const infoPubkeys = found.map(acc => acc.pubkey).filter(isValidPubkey);
    // A spoofed record may not parse; skip it rather than fail the lookup.
    const accounts = await fetchParsedAccounts(infoPubkeys, { requireParsed: false });
    const cd = selectValidatorInfo(accounts, identity);

    // Validator hasn't published (signed) info on-chain — cache a short-TTL
    // miss so we don't refetch on every render but do retry later.
    if (!cd) return { name: null, website: null, iconUrl: null, iconDataUrl: null, ts: Date.now() };

    // Only load+display icons for our own validator. Every other validator
    // is third-party — even though we'd render the image safely, the GET to
    // their iconUrl leaks the visitor's IP and Origin to their server, which
    // doubles as a privacy and a (very minor) attack surface. Names stay
    // visible because they're already escaped at render time.
    const ourValidator = NETWORKS[currentNetwork]?.validator;
    const isOurValidator = voteAddress === ourValidator;
    const rawIcon = isSafeHttpsUrl(cd.iconUrl) ? cd.iconUrl : null;
    const meta = {
      name: cd.name || null,
      website: cd.website || null,
      iconUrl: isOurValidator ? rawIcon : null,
      iconDataUrl: null,
      ts: Date.now(),
    };
    if (isOurValidator && meta.iconUrl) {
      meta.iconDataUrl = await fetchImageAsDataUrl(meta.iconUrl);
    }
    return meta;
  } catch (err) {
    console.warn(`validator-info lookup failed for ${voteAddress}:`, err?.message);
    return null;
  }
}

async function ensureValidatorMeta(voteAddress) {
  const cached = validatorMetaCache[voteAddress];
  if (cached) {
    // Found info: refresh after the full TTL. Empty miss: retry sooner.
    const ttl = cached.name ? VALIDATOR_META_TTL : VALIDATOR_META_MISS_TTL;
    if (Date.now() - (cached.ts || 0) < ttl) return cached;
  }
  const fresh = await fetchValidatorMetaOnChain(voteAddress);
  if (fresh) {
    validatorMetaCache[voteAddress] = fresh;
    persistValidatorMetaCache();
    return fresh;
  }
  return cached || null;
}

// Kick off background fetches for unique vote accounts. Resolves once they all
// land; caller can re-render to reflect newly cached entries.
async function prefetchValidatorMetadata(stakes) {
  const votes = new Set();
  for (const s of stakes) {
    const v = s.parsed?.info?.stake?.delegation?.voter;
    if (v) votes.add(v);
  }
  const missing = [...votes].filter(v => {
    const cached = validatorMetaCache[v];
    if (!cached) return true;
    const ttl = cached.name ? VALIDATOR_META_TTL : VALIDATOR_META_MISS_TTL;
    return Date.now() - (cached.ts || 0) > ttl;
  });
  if (missing.length === 0) return false;
  // One validator at a time: each lookup costs three RPC calls, and a
  // parallel burst trips the indexed endpoint's rate limit.
  for (const vote of missing) {
    await ensureValidatorMeta(vote).catch(() => null);
  }
  return true;
}

// --- RPC with fallback ---
let workingEndpointIndex = 0;

function getEndpoints() {
  // A custom endpoint is an explicit privacy choice and replaces the defaults.
  // Falling back behind the user's back would still disclose their wallet and
  // stake-account queries to the public providers.
  return customRpcUrl ? [customRpcUrl] : [...NETWORKS[currentNetwork].endpoints];
}

function getIndexedEndpoints() {
  if (customRpcUrl) return [customRpcUrl];
  const network = NETWORKS[currentNetwork];
  return [...(network.indexedEndpoints ?? network.endpoints)];
}

function getExplorerUrl(type, id) {
  return NETWORKS[currentNetwork].explorerUrl(type, id);
}

function createRpc(endpointIndex = 0) {
  const endpoints = getEndpoints();
  const url = endpoints[Math.min(endpointIndex, endpoints.length - 1)];
  return createSolanaRpc(url);
}

async function getStakeRentLamports() {
  if (stakeRentLamports !== null) return stakeRentLamports;
  await getWorkingRpc();
  stakeRentLamports = await rpc.getMinimumBalanceForRentExemption(STAKE_ACCOUNT_SPACE).send();
  return stakeRentLamports;
}

function getMinimumStakeSol() {
  return minimumDelegationLamports === null
    ? MIN_STAKE_FALLBACK_SOL
    : Number(minimumDelegationLamports) / LAMPORTS_PER_SOL;
}

function updateMinimumStakeUi() {
  const minimum = getMinimumStakeSol();
  const input = $('stake-amount');
  if (input) input.min = String(minimum);
  const label = $('minimum-stake-value');
  if (label) label.textContent = `${minimum.toLocaleString()} SOL`;
}

async function getMinimumDelegationLamports() {
  if (minimumDelegationLamports !== null) return minimumDelegationLamports;
  await getWorkingRpc();
  const response = await rpc.getStakeMinimumDelegation().send();
  const value = BigInt(response?.value ?? response);
  if (value <= 0n) throw new Error('RPC returned an invalid minimum delegation');
  minimumDelegationLamports = value;
  updateMinimumStakeUi();
  return value;
}

// A verified endpoint is reused for a while instead of being re-checked before
// every call: those extra getEpochInfo round-trips alone were enough to trip
// public RPC rate limits on page load. The generation counter keeps a check
// that started before a network / custom-RPC switch from installing a client
// for the old configuration.
const RPC_HEALTH_TTL_MS = 30_000;
let rpcVerifiedAt = 0;
let rpcGeneration = 0;
let rpcCheck = null;

function markRpcHealthy(client, endpointIndex, generation) {
  if (generation !== rpcGeneration) return;
  rpc = client;
  workingEndpointIndex = endpointIndex;
  rpcVerifiedAt = Date.now();
}

function resetRpc() {
  rpcGeneration++;
  rpcCheck = null;
  rpcVerifiedAt = 0;
  workingEndpointIndex = 0;
  rpc = createRpc(0);
}

async function getWorkingRpc() {
  if (rpc && Date.now() - rpcVerifiedAt < RPC_HEALTH_TTL_MS) return rpc;
  if (!rpcCheck) {
    const check = findWorkingRpc().finally(() => {
      if (rpcCheck === check) rpcCheck = null;
    });
    rpcCheck = check;
  }
  return rpcCheck;
}

async function findWorkingRpc() {
  const generation = rpcGeneration;
  const endpoints = getEndpoints();
  const start = Math.min(workingEndpointIndex, endpoints.length - 1);

  for (let n = 0; n < endpoints.length; n++) {
    const i = (start + n) % endpoints.length;
    try {
      const client = createSolanaRpc(endpoints[i]);
      await client.getEpochInfo().send();
      if (generation !== rpcGeneration) return rpc;
      if (i !== workingEndpointIndex) console.log(`Using RPC: ${endpoints[i]}`);
      markRpcHealthy(client, i, generation);
      return client;
    } catch (err) {
      console.warn(`RPC ${i} health check failed:`, err.message);
    }
  }
  throw new Error('All RPC endpoints unreachable');
}

// Try each endpoint in turn. Free-tier rate limits are short bursts, so when
// every endpoint failed and at least one only rate-limited us, back off and
// go round again.
const RPC_ATTEMPT_ROUNDS = 3;

async function tryEndpoints(urls, request, { shouldFallback = () => true } = {}) {
  let lastError = null;
  for (let round = 0; round < RPC_ATTEMPT_ROUNDS; round++) {
    let rateLimited = false;
    for (let index = 0; index < urls.length; index++) {
      const client = createSolanaRpc(urls[index]);
      try {
        return { client, index, result: await request(client) };
      } catch (err) {
        if (!shouldFallback(err)) throw err;
        lastError = err;
        rateLimited ||= isRateLimitError(err);
        const status = err?.context?.statusCode;
        console.warn(`RPC ${urls[index]} failed:`, status ? `HTTP ${status}` : err?.message);
      }
    }
    if (!rateLimited) break;
    await new Promise(r => setTimeout(r, 1000 * (round + 1)));
  }
  throw lastError ?? new Error('All RPC endpoints failed');
}

// Run a request against the general endpoints, starting with the one that
// last worked and moving on when a provider errors or rate-limits us.
async function withRpcFallback(request, options) {
  const generation = rpcGeneration;
  const endpoints = getEndpoints();
  const start = Math.min(workingEndpointIndex, endpoints.length - 1);
  const order = endpoints.map((_, n) => (start + n) % endpoints.length);
  const { client, index, result } = await tryEndpoints(order.map(i => endpoints[i]), request, options);
  markRpcHealthy(client, order[index], generation);
  return result;
}

// getProgramAccounts goes only to endpoints that keep an account index.
async function withIndexedRpc(request) {
  return (await tryEndpoints(getIndexedEndpoints(), request)).result;
}

// Parsed account data in batches, from whichever general endpoint returns
// real jsonParsed output. With requireParsed, a provider that silently falls
// back to base64 counts as failed so the next endpoint is tried.
async function fetchParsedAccounts(pubkeys, { requireParsed = true } = {}) {
  const accounts = [];
  for (const batch of chunk(pubkeys)) {
    const value = await withRpcFallback(async client => {
      const { value: batchAccounts } = await client
        .getMultipleAccounts(batch.map(pubkey => address(pubkey)), { encoding: 'jsonParsed' })
        .send();
      if (requireParsed && batchAccounts.some(account => account && !hasParsedData(account))) {
        throw new Error('RPC returned unparsed account data');
      }
      return batchAccounts;
    });
    accounts.push(...value);
  }
  return accounts;
}

async function getBalanceWithFallback(addrString, retries = 2) {
  const generation = rpcGeneration;
  const endpoints = getEndpoints();
  for (let attempt = 0; attempt <= retries; attempt++) {
    for (let i = 0; i < endpoints.length; i++) {
      try {
        const client = createSolanaRpc(endpoints[i]);
        const { value } = await client.getBalance(address(addrString)).send();
        markRpcHealthy(client, i, generation);
        return value; // bigint lamports
      } catch (err) {
        console.warn(`RPC ${i} (attempt ${attempt}) failed:`, err.message);
      }
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error('All RPC endpoints failed');
}

// Wallet icon mapping
const WALLET_ICONS = {
  phantom: '/phantom.svg',
  solflare: '/solflare.svg',
  backpack: '/backpack.svg',
  trustwallet: '/trustwallet.svg',
};

const WALLETS = {
  phantom: {
    name: 'Phantom',
    getProvider: () => window?.phantom?.solana,
    installUrl: 'https://phantom.app/',
    check: (p) => p?.isPhantom,
  },
  solflare: {
    name: 'Solflare',
    getProvider: () => window?.solflare,
    installUrl: 'https://solflare.com/',
    check: (p) => p?.isSolflare,
  },
  backpack: {
    name: 'Backpack',
    getProvider: () => window?.backpack,
    installUrl: 'https://backpack.app/',
    check: (p) => p?.isBackpack,
  },
  trustwallet: {
    name: 'Trust Wallet',
    getProvider: () => window?.trustwallet?.solana,
    installUrl: 'https://trustwallet.com/',
    check: (p) => p?.isTrust || p?.isTrustWallet || !!p,
  },
};

function getProvider(walletId) {
  return WALLETS[walletId]?.getProvider();
}

function isInstalled(walletId) {
  const wallet = WALLETS[walletId];
  if (!wallet) return false;
  const provider = wallet.getProvider();
  return provider ? wallet.check(provider) : false;
}

// --- DOM Helpers ---
function $(id) { return document.getElementById(id); }

function setStatus(text, type = '') {
  const el = $('stake-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'stake-status' + (type ? ` ${type}` : '');
}

function truncateAddress(addr) {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

// Escape user/external-controlled text before interpolating into innerHTML
// templates. Defense against stored XSS via on-chain validator names, custom
// RPC pubkeys returning HTML, etc. CSP would already block inline scripts as
// a backstop, but escaping at the source is the proper fix.
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// iconUrl from validator-info is user-controlled (whatever the validator
// chose to publish). We allow https URLs with safe characters only — no
// quotes/spaces/control chars that could break out of an HTML attribute.
function isSafeHttpsUrl(s) {
  if (typeof s !== 'string') return false;
  try {
    const parsed = new URL(s);
    const forbidden = ['"', "'", '<', '>', '`'];
    return parsed.protocol === 'https:'
      && !/\s/.test(s)
      && !forbidden.some(character => s.includes(character));
  } catch {
    return false;
  }
}

// --- Network Toggle ---
function switchNetwork(networkId) {
  if (networkId === currentNetwork) return;
  if (!NETWORKS[networkId]) return;

  currentNetwork = networkId;
  resetRpc();
  stakeRentLamports = null;
  minimumDelegationLamports = null;
  stakeStateCache.clear();

  document.querySelectorAll('.net-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.network === networkId);
  });

  const badge = $('testnet-badge');
  if (badge) badge.style.display = networkId === 'testnet' ? 'inline-flex' : 'none';

  getWorkingRpc()
    .then(() => Promise.all([getStakeRentLamports(), getMinimumDelegationLamports()]))
    .catch(() => {});

  if (connectedWallet) {
    disconnectWallet();
    setStatus(`Switched to ${NETWORKS[networkId].label}. Please reconnect wallet.`, 'pending');
  }
}

// --- Wallet detection UI (with retry for late-injecting extensions) ---
function updateWalletButtons() {
  document.querySelectorAll('.wallet-option').forEach(btn => {
    const walletId = btn.dataset.wallet;
    const installed = isInstalled(walletId);
    const isConnectedWallet = connectedWallet?.id === walletId;
    btn.classList.toggle('not-installed', !installed && !isConnectedWallet);
    btn.classList.toggle('wallet-connected', isConnectedWallet);
  });
}

function walletPublicKeyToString(value) {
  const candidate = Array.isArray(value) ? value[0] : value?.publicKey ?? value;
  if (!candidate) return '';
  return candidate?.toBase58?.() ?? String(candidate);
}

function clearWalletEventBindings() {
  for (const { provider, event, handler } of walletEventBindings) {
    try {
      if (typeof provider.removeListener === 'function') provider.removeListener(event, handler);
      else if (typeof provider.off === 'function') provider.off(event, handler);
    } catch (_) { /* wallet extension cleanup is best-effort */ }
  }
  walletEventBindings = [];
}

function bindWalletEvents(provider) {
  clearWalletEventBindings();
  if (typeof provider?.on !== 'function') return;

  const onAccountChanged = (nextKey) => {
    if (disconnectingWallet) return;
    const nextAddress = walletPublicKeyToString(nextKey);
    if (!isValidPubkey(nextAddress)) {
      handleProviderDisconnect();
      return;
    }
    if (nextAddress === walletAddr) return;
    walletAddr = nextAddress;
    balance = 0;
    stakeAccounts = [];
    stakeStateCache.clear();
    setStatus('Wallet account changed', 'pending');
    showConnectedUI();
  };
  const onDisconnect = () => {
    if (!disconnectingWallet) handleProviderDisconnect();
  };

  for (const [event, handler] of [
    ['accountChanged', onAccountChanged],
    ['accountsChanged', onAccountChanged],
    ['disconnect', onDisconnect],
  ]) {
    try {
      provider.on(event, handler);
      walletEventBindings.push({ provider, event, handler });
    } catch (_) { /* not every provider supports every event */ }
  }
}

function handleProviderDisconnect() {
  clearWalletEventBindings();
  connectedWallet = null;
  walletAddr = null;
  balance = 0;
  stakeAccounts = [];
  stakeStateCache.clear();
  try { localStorage.setItem('0node-wallet-disconnected', '1'); } catch (_) { /* storage unavailable */ }
  showDisconnectedUI();
  setStatus('Wallet disconnected', 'error');
}

// --- UI Updates ---
function showConnectedUI() {
  $('staking-connect').style.display = 'none';
  $('staking-form').style.display = 'block';

  $('wallet-address').textContent = truncateAddress(walletAddr);

  const iconEl = $('wallet-icon');
  if (iconEl && connectedWallet?.id) {
    const iconSrc = WALLET_ICONS[connectedWallet.id];
    if (iconSrc) {
      iconEl.src = iconSrc;
      iconEl.alt = WALLETS[connectedWallet.id]?.name || '';
      iconEl.style.display = 'block';
    }
  }

  updateWalletButtons();

  const navBtn = $('wallet-btn-nav');
  navBtn.classList.add('connected');
  navBtn.querySelector('span').textContent = truncateAddress(walletAddr);

  updateBalance();
  loadStakeAccounts();
}

function showDisconnectedUI() {
  $('staking-connect').style.display = 'block';
  $('staking-form').style.display = 'none';
  $('stake-amount').value = '';
  $('stake-btn').disabled = true;
  setStatus('');

  const iconEl = $('wallet-icon');
  if (iconEl) iconEl.style.display = 'none';

  updateWalletButtons();

  const navBtn = $('wallet-btn-nav');
  navBtn.classList.remove('connected');
  navBtn.querySelector('span').textContent = 'Connect Wallet';

  const stakesSection = $('my-stakes');
  if (stakesSection) stakesSection.style.display = 'none';
}

async function updateBalance() {
  if (!walletAddr) return;

  const balanceEl = $('wallet-balance');
  balanceEl.textContent = 'Loading balance...';

  try {
    const lamports = await getBalanceWithFallback(walletAddr);
    balance = Number(lamports) / LAMPORTS_PER_SOL;
    balanceEl.textContent = `${balance.toFixed(4)} SOL`;
  } catch (err) {
    console.warn('All balance fetches failed:', err);
    balance = 0;
    balanceEl.innerHTML = '<span style="color:var(--red);cursor:pointer" title="Click to retry">⟳ Retry</span>';
    balanceEl.onclick = () => {
      balanceEl.onclick = null;
      updateBalance();
    };
  }
}

// --- Connect / Disconnect ---
async function connectWallet(walletId) {
  const provider = getProvider(walletId);
  if (!provider || !WALLETS[walletId].check(provider)) {
    // noopener,noreferrer — the opened wallet-vendor page gets no
    // window.opener handle back to us (reverse-tabnabbing hygiene).
    window.open(WALLETS[walletId].installUrl, '_blank', 'noopener,noreferrer');
    return;
  }

  try {
    setStatus('Connecting...', 'pending');

    let pubkeyString = null;

    if (walletId === 'solflare') {
      await provider.connect();
      await new Promise(r => setTimeout(r, 300));
      pubkeyString = provider.publicKey?.toBase58?.() ?? String(provider.publicKey);
    } else {
      const resp = await provider.connect();
      const pk = resp?.publicKey ?? provider.publicKey;
      pubkeyString = pk?.toBase58?.() ?? String(pk);
    }

    if (!pubkeyString) throw new Error('No public key returned');

    if (!connectedWallet) connectedWallet = { id: walletId, provider };
    walletAddr = pubkeyString;
    if (!isValidPubkey(walletAddr)) throw new Error('Wallet returned an invalid public key');
    bindWalletEvents(provider);
    // User just connected on purpose — clear the "explicitly disconnected"
    // flag so refresh auto-reconnects again.
    try { localStorage.removeItem('0node-wallet-disconnected'); } catch (_) { /* storage unavailable */ }
    setStatus('');
    showConnectedUI();
  } catch (err) {
    console.warn(`Wallet ${walletId} connection failed:`, err);
    clearWalletEventBindings();
    connectedWallet = null;
    walletAddr = null;
    const msg = err?.message || '';
    if (msg.includes('User rejected') || msg.includes('rejected') || msg.includes('cancel')) {
      setStatus('Connection cancelled by user', 'error');
    } else {
      setStatus('Connection failed. Try again.', 'error');
    }
  }
}

async function disconnectWallet({ callProvider = true, remember = true } = {}) {
  const provider = connectedWallet?.provider;
  disconnectingWallet = true;
  clearWalletEventBindings();
  if (callProvider && provider?.disconnect) {
    try { await provider.disconnect(); } catch (_) { /* ignore */ }
  }
  connectedWallet = null;
  walletAddr = null;
  balance = 0;
  stakeAccounts = [];
  stakeStateCache.clear();
  // Remember that the user chose to disconnect — wallet extensions often
  // keep the site as "trusted" and provider.isConnected stays true on
  // refresh, which would otherwise trigger our auto-reconnect.
  if (remember) {
    try { localStorage.setItem('0node-wallet-disconnected', '1'); } catch (_) { /* storage unavailable */ }
  }
  showDisconnectedUI();
  disconnectingWallet = false;
}

// ============================================
// Wire bytes → base64 (for rpc.sendTransaction)
// ============================================
function uint8ToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ============================================
// Wallet signing bridge
// Takes wire bytes (v0 transaction), returns fully signed wire bytes.
// ============================================
async function signViaWallet(wireBytes) {
  const legacyTx = VersionedTransaction.deserialize(wireBytes);
  const signed = await connectedWallet.provider.signTransaction(legacyTx);
  return signed.serialize();
}

// ============================================
// Build, sign, send, confirm
// ============================================
async function buildAndSend(instructions) {
  await getWorkingRpc();

  const walletSigner = createNoopSigner(address(walletAddr));

  const { value: latestBlockhash } = await withRpcFallback(client => client.getLatestBlockhash().send());

  const txMsg = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(walletSigner, m),
    m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    m => appendTransactionMessageInstructions(instructions, m),
  );

  // Signs with any KeyPairSigners referenced in the message (e.g. new stake account).
  const partiallySigned = await partiallySignTransactionMessageWithSigners(txMsg);

  // Serialize and hand to wallet.
  const wireBytes = getTransactionEncoder().encode(partiallySigned);
  const signedBytes = await signViaWallet(new Uint8Array(wireBytes));
  // The wallet may have swapped in a fresher blockhash while the user decided;
  // expiry is tracked against the one it actually signed.
  const signedBlockhash = readSignedBlockhash(signedBytes);
  const lifetime = signedBlockhash === latestBlockhash.blockhash
    ? latestBlockhash
    : { blockhash: signedBlockhash, lastValidBlockHeight: null };

  // Re-broadcast elsewhere only when a provider could not take the request at
  // all; a JSON-RPC error (e.g. a preflight rejection) is the network's answer.
  const signature = await withRpcFallback(
    client => client.sendTransaction(uint8ToBase64(signedBytes), { encoding: 'base64' }).send(),
    { shouldFallback: isTransportError },
  );

  await confirmTransactionPolling(signature, lifetime);
  return signature;
}

// Alpenglow's 200 ms slots leave a blockhash valid for only ~30 s, and
// statuses can trail the expiry: keep looking for the signature for a few
// more polls before reporting the transaction as expired.
const EXPIRY_GRACE_POLLS = 3;

async function isLifetimeExpired({ blockhash, lastValidBlockHeight }) {
  if (lastValidBlockHeight != null) {
    return await rpc.getBlockHeight().send() > lastValidBlockHeight;
  }
  const { value } = await rpc.isBlockhashValid(blockhash, { commitment: 'processed' }).send();
  return !value;
}

async function confirmTransactionPolling(signature, lifetime, commitment = 'confirmed') {
  const maxRetries = 90;
  const interval = 1000;
  let expiredPolls = 0;

  for (let i = 0; i < maxRetries; i++) {
    let status = null;
    try {
      ({ value: [status] } = await rpc.getSignatureStatuses([signature]).send());
    } catch (_) { /* transient RPC failure: poll again */ }

    if (status?.confirmationStatus === commitment || status?.confirmationStatus === 'finalized') {
      if (status.err) throw getSolanaErrorFromTransactionError(status.err);
      return status;
    }
    if (!status) {
      let expired = false;
      try { expired = await isLifetimeExpired(lifetime); } catch (_) { /* unknown yet: keep polling */ }
      if (expired && ++expiredPolls > EXPIRY_GRACE_POLLS) throw new Error(TX_MESSAGES.expired);
    }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error('Transaction confirmation timeout after 90s');
}

// ============================================
// Staking Transaction (Create + Initialize + Delegate)
// ============================================
async function stakeSOL(amountSOL) {
  if (!connectedWallet || !walletAddr) {
    setStatus('Wallet not connected', 'error');
    return;
  }

  if (!Number.isFinite(amountSOL) || amountSOL <= 0) {
    setStatus('Enter a valid stake amount', 'error');
    return;
  }

  setStatus('Building transaction...', 'pending');

  try {
    await getWorkingRpc();
    const rentLamports = await getStakeRentLamports();
    const minimumLamports = await getMinimumDelegationLamports();
    const depositLamports = BigInt(Math.floor(amountSOL * LAMPORTS_PER_SOL));
    if (depositLamports < minimumLamports) {
      setStatus(`Minimum stake: ${getMinimumStakeSol().toLocaleString()} SOL`, 'error');
      return;
    }
    const rentReserveSol = Number(rentLamports) / LAMPORTS_PER_SOL;
    if (amountSOL > balance - rentReserveSol - 0.00001) {
      setStatus('Insufficient balance (stake-account rent and network fee are required)', 'error');
      return;
    }

    const walletSigner = createNoopSigner(address(walletAddr));
    const stakeSigner = await generateKeyPairSigner();
    const instructions = buildCreateAndDelegateInstructions({
      walletAddress: walletAddr,
      walletSigner,
      stakeSigner,
      voteAddress: NETWORKS[currentNetwork].validator,
      depositLamports,
      rentLamports,
    });

    setStatus('Awaiting wallet approval...', 'pending');

    const signature = await buildAndSend(instructions);

    setStatus('Staked successfully!', 'success');
    appendExplorerLink('stake-status', signature, 'tx');

    setTimeout(() => {
      updateBalance();
      loadStakeAccounts();
    }, 2000);
  } catch (err) {
    handleTxError('Staking failed', err);
  }
}

// ============================================
// Stake Account Management
// ============================================

// Stake accounts where the wallet is the staker or the withdrawer. Both
// queries must answer: a partial list would silently hide stakes.
async function discoverStakePubkeys(walletBase58) {
  const results = await Promise.all(STAKE_AUTHORITY_OFFSETS.map(offset => withIndexedRpc(client => client
    .getProgramAccounts(STAKE_PROGRAM_ADDRESS, stakeDiscoveryConfig(offset, walletBase58))
    .send())));

  const pubkeys = new Set();
  for (const accounts of results) {
    // Hard-reject malformed pubkeys. Legitimate RPC nodes always return
    // base58 strings; malformed entries come from custom/attacker RPCs and
    // would otherwise reach innerHTML interpolations.
    for (const { pubkey } of accounts) {
      if (isValidPubkey(pubkey)) pubkeys.add(pubkey);
    }
  }
  return [...pubkeys];
}

let stakesLoadSeq = 0;

// Refresh stays disabled while a load runs, so repeated clicks don't multiply
// the burst against rate-limited public RPCs.
async function loadStakeAccounts() {
  if (!walletAddr) return;
  const seq = ++stakesLoadSeq;
  const refreshBtn = $('refresh-stakes-btn');
  if (refreshBtn) refreshBtn.disabled = true;
  try {
    await loadStakeAccountsFor(walletAddr, seq);
  } finally {
    if (refreshBtn && seq === stakesLoadSeq) refreshBtn.disabled = false;
  }
}

async function loadStakeAccountsFor(wallet, seq) {
  // Only the latest load may render: an older one finishing late (e.g. a
  // failed run racing a manual refresh) must not overwrite newer results,
  // and a wallet switch or disconnect makes any in-flight load stale.
  const isStale = () => seq !== stakesLoadSeq || walletAddr !== wallet;

  const stakesSection = $('my-stakes');
  const stakesList = $('stakes-list');
  if (!stakesSection || !stakesList) return;

  stakesSection.style.display = 'block';
  stakesList.innerHTML = '<p class="stakes-loading"><span class="stakes-spinner" aria-hidden="true"></span>Loading stakes...</p>';

  // The indexed endpoint only finds the accounts (it serves raw base64), and
  // getMultipleAccounts supplies the parsed data the UI works from.
  let all;
  try {
    const pubkeys = await discoverStakePubkeys(wallet);
    all = toStakeRecords(pubkeys, await fetchParsedAccounts(pubkeys));
  } catch (err) {
    if (isStale()) return;
    console.error('Failed to load stake accounts:', err);
    stakesList.innerHTML = '<p class="stakes-empty">Failed to load stakes. <span class="stakes-retry" id="retry-stakes">⟳ Retry</span></p>';
    $('retry-stakes')?.addEventListener('click', loadStakeAccounts);
    return;
  }
  if (isStale()) return;

  stakeAccounts = all;
  await refreshStakeStates(all);
  if (isStale()) return;
  renderStakeAccounts(all);

  // Fetch validator names/icons in the background. The first render uses
  // whatever's already cached (so returning users see them instantly); when
  // new entries land we re-render to refresh the new validators in place.
  prefetchValidatorMetadata(all).then(changed => {
    if (changed && stakeAccounts === all) renderStakeAccounts(all);
  }).catch(() => {});
}

let currentEpoch = null;
let epochEndTime = null;
let epochTimerInterval = null;

async function fetchCurrentEpoch() {
  try {
    const epochInfo = await withRpcFallback(client => client.getEpochInfo().send());
    currentEpoch = Number(epochInfo.epoch);
    await calculateEpochEndTime(epochInfo);
    return currentEpoch;
  } catch (_) {
    return currentEpoch;
  }
}

async function fetchStakeHistory() {
  const entries = await withRpcFallback(async client => {
    const result = await client.getAccountInfo(address(STAKE_HISTORY_ADDRESS), {
      encoding: 'jsonParsed',
    }).send();
    const parsed = result?.value?.data?.parsed?.info;
    if (!Array.isArray(parsed)) throw new Error('Stake History is unavailable');
    return parsed;
  });
  return entries.map(entry => ({
    epoch: BigInt(entry.epoch),
    effective: BigInt(entry.stakeHistory.effective),
    activating: BigInt(entry.stakeHistory.activating),
    deactivating: BigInt(entry.stakeHistory.deactivating),
  }));
}

async function refreshStakeStates(accounts) {
  stakeStateCache.clear();
  try {
    const [epoch, stakeHistory] = await Promise.all([
      fetchCurrentEpoch(),
      fetchStakeHistory(),
    ]);
    if (!Number.isFinite(epoch)) throw new Error('Current epoch is unavailable');

    for (const account of accounts) {
      const details = getStakeDetails(account);
      let state;
      if (details.type === 'delegated' && details.voter) {
        const activation = getStakeActivatingAndDeactivating({
          activationEpoch: BigInt(details.activationEpoch),
          deactivationEpoch: BigInt(details.deactivationEpoch || U64_MAX),
          stake: BigInt(details.delegatedStake),
          // The official algorithm does not inspect the voter pubkey, but the
          // package's Delegation shape includes it.
          voterPubkey: new Uint8Array(),
        }, BigInt(epoch), stakeHistory);
        state = activationToState(activation);
      } else {
        state = fallbackStakeState(account, epoch);
      }
      account.activation = state;
      stakeStateCache.set(account.pubkey, state);
    }
    return true;
  } catch (err) {
    console.warn('Exact stake-state calculation failed:', err?.message);
    for (const account of accounts) {
      const state = fallbackStakeState(account, currentEpoch);
      account.activation = state;
      stakeStateCache.set(account.pubkey, state);
    }
    return false;
  }
}

async function calculateEpochEndTime(epochInfo) {
  if (!epochInfo) return null;
  const slotsRemaining = Number(epochInfo.slotsInEpoch - epochInfo.slotIndex);
  let slotTimeMs = 200; // Alpenglow slot time; measured samples override it

  try {
    const samples = await rpc.getRecentPerformanceSamples(10).send();
    if (samples && samples.length > 0) {
      let totalSlots = 0, totalSeconds = 0;
      for (const sample of samples) {
        totalSlots += Number(sample.numSlots);
        totalSeconds += Number(sample.samplePeriodSecs);
      }
      if (totalSlots > 0) slotTimeMs = (totalSeconds / totalSlots) * 1000;
    }
  } catch (_) { /* use default */ }

  const msRemaining = slotsRemaining * slotTimeMs;
  epochEndTime = Date.now() + msRemaining;
  startEpochTimer();
  return epochEndTime;
}

function formatTimeRemaining(ms) {
  if (ms <= 0) return 'any moment now';
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function updateEpochTimers() {
  if (!epochEndTime) return;
  const remaining = epochEndTime - Date.now();
  const text = remaining > 0 ? formatTimeRemaining(remaining) : 'Epoch ending...';
  document.querySelectorAll('.epoch-countdown').forEach(el => { el.textContent = text; });

  if (remaining <= 0 && epochTimerInterval) {
    clearInterval(epochTimerInterval);
    epochTimerInterval = null;
    epochEndTime = null;
    setTimeout(() => {
      fetchCurrentEpoch();
      loadStakeAccounts();
    }, 5000);
  }
}

function startEpochTimer() {
  if (epochTimerInterval) clearInterval(epochTimerInterval);
  epochTimerInterval = setInterval(updateEpochTimers, 1000);
  updateEpochTimers();
}

function renderStakeAccounts(accounts) {
  const stakesList = $('stakes-list');
  if (!stakesList) return;

  if (accounts.length === 0) {
    // RPC sometimes returns an empty list when its index is stale or it
    // silently rate-limits, so give the user an obvious way to refetch
    // without remounting the whole section.
    stakesList.innerHTML = '<p class="stakes-empty">No stake accounts found. <span class="stakes-retry" id="retry-empty-stakes">⟳ Retry</span></p>';
    $('retry-empty-stakes')?.addEventListener('click', loadStakeAccounts);
    return;
  }

  // Sort by state priority (things that need attention soonest first), then by
  // balance within each group. Inactive on top because the user can withdraw
  // right now; deactivating is next because it transitions to inactive after
  // the epoch; activating and active are stable, shown below.
  const STATE_ORDER = { inactive: 0, deactivating: 1, activating: 2, active: 3, unknown: 4 };
  for (const acc of accounts) cachedStakeState(acc);

  accounts.sort((a, b) => {
    const aOrder = STATE_ORDER[cachedStakeState(a).state] ?? 99;
    const bOrder = STATE_ORDER[cachedStakeState(b).state] ?? 99;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.lamports === b.lamports ? 0 : (a.lamports > b.lamports ? -1 : 1);
  });

  stakesList.innerHTML = '';

  for (const acc of accounts) {
    const pubkey = acc.pubkey;
    const lamports = acc.lamports;
    const sol = (Number(lamports) / LAMPORTS_PER_SOL).toFixed(4);
    const parsed = acc.parsed;
    const { state, label } = cachedStakeState(acc);
    const delegation = parsed?.info?.stake?.delegation;
    const validatorVote = delegation?.voter;

    const canManage = hasStakeAuthority(acc, walletAddr);
    const canWithdraw = hasWithdrawAuthority(acc, walletAddr);
    const isLocked = isStakeLocked(acc, currentEpoch);
    const pending = getPendingRedelegation(pubkey);

    // The full merge predicate includes authorities, lockup, activation
    // progress, validator, activation epoch and observed vote credits.
    const hasMergeable = accounts.some(other => {
      if (other.pubkey === pubkey) return false;
      return canMergeStakeAccounts(acc, other, currentEpoch);
    });

    // Used both for hiding Redelegate (no-op when staked to us) and for
    // gating icon rendering (we only load our own validator's icon, never
    // third-party — names stay visible as escaped text).
    const ourValidatorAddr = NETWORKS[currentNetwork]?.validator;
    const isOurValidator = validatorVote && ourValidatorAddr && validatorVote === ourValidatorAddr;

    const card = document.createElement('div');
    card.className = 'stake-card';

    const showTimer = state === 'activating' || state === 'deactivating';
    const timerHtml = showTimer
      ? `<div class="stake-epoch-timer"><span class="epoch-timer-icon">&#9202;</span> Epoch ends in: <span class="epoch-countdown">calculating...</span></div>`
      : '';
    const pendingHtml = pending
      ? `<div class="stake-pending-target">Redelegation target: <span>${escapeHtml(truncateAddress(pending.targetValidator))}</span></div>`
      : '';

    // Render validator with name + icon if we have cached metadata, else
    // fall back to the truncated vote address.
    const meta = validatorVote ? validatorMetaCache[validatorVote] : null;
    // iconDataUrl is base64 we generated ourselves — safe. iconUrl is third-
    // party (validator-published); reject if it has chars that could break
    // out of the src attribute. AND only show icon at all for our own
    // validator, never third-party (defense in depth — fetchValidatorMetaOnChain
    // also skips loading icons for non-our validators, but old localStorage
    // entries from before that change could still have data).
    const rawIconUrl = isOurValidator
      ? (meta?.iconDataUrl || (isSafeHttpsUrl(meta?.iconUrl) ? meta.iconUrl : null))
      : null;
    const validatorLabel = meta?.name || (validatorVote ? truncateAddress(validatorVote) : '');
    // Note: data: URLs from our own base64 conversion don't need escaping
    // (we built them), but we escape anyway for consistency.
    // No inline onerror here — our CSP blocks inline event handlers. The
    // broken-icon fallback is wired up programmatically after appendChild.
    const iconHtml = rawIconUrl
      ? `<img src="${escapeHtml(rawIconUrl)}" alt="" class="stake-validator-icon" width="16" height="16">`
      : '';

    // pubkey and validatorVote passed isValidPubkey at ingress; the values
    // we slot into innerHTML are base58 only. Still escape any attribute
    // that takes user-typeable input (validator names from on-chain info)
    // because anyone can publish arbitrary bytes there.
    const safePubkey = escapeHtml(pubkey);
    const safeVote = escapeHtml(validatorVote || '');

    card.innerHTML = `
      <div class="stake-card-header">
        <div class="stake-card-info">
          <a href="${escapeHtml(getExplorerUrl('account', pubkey))}" target="_blank" rel="noopener" class="stake-address" title="${safePubkey}">${escapeHtml(truncateAddress(pubkey))}</a>
          <span class="stake-state-badge state-${escapeHtml(state)}">${escapeHtml(label)}</span>
        </div>
        <span class="stake-amount">${sol} SOL</span>
      </div>
      ${validatorVote ? `<div class="stake-validator">Validator: ${iconHtml}<a href="${escapeHtml(getExplorerUrl('account', validatorVote))}" target="_blank" rel="noopener" title="${safeVote}">${escapeHtml(validatorLabel)}</a></div>` : ''}
      ${timerHtml}
      ${pendingHtml}
      <div class="stake-actions" data-pubkey="${safePubkey}" data-state="${escapeHtml(state)}" data-validator="${safeVote}">
        ${buildActionButtons({ state, hasMergeable, isOurValidator, canManage, canWithdraw, isLocked, pendingTarget: pending?.targetValidator })}
      </div>
    `;

    stakesList.appendChild(card);

    // Hide a broken validator icon. Replaces the old inline onerror,
    // which our CSP (no inline event handlers) silently blocked.
    const iconEl = card.querySelector('.stake-validator-icon');
    if (iconEl) iconEl.addEventListener('error', () => iconEl.remove());
  }

  updateEpochTimers();
}

function buildActionButtons({ state, hasMergeable, isOurValidator, canManage, canWithdraw, isLocked, pendingTarget }) {
  const buttons = [];

  if ((state === 'active' || state === 'activating') && canManage) {
    buttons.push(`<button type="button" class="btn btn-xs btn-outline stake-action-btn" data-action="deactivate">Deactivate</button>`);
    buttons.push(`<button type="button" class="btn btn-xs btn-outline stake-action-btn" data-action="split">Split</button>`);
    if (hasMergeable) {
      buttons.push(`<button type="button" class="btn btn-xs btn-outline stake-action-btn" data-action="merge">Merge</button>`);
    }
    // Hide Redelegate when the stake already points to our validator.
    if (!isOurValidator && !pendingTarget) {
      buttons.push(`<button type="button" class="btn btn-xs btn-outline stake-action-btn stake-redelegate-btn" data-action="redelegate">Redelegate</button>`);
    }
  }

  if (state === 'inactive') {
    if (canWithdraw && !isLocked) {
      buttons.push(`<button type="button" class="btn btn-xs btn-primary stake-action-btn" data-action="withdraw">Withdraw</button>`);
    }
    if (canWithdraw && isLocked) {
      buttons.push(`<span class="stake-wait-text">Stake lockup is still active</span>`);
    }
    if (canManage && hasMergeable) {
      buttons.push(`<button type="button" class="btn btn-xs btn-outline stake-action-btn" data-action="merge">Merge</button>`);
    }
    if (canManage && pendingTarget) {
      buttons.push(`<button type="button" class="btn btn-xs btn-primary stake-action-btn stake-redelegate-btn" data-action="complete-redelegate">Complete Redelegation</button>`);
      buttons.push(`<button type="button" class="btn btn-xs btn-outline stake-action-btn" data-action="cancel-redelegate">Cancel Target</button>`);
    }
  }

  if (state === 'deactivating' && canManage) {
    // The user can short-circuit the cooldown by re-delegating to the
    // same validator — Solana's DelegateStake on a deactivating stake
    // resets deactivation_epoch back to u64::MAX. If the stake was
    // fully active before deactivate, it's active again instantly.
    buttons.push(`<button type="button" class="btn btn-xs btn-primary stake-action-btn" data-action="reactivate">Reactivate</button>`);
    buttons.push(`<span class="stake-wait-text">or wait until cooldown is fully complete</span>`);
  }

  if (state === 'unknown') {
    buttons.push(`<span class="stake-wait-text">Exact state unavailable — refresh before taking action</span>`);
  }

  if (buttons.length === 0) {
    buttons.push(`<span class="stake-wait-text">No actions available for this wallet authority</span>`);
  }

  return buttons.join('');
}

// ============================================
// Stake Operations: Deactivate, Withdraw, Split, Merge
// ============================================

function requireAuthority(stakePubkeyStr, authorityType = 'stake') {
  if (!isValidPubkey(stakePubkeyStr)) {
    setStatus('Invalid stake account', 'error');
    return null;
  }
  const account = stakeAccounts.find(item => item.pubkey === stakePubkeyStr);
  if (!account) {
    setStatus('Stake account is no longer available. Refresh and try again.', 'error');
    return null;
  }
  const allowed = authorityType === 'withdraw'
    ? hasWithdrawAuthority(account, walletAddr)
    : hasStakeAuthority(account, walletAddr);
  if (!allowed) {
    setStatus(`Connected wallet is not the ${authorityType} authority for this account`, 'error');
    return null;
  }
  return account;
}

async function deactivateStake(stakePubkeyStr) {
  if (!connectedWallet || !walletAddr) return;
  if (!requireAuthority(stakePubkeyStr)) return;

  setStatus('Deactivating stake...', 'pending');
  try {
    const walletSigner = createNoopSigner(address(walletAddr));
    const signature = await buildAndSend([
      buildDeactivateInstruction({ stakeAddress: stakePubkeyStr, walletSigner }),
    ]);

    setStatus('Stake deactivated!', 'success');
    appendExplorerLink('stake-status', signature, 'tx');

    setTimeout(() => {
      updateBalance();
      loadStakeAccounts();
    }, 2000);
  } catch (err) {
    handleTxError('Deactivation failed', err);
  }
}

// Cancel an in-progress deactivation by re-delegating to the SAME validator.
// Solana's DelegateStake on a deactivating stake resets its deactivation_epoch
// back to u64::MAX. If the stake was fully active before deactivate was
// called, it's immediately active again (no warmup). If it was still
// activating when deactivated, it goes back to activating.
async function reactivateStake(stakePubkeyStr, validatorVoteStr) {
  if (!connectedWallet || !walletAddr) return;
  if (!requireAuthority(stakePubkeyStr)) return;
  if (!validatorVoteStr) {
    setStatus('Cannot reactivate: validator unknown', 'error');
    return;
  }

  setStatus('Reactivating stake...', 'pending');
  try {
    const walletSigner = createNoopSigner(address(walletAddr));
    const signature = await buildAndSend([
      buildDelegateInstruction({
        stakeAddress: stakePubkeyStr,
        voteAddress: validatorVoteStr,
        walletSigner,
      }),
    ]);

    setStatus('Stake reactivated!', 'success');
    clearPendingRedelegation(stakePubkeyStr);
    appendExplorerLink('stake-status', signature, 'tx');

    setTimeout(() => {
      updateBalance();
      loadStakeAccounts();
    }, 2000);
  } catch (err) {
    handleTxError('Reactivation failed', err);
  }
}

async function withdrawStake(stakePubkeyStr) {
  if (!connectedWallet || !walletAddr) return;
  const account = requireAuthority(stakePubkeyStr, 'withdraw');
  if (!account) return;
  if (isStakeLocked(account, currentEpoch)) {
    setStatus('This stake account is still locked and cannot be withdrawn yet', 'error');
    return;
  }

  setStatus('Withdrawing stake...', 'pending');
  try {
    const walletSigner = createNoopSigner(address(walletAddr));
    const signature = await buildAndSend([
      buildWithdrawInstruction({
        stakeAddress: stakePubkeyStr,
        walletAddress: walletAddr,
        walletSigner,
        lamports: account.lamports,
      }),
    ]);

    setStatus('Withdrawal successful!', 'success');
    clearPendingRedelegation(stakePubkeyStr);
    appendExplorerLink('stake-status', signature, 'tx');

    setTimeout(() => {
      updateBalance();
      loadStakeAccounts();
    }, 2000);
  } catch (err) {
    handleTxError('Withdrawal failed', err);
  }
}

async function executeSplit(stakePubkeyStr, amount) {
  if (!connectedWallet || !walletAddr) return;
  const account = requireAuthority(stakePubkeyStr);
  if (!account) return;

  setStatus('Splitting stake...', 'pending');
  try {
    await getWorkingRpc();

    const walletSigner = createNoopSigner(address(walletAddr));
    const newStakeSigner = await generateKeyPairSigner();
    const rentLamports = await getStakeRentLamports();
    const minimumLamports = await getMinimumDelegationLamports();
    const lamports = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));
    const maxLamports = account.lamports - BigInt(rentLamports) - minimumLamports;
    if (lamports < minimumLamports || lamports > maxLamports) {
      setStatus('Split amount is outside the safe range for this stake account', 'error');
      return;
    }
    if (BigInt(Math.floor(balance * LAMPORTS_PER_SOL)) < BigInt(rentLamports) + 10_000n) {
      setStatus('Insufficient wallet balance to fund the new stake account rent and fee', 'error');
      return;
    }

    const signature = await buildAndSend(buildSplitInstructions({
      stakeAddress: stakePubkeyStr,
      walletSigner,
      newStakeSigner,
      lamports,
      rentLamports,
    }));

    setStatus('Stake split successfully!', 'success');
    appendExplorerLink('stake-status', signature, 'tx');

    setTimeout(() => {
      updateBalance();
      loadStakeAccounts();
    }, 2000);
  } catch (err) {
    handleTxError('Split failed', err);
  }
}

async function executeMerge(destPubkeyStr, sourcePubkeyStr) {
  if (!connectedWallet || !walletAddr) return;
  const destination = requireAuthority(destPubkeyStr);
  const source = requireAuthority(sourcePubkeyStr);
  if (!destination || !source) return;
  if (!canMergeStakeAccounts(destination, source, currentEpoch)) {
    setStatus('These stake accounts are no longer merge-compatible. Refresh and try again.', 'error');
    return;
  }

  setStatus('Merging stakes...', 'pending');
  try {
    const walletSigner = createNoopSigner(address(walletAddr));
    const signature = await buildAndSend([
      buildMergeInstruction({
        destinationAddress: destPubkeyStr,
        sourceAddress: sourcePubkeyStr,
        walletSigner,
      }),
    ]);

    setStatus('Stakes merged successfully!', 'success');
    appendExplorerLink('stake-status', signature, 'tx');

    setTimeout(() => {
      updateBalance();
      loadStakeAccounts();
    }, 2000);
  } catch (err) {
    handleTxError('Merge failed', err);
  }
}

// ============================================
// Modal System
// ============================================
function showModal(title, contentHtml) {
  return new Promise((resolve) => {
    closeModal();
    const previouslyFocused = document.activeElement;

    const overlay = document.createElement('div');
    overlay.className = 'stake-modal-overlay';
    overlay.id = 'stake-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'stake-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'stake-modal-title');
    // Title is escaped defensively — every call site uses a literal today,
    // but it's a function parameter and easy to misuse later.
    modal.innerHTML = `
      <div class="stake-modal-header">
        <h4 id="stake-modal-title">${escapeHtml(title)}</h4>
        <button type="button" class="stake-modal-close" id="modal-close-btn" aria-label="Close dialog">&times;</button>
      </div>
      <div class="stake-modal-body">${contentHtml}</div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => overlay.classList.add('visible'));

    const close = (value) => {
      document.removeEventListener('keydown', onKeyDown);
      overlay.classList.remove('visible');
      setTimeout(() => {
        overlay.remove();
        previouslyFocused?.focus?.();
      }, 200);
      resolve(value);
    };

    const onKeyDown = (event) => {
      if (event.key === 'Escape') close(null);
    };

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    modal.querySelector('#modal-close-btn').addEventListener('click', () => close(null));
    document.addEventListener('keydown', onKeyDown);
    modal.querySelector('#modal-close-btn').focus();

    overlay._close = close;
  });
}

function closeModal() {
  const existing = $('stake-modal-overlay');
  if (existing) {
    if (typeof existing._close === 'function') existing._close(null);
    else existing.remove();
  }
}

async function showSplitModal(stakePubkeyStr) {
  const stakeAcc = requireAuthority(stakePubkeyStr);
  if (!stakeAcc) return;

  const totalSol = Number(stakeAcc.lamports) / LAMPORTS_PER_SOL;
  let minRentSol;
  let minStakeSol;
  try {
    const [rentLamports, minDelegationLamports] = await Promise.all([
      getStakeRentLamports(),
      getMinimumDelegationLamports(),
    ]);
    minRentSol = Number(rentLamports) / LAMPORTS_PER_SOL;
    minStakeSol = Number(minDelegationLamports) / LAMPORTS_PER_SOL;
  } catch (err) {
    handleTxError('Could not load current rent requirement', err);
    return;
  }
  if (balance < minRentSol + 0.00001) {
    setStatus('Insufficient wallet balance to fund the new stake account rent', 'error');
    return;
  }
  const maxSplit = totalSol - minRentSol - minStakeSol;
  if (maxSplit < minStakeSol) {
    setStatus('Stake balance is too small to leave both accounts above the network minimum delegation', 'error');
    return;
  }

  const html = `
    <p class="modal-desc">Split off SOL into a new stake account</p>
    <div class="modal-info-row">
      <span>Current stake</span>
      <span class="modal-info-value">${totalSol.toFixed(4)} SOL</span>
    </div>
    <div class="modal-info-row">
      <span>Max split amount</span>
      <span class="modal-info-value">${maxSplit.toFixed(4)} SOL</span>
    </div>
    <label class="modal-label" for="split-amount-input">Amount to split (SOL)</label>
    <div class="modal-input-group">
      <input type="number" id="split-amount-input" class="modal-input" placeholder="0.00" min="${minStakeSol}" max="${maxSplit.toFixed(4)}" step="0.01">
      <button type="button" class="btn btn-xs modal-max-btn" id="split-max-btn">MAX</button>
    </div>
    <p class="modal-hint" id="split-hint"></p>
    <button type="button" class="btn btn-primary btn-full modal-confirm-btn" id="split-confirm-btn" disabled>Split Stake</button>
  `;

  showModal('Split Stake', html);

  requestAnimationFrame(() => {
    const input = $('split-amount-input');
    const confirmBtn = $('split-confirm-btn');
    const hint = $('split-hint');
    const maxBtn = $('split-max-btn');

    maxBtn?.addEventListener('click', () => {
      input.value = maxSplit.toFixed(4);
      input.dispatchEvent(new Event('input'));
    });

    input?.addEventListener('input', () => {
      const val = parseFloat(input.value);
      if (isNaN(val) || val < minStakeSol) {
        hint.textContent = `Minimum: ${minStakeSol.toLocaleString()} SOL`;
        hint.style.color = 'var(--red)';
        confirmBtn.disabled = true;
      } else if (val > maxSplit) {
        hint.textContent = `Maximum: ${maxSplit.toFixed(4)} SOL`;
        hint.style.color = 'var(--red)';
        confirmBtn.disabled = true;
      } else {
        const remaining = totalSol - val;
        hint.textContent = `Remaining in original: ${remaining.toFixed(4)} SOL`;
        hint.style.color = 'var(--text-muted)';
        confirmBtn.disabled = false;
      }
    });

    confirmBtn?.addEventListener('click', () => {
      const amount = parseFloat(input.value);
      if (!isNaN(amount) && amount >= minStakeSol && amount <= maxSplit) {
        closeModal();
        executeSplit(stakePubkeyStr, amount);
      }
    });
  });
}

function showMergeModal(destPubkeyStr) {
  if (!connectedWallet || !walletAddr) return;

  const destAccount = requireAuthority(destPubkeyStr);
  if (!destAccount) return;

  // Reuse the cached state map populated at render time so what the user saw
  // (badge text, button visibility) matches what we filter by here.
  const destState = cachedStakeState(destAccount);
  const mergeableAccounts = stakeAccounts.filter(a => {
    return canMergeStakeAccounts(destAccount, a, currentEpoch);
  });

  if (mergeableAccounts.length === 0) {
    const hint =
      destState.state === 'active'     ? 'No active stake has matching authorities, lockup, validator and vote credits' :
      destState.state === 'activating' ? 'No stake is compatible with this activation epoch and metadata' :
      destState.state === 'inactive'   ? 'No inactive stake has matching authorities and lockup' :
      'This stake is not in a state that supports merging';
    setStatus(hint, 'error');
    return;
  }

  const destSol = (Number(destAccount.lamports) / LAMPORTS_PER_SOL).toFixed(4);

  const optionsHtml = mergeableAccounts.map((a, i) => {
    const sol = (Number(a.lamports) / LAMPORTS_PER_SOL).toFixed(4);
    const st = cachedStakeState(a);
    return `
      <button type="button" class="merge-option-btn" data-merge-index="${i}">
        <div class="merge-option-info">
          <span class="merge-option-addr">${escapeHtml(truncateAddress(a.pubkey))}</span>
          <span class="stake-state-badge state-${escapeHtml(st.state)}">${escapeHtml(st.label)}</span>
        </div>
        <span class="merge-option-amount">${sol} SOL</span>
      </button>
    `;
  }).join('');

  const html = `
    <p class="modal-desc">Merge another stake account into this one</p>
    <div class="modal-info-row">
      <span>Destination</span>
      <span class="modal-info-value">${escapeHtml(truncateAddress(destPubkeyStr))} (${destSol} SOL)</span>
    </div>
    <label class="modal-label">Select source account to merge</label>
    <div class="merge-options-list">${optionsHtml}</div>
  `;

  showModal('Merge Stakes', html);

  requestAnimationFrame(() => {
    document.querySelectorAll('.merge-option-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.mergeIndex, 10);
        const sourceAccount = mergeableAccounts[idx];
        closeModal();
        executeMerge(destPubkeyStr, sourceAccount.pubkey);
      });
    });
  });
}

// ============================================
// Redelegate — two transactions with a cooldown between them
// ============================================

let cachedValidators = null;
let validatorsLastFetch = 0;
const VALIDATORS_CACHE_TTL = 5 * 60 * 1000;

async function loadValidators() {
  const now = Date.now();
  if (cachedValidators && (now - validatorsLastFetch) < VALIDATORS_CACHE_TTL) {
    return cachedValidators;
  }

  try {
    await getWorkingRpc();
    const voteAccounts = await rpc.getVoteAccounts().send();
    const validators = [
      ...voteAccounts.current.map(v => ({ ...v, delinquent: false })),
      ...voteAccounts.delinquent.map(v => ({ ...v, delinquent: true })),
    ];
    // activatedStake is bigint from kit — convert for sorting/display.
    validators.sort((a, b) => a.activatedStake === b.activatedStake ? 0 : (a.activatedStake > b.activatedStake ? -1 : 1));

    cachedValidators = validators;
    validatorsLastFetch = now;
    return validators;
  } catch (err) {
    console.error('Failed to load validators:', err);
    return cachedValidators || [];
  }
}

function showRedelegateModal(stakePubkeyStr) {
  if (!connectedWallet || !walletAddr) return;

  const stakeAcc = requireAuthority(stakePubkeyStr);
  if (!stakeAcc) return;

  const stakeSol = (Number(stakeAcc.lamports) / LAMPORTS_PER_SOL).toFixed(4);
  const currentValidator = stakeAcc.parsed?.info?.stake?.delegation?.voter || '';

  const html = `
    <p class="modal-desc">Choose the validator this same stake account will use after cooldown</p>
    <div class="modal-info-row">
      <span>Stake account</span>
      <span class="modal-info-value">${escapeHtml(truncateAddress(stakePubkeyStr))} (${stakeSol} SOL)</span>
    </div>
    ${currentValidator ? `<div class="modal-info-row"><span>Current validator</span><span class="modal-info-value">${escapeHtml(truncateAddress(currentValidator))}</span></div>` : ''}
    <label class="modal-label" for="validator-search-input">Search validators</label>
    <input type="text" id="validator-search-input" class="modal-input" placeholder="Search by vote account...">
    <div id="validator-list" class="validator-list">
      <p class="stakes-loading"><span class="stakes-spinner" aria-hidden="true"></span>Loading validators...</p>
    </div>
    <p class="modal-hint redelegate-note">Step 1 deactivates the current delegation and saves your target locally. When cooldown is fully complete, this page will offer Step 2 to delegate the same stake account to the selected validator.</p>
  `;

  showModal('Redelegate Stake', html);

  requestAnimationFrame(async () => {
    const listEl = $('validator-list');
    const searchInput = $('validator-search-input');

    const validators = await loadValidators();

    function renderValidatorList(filter = '') {
      const filterLower = filter.toLowerCase();
      const filtered = validators.filter(v => {
        if (v.votePubkey === currentValidator) return false;
        if (v.delinquent) return false;
        if (!filter) return true;
        return v.votePubkey.toLowerCase().includes(filterLower) ||
               (v.nodePubkey && v.nodePubkey.toLowerCase().includes(filterLower));
      }).slice(0, 50);

      if (filtered.length === 0) {
        listEl.innerHTML = '<p class="stakes-empty">No validators found</p>';
        return;
      }

      listEl.innerHTML = filtered.map(v => {
        // votePubkey from getVoteAccounts must be a valid pubkey; commission
        // is a u8 (0-100). Skip anything malformed before it reaches the DOM.
        if (!isValidPubkey(v.votePubkey)) return '';
        const commission = Number(v.commission);
        if (!Number.isFinite(commission)) return '';
        const stake = (Number(v.activatedStake) / LAMPORTS_PER_SOL).toFixed(0);
        return `
          <button type="button" class="validator-option-btn" data-vote="${escapeHtml(v.votePubkey)}">
            <div class="validator-option-info">
              <span class="validator-option-addr">${escapeHtml(truncateAddress(v.votePubkey))}</span>
              <span class="validator-option-commission">${commission}% fee</span>
            </div>
            <span class="validator-option-stake">${Number(stake).toLocaleString()} SOL staked</span>
          </button>
        `;
      }).join('');

      listEl.querySelectorAll('.validator-option-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const targetValidator = btn.dataset.vote;
          closeModal();
          executeRedelegate(stakePubkeyStr, targetValidator);
        });
      });
    }

    renderValidatorList();

    searchInput?.addEventListener('input', () => {
      renderValidatorList(searchInput.value.trim());
    });
  });
}

async function executeRedelegate(stakePubkeyStr, newValidatorVoteStr) {
  if (!connectedWallet || !walletAddr) return;
  if (!requireAuthority(stakePubkeyStr)) return;
  if (!isValidPubkey(newValidatorVoteStr)) {
    setStatus('Selected validator address is invalid', 'error');
    return;
  }

  setStatus('Step 1/2: deactivating current delegation...', 'pending');
  try {
    const walletSigner = createNoopSigner(address(walletAddr));
    const signature = await buildAndSend([
      buildDeactivateInstruction({ stakeAddress: stakePubkeyStr, walletSigner }),
    ]);

    setPendingRedelegation(stakePubkeyStr, newValidatorVoteStr);
    setStatus(`Step 1/2 complete. Target ${truncateAddress(newValidatorVoteStr)} is saved; complete redelegation when cooldown finishes.`, 'success');
    appendExplorerLink('stake-status', signature, 'tx');

    setTimeout(() => {
      updateBalance();
      loadStakeAccounts();
    }, 2000);
  } catch (err) {
    handleTxError('Redelegation step 1 failed', err);
  }
}

async function completeRedelegation(stakePubkeyStr) {
  if (!connectedWallet || !walletAddr) return;
  const account = requireAuthority(stakePubkeyStr);
  if (!account) return;
  const pending = getPendingRedelegation(stakePubkeyStr);
  if (!pending || !isValidPubkey(pending.targetValidator)) {
    setStatus('No valid redelegation target is saved for this stake account', 'error');
    return;
  }
  if (cachedStakeState(account).state !== 'inactive') {
    setStatus('Cooldown is not fully complete yet. Refresh after the stake becomes inactive.', 'error');
    return;
  }

  setStatus('Step 2/2: awaiting delegation approval...', 'pending');
  try {
    const walletSigner = createNoopSigner(address(walletAddr));
    const signature = await buildAndSend([
      buildDelegateInstruction({
        stakeAddress: stakePubkeyStr,
        voteAddress: pending.targetValidator,
        walletSigner,
      }),
    ]);
    clearPendingRedelegation(stakePubkeyStr);
    setStatus(`Redelegation submitted to ${truncateAddress(pending.targetValidator)}. The stake will warm up according to Solana's activation schedule.`, 'success');
    appendExplorerLink('stake-status', signature, 'tx');
    setTimeout(() => {
      updateBalance();
      loadStakeAccounts();
    }, 2000);
  } catch (err) {
    handleTxError('Redelegation step 2 failed', err);
  }
}

function cancelRedelegation(stakePubkeyStr) {
  clearPendingRedelegation(stakePubkeyStr);
  setStatus('Saved redelegation target cleared. No transaction was sent.', 'success');
  renderStakeAccounts(stakeAccounts);
}

// ============================================
// Helpers
// ============================================
function appendExplorerLink(statusElId, signature, type) {
  const statusEl = $(statusElId);
  if (!statusEl) return;
  const link = document.createElement('a');
  link.href = getExplorerUrl(type, signature);
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = ' View on Explorer';
  link.style.color = 'var(--blue-light)';
  link.style.textDecoration = 'underline';
  statusEl.appendChild(link);
}

function handleTxError(prefix, err) {
  console.error(`${prefix}:`, err);
  const cleanMsg = describeTxError(err);
  if (cleanMsg === TX_MESSAGES.cancelled) {
    setStatus(cleanMsg, 'error');
  } else {
    setStatus(`${prefix}: ${cleanMsg}`, 'error');
  }
}

// ============================================
// Custom RPC Management
// ============================================
function updateRpcStatus(text, status = 'connected') {
  const statusEl = $('rpc-status');
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = `rpc-status rpc-${status}`;
}

async function setCustomRpc(url) {
  if (!url || !url.trim()) {
    resetCustomRpc();
    return;
  }

  try {
    url = normalizeRpcUrl(url);
  } catch (err) {
    updateRpcStatus(err.message, 'error');
    return;
  }

  updateRpcStatus('Testing connection...', 'pending');

  try {
    const testClient = createSolanaRpc(url);
    await testClient.getEpochInfo().send();

    customRpcUrl = url;
    localStorage.setItem('0node-custom-rpc', url);
    resetRpc();
    markRpcHealthy(testClient, 0, rpcGeneration);
    stakeRentLamports = null;
    minimumDelegationLamports = null;
    stakeStateCache.clear();
    await Promise.all([getStakeRentLamports(), getMinimumDelegationLamports()]);

    updateRpcStatus('Connected — default RPC providers are disabled', 'connected');

    if (walletAddr) {
      updateBalance();
      loadStakeAccounts();
    }
  } catch (err) {
    updateRpcStatus('Connection failed: ' + (err.message || 'Unknown error').slice(0, 50), 'error');
  }
}

function resetCustomRpc() {
  customRpcUrl = '';
  localStorage.removeItem('0node-custom-rpc');
  resetRpc();
  stakeRentLamports = null;
  minimumDelegationLamports = null;
  stakeStateCache.clear();
  getWorkingRpc()
    .then(() => Promise.all([getStakeRentLamports(), getMinimumDelegationLamports()]))
    .catch(() => {});

  const input = $('custom-rpc-input');
  if (input) input.value = '';
  updateRpcStatus('Using default RPC', 'connected');
}

// ============================================
// Initialization
// ============================================
export function initStaking() {
  resetRpc();
  updateMinimumStakeUi();
  getWorkingRpc()
    .then(() => Promise.all([getStakeRentLamports(), getMinimumDelegationLamports()]))
    .catch(() => {});

  updateWalletButtons();
  setTimeout(updateWalletButtons, 500);
  setTimeout(updateWalletButtons, 1500);
  setTimeout(updateWalletButtons, 3000);

  document.querySelectorAll('.net-btn').forEach(btn => {
    btn.addEventListener('click', () => switchNetwork(btn.dataset.network));
  });

  // Main wallet list AND the "More wallets" collapsible share the same
  // click-to-connect behavior — listen on both containers.
  $('staking-connect')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.wallet-option');
    if (!btn) return;
    connectWallet(btn.dataset.wallet);
  });

  $('wallet-btn-nav')?.addEventListener('click', () => {
    document.getElementById('stake-now')?.scrollIntoView({ behavior: 'smooth' });
  });

  $('disconnect-btn')?.addEventListener('click', () => disconnectWallet());

  $('max-btn')?.addEventListener('click', async () => {
    try {
      const rentReserveSol = Number(await getStakeRentLamports()) / LAMPORTS_PER_SOL;
      const max = Math.max(0, balance - rentReserveSol - 0.00001);
      $('stake-amount').value = max.toFixed(4);
      $('stake-amount').dispatchEvent(new Event('input'));
    } catch (err) {
      handleTxError('Could not load current rent requirement', err);
    }
  });

  $('stake-amount')?.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    const reserve = stakeRentLamports === null ? 0 : Number(stakeRentLamports) / LAMPORTS_PER_SOL;
    const valid = !isNaN(val) && val >= getMinimumStakeSol() && val <= balance - reserve - 0.00001;
    $('stake-btn').disabled = !valid;
  });

  $('stake-btn')?.addEventListener('click', () => {
    const amount = parseFloat($('stake-amount').value);
    if (!isNaN(amount)) stakeSOL(amount);
  });

  $('refresh-stakes-btn')?.addEventListener('click', loadStakeAccounts);

  $('stakes-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.stake-action-btn');
    if (!btn) return;

    const actionsDiv = btn.closest('.stake-actions');
    const pubkey = actionsDiv?.dataset.pubkey;
    const validator = actionsDiv?.dataset.validator;
    const action = btn.dataset.action;

    if (!pubkey) return;

    switch (action) {
      case 'deactivate': deactivateStake(pubkey); break;
      case 'withdraw': withdrawStake(pubkey); break;
      case 'split': showSplitModal(pubkey); break;
      case 'merge': showMergeModal(pubkey); break;
      case 'redelegate': showRedelegateModal(pubkey); break;
      case 'complete-redelegate': completeRedelegation(pubkey); break;
      case 'cancel-redelegate': cancelRedelegation(pubkey); break;
      case 'reactivate': reactivateStake(pubkey, validator); break;
    }
  });

  const rpcToggle = $('rpc-toggle-btn');
  const rpcPanel = $('custom-rpc-panel');
  rpcToggle?.addEventListener('click', () => {
    const visible = rpcPanel.style.display !== 'none';
    rpcPanel.style.display = visible ? 'none' : 'block';
    rpcToggle.classList.toggle('active', !visible);
  });

  $('rpc-apply-btn')?.addEventListener('click', () => {
    const url = $('custom-rpc-input')?.value;
    setCustomRpc(url);
  });

  $('rpc-reset-btn')?.addEventListener('click', resetCustomRpc);

  if (customRpcUrl) {
    const input = $('custom-rpc-input');
    if (input) input.value = customRpcUrl;
    if (rpcPanel) rpcPanel.style.display = 'block';
    if (rpcToggle) rpcToggle.classList.add('active');
    setCustomRpc(customRpcUrl);
  }

  // Auto-reconnect — only if the user didn't explicitly disconnect.
  // Wallet extensions keep the site trusted and re-expose isConnected/
  // publicKey even after provider.disconnect(), so we need to gate on
  // an intent flag we store ourselves.
  let userDisconnected = false;
  try { userDisconnected = localStorage.getItem('0node-wallet-disconnected') === '1'; } catch (_) { /* storage unavailable */ }
  if (!userDisconnected) {
    setTimeout(() => {
      for (const [id, wallet] of Object.entries(WALLETS)) {
        const provider = wallet.getProvider();
        if (provider?.isConnected && provider.publicKey) {
          const nextAddress = walletPublicKeyToString(provider.publicKey);
          if (!isValidPubkey(nextAddress)) continue;
          connectedWallet = { id, provider };
          walletAddr = nextAddress;
          bindWalletEvents(provider);
          showConnectedUI();
          break;
        }
      }
    }, 500);
  }
}
