// ============================================
// 0node Validator Stats
//
// Source of truth: Stakewiz API (https://api.stakewiz.com). They index
// validators once stake is activated and expose all the numbers we show:
// APYs (total/staking/jito), commission, uptime, voting stats, stake weight.
//
// Resolution order on page load:
//   1. localStorage cache (instant paint, even if stale)
//   2. Stakewiz API (authoritative, replaces cache on success)
//   3. Explicit unavailable state (we never present hardcoded metrics as live)
//
// TTL = 5 min. Cached data remains visible during an outage, but its age and
// the failed refresh are shown explicitly.
//
// Note on pubkey usage: we query by vote account (6cvBCfFX...rryR).
// The identity pubkey (6NDen7aDi...Q5Pg) isn't used here — it's only
// for node-level infra tools.
// ============================================

const VOTE_ACCOUNT = '6cvBCfFXugkTqgSFVPvzhoWaLbhHWvZfSsZadWP5rryR';
const API_URL = `https://api.stakewiz.com/validator/${VOTE_ACCOUNT}`;
const CACHE_KEY = '0node_validator_stats';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const API_TIMEOUT = 8_000;

const FIELD_RANGES = {
  total_apy: [0, 100],
  staking_apy: [0, 100],
  jito_apy: [0, 100],
  commission: [0, 100],
  uptime: [0, 100],
  vote_success: [0, 100],
  skip_rate: [0, 100],
  stake_weight: [0, 100],
};

// Stakewiz has returned commission both as a percent (5) and as basis points
// (500). Normalize at the API boundary and reject impossible values before
// they can reach the page or persist in localStorage.
export function normalizeValidatorStats(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid validator stats payload');

  const normalized = {};
  for (const [key, [min, max]] of Object.entries(FIELD_RANGES)) {
    if (raw[key] == null || raw[key] === '') continue;
    let value = Number(raw[key]);
    if (!Number.isFinite(value)) continue;
    if (key === 'commission' && value > 100 && value <= 10_000) value /= 100;
    if (value < min || value > max) continue;
    normalized[key] = value;
  }

  if (Object.keys(normalized).length === 0) {
    throw new Error('Validator stats payload contains no valid metrics');
  }
  return normalized;
}

// All metrics the "Validator Performance" section shows. Each row:
//   key      — field name in the Stakewiz response
//   elId     — DOM id of the stat-value span
//   decimals — precision in the animated number
const FIELDS = [
  { key: 'total_apy',    elId: 'stat-total-apy',    decimals: 2, label: 'Total APY' },
  { key: 'staking_apy',  elId: 'stat-staking-apy',  decimals: 2, label: 'Staking APY' },
  { key: 'jito_apy',     elId: 'stat-jito-apy',     decimals: 2, label: 'Jito MEV APY' },
  { key: 'commission',   elId: 'stat-commission',   decimals: 0, label: 'Commission' },
  { key: 'uptime',       elId: 'stat-uptime',       decimals: 1, label: 'Uptime' },
  { key: 'vote_success', elId: 'stat-vote-success', decimals: 2, label: 'Voting Rate' },
  { key: 'skip_rate',    elId: 'stat-skip-rate',    decimals: 2, label: 'Skip Rate' },
  { key: 'stake_weight', elId: 'stat-stake-weight', decimals: 4, label: 'Stake Weight' },
];

function getCached() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    const age = Date.now() - Number(ts || 0);
    return { data: normalizeValidatorStats(data), fresh: age < CACHE_TTL, age };
  } catch {
    try { localStorage.removeItem(CACHE_KEY); } catch (_) { /* storage unavailable */ }
    return null;
  }
}

function setCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
  } catch { /* quota exceeded — ignore */ }
}

async function fetchStats() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT);
  let response;
  try {
    response = await fetch(API_URL, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`API ${response.status}`);
  const data = normalizeValidatorStats(await response.json());
  setCache(data);
  return data;
}

// --- Loading / error UI helpers ---

function setAllLoading() {
  for (const field of FIELDS) {
    const el = document.getElementById(field.elId);
    if (el) {
      el.classList.add('stat-loading');
      el.textContent = '';
    }
  }
}

function clearLoading() {
  for (const field of FIELDS) {
    document.getElementById(field.elId)?.classList.remove('stat-loading');
  }
}

function markErrorOnUpdatedRow(message) {
  const updated = document.getElementById('stats-updated');
  if (updated) {
    updated.textContent = message;
    updated.classList.add('stats-updated-error');
  }
}

function markMetricsUnavailable() {
  clearLoading();
  for (const field of FIELDS) {
    const el = document.getElementById(field.elId);
    if (!el) continue;
    el.textContent = '—';
    el.classList.add('stat-error');
  }
}

// --- Animation ---

function animateValue(el, target, decimals, duration = 1500) {
  const start = parseFloat(el.textContent) || 0;
  const startTime = performance.now();

  function update(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = start + (target - start) * eased;
    el.textContent = current.toFixed(decimals);
    if (progress < 1) requestAnimationFrame(update);
  }

  requestAnimationFrame(update);
}

// --- Apply data to DOM ---

function formatAge(ageMs) {
  const minutes = Math.max(1, Math.round(ageMs / 60_000));
  if (minutes < 60) return `${minutes} min old`;
  const hours = Math.round(minutes / 60);
  return `${hours}h old`;
}

function applyStats(data, source = 'api', age = 0) {
  clearLoading();

  for (const field of FIELDS) {
    const el = document.getElementById(field.elId);
    if (!el || data[field.key] == null) continue;
    el.classList.remove('stat-error');
    animateValue(el, parseFloat(data[field.key]), field.decimals);
  }

  // Total APY also shown inline in the staking panel.
  const apyInfo = document.getElementById('staking-panel-apy');
  if (apyInfo && data.total_apy != null) {
    apyInfo.textContent = `~${parseFloat(data.total_apy).toFixed(2)}%`;
  }

  // Commission is repeated in the staking form ("0node (N% fee)").
  const commissionInfo = document.getElementById('validator-commission');
  if (commissionInfo && data.commission != null) {
    commissionInfo.textContent = `0node (${data.commission}% fee)`;
  }

  // Hero badge — first thing the user sees.
  const badge = document.getElementById('badge-commission');
  if (badge && data.commission != null) {
    badge.textContent = `${data.commission}% Commission`;
  }

  const updated = document.getElementById('stats-updated');
  if (updated) {
    updated.classList.remove('stats-updated-error');
    if (source === 'cache') {
      updated.textContent = `Showing cached data (${formatAge(age)}), refreshing...`;
    } else {
      const now = new Date();
      updated.textContent = `Updated ${now.toLocaleTimeString()}`;
    }
  }
}

// --- Entry ---

export function initValidatorStats() {
  // 1. Paint from cache immediately if available, else show skeletons.
  const cached = getCached();
  if (cached?.data) {
    applyStats(cached.data, 'cache', cached.age);
  } else {
    setAllLoading();
  }

  // 2. Fetch fresh data from the API.
  fetchStats()
    .then(data => applyStats(data, 'api'))
    .catch(err => {
      console.warn('Stakewiz API fetch failed:', err.message);
      if (cached?.data) {
        markErrorOnUpdatedRow(`Live metrics unavailable — cached data is ${formatAge(cached.age)}. Retrying automatically.`);
      } else {
        markMetricsUnavailable();
        markErrorOnUpdatedRow('Live metrics unavailable. Retrying automatically.');
      }
    });

  // 4. Background refresh every TTL. Silent on failure — old numbers remain.
  setInterval(() => {
    fetchStats()
      .then(data => applyStats(data, 'api'))
      .catch(() => { /* silent — cached/fallback data stays on screen */ });
  }, CACHE_TTL);
}
