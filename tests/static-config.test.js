import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('production configuration', () => {
  test('Netlify uses a frozen lockfile and does not cache sw.js as an immutable asset', () => {
    const config = readFileSync('netlify.toml', 'utf8');
    expect(config).toContain('bun install --frozen-lockfile');
    expect(config).toContain('for = "/sw.js"');
    expect(config).toContain('for = "/assets/*.js"');
    expect(config).not.toContain('for = "/*.js"');
  });

  test('static buttons declare their type', () => {
    const html = readFileSync('index.html', 'utf8');
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.filter(button => !/\btype=/.test(button))).toEqual([]);
  });

  test('service worker cache version is explicitly bumped', () => {
    const sw = readFileSync('public/sw.js', 'utf8');
    expect(sw).toContain("const CACHE_NAME = '0node-v5'");
  });

  test('staking minimum and rent are read from the active RPC', () => {
    const staking = readFileSync('src/modules/staking.js', 'utf8');
    expect(staking).toContain('rpc.getStakeMinimumDelegation().send()');
    expect(staking).toContain('rpc.getMinimumBalanceForRentExemption(STAKE_ACCOUNT_SPACE).send()');
    expect(staking).not.toContain('const MIN_STAKE =');
  });

  test('getProgramAccounts never relies on jsonParsed output', () => {
    // The free indexed RPCs answer getProgramAccounts with raw base64 only.
    const staking = readFileSync('src/modules/staking.js', 'utf8');
    const calls = staking.split('.getProgramAccounts(').slice(1);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.slice(0, 160)).not.toContain('jsonParsed');
  });

  test('unknown paths get a real 404 page instead of a soft-404 home page', () => {
    const config = readFileSync('netlify.toml', 'utf8');
    expect(config).not.toMatch(/from = "\/\*"\s+to = "\/index\.html"/);
    expect(readFileSync('public/404.html', 'utf8')).toContain('<meta name="robots" content="noindex">');
    expect(config).toMatch(/from = "\/security\.txt"\s+to = "\/\.well-known\/security\.txt"\s+status = 301/);
  });

  test('sitemap lists real pages only', () => {
    const urls = readFileSync('public/sitemap.xml', 'utf8').match(/<loc>[^<]+<\/loc>/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter(url => url.includes('#'))).toEqual([]);
  });

  test('CI and Netlify pin the same Bun version', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8').match(/bun-version: ([\d.]+)/)?.[1];
    const netlify = readFileSync('netlify.toml', 'utf8').match(/BUN_VERSION = "([\d.]+)"/)?.[1];
    expect(ci).toBeTruthy();
    expect(ci).toBe(netlify);
  });

  test('mainnet RPC list has an indexed endpoint and no browser-blocked provider', () => {
    const staking = readFileSync('src/modules/staking.js', 'utf8');
    expect(staking).toMatch(/indexedEndpoints: \[\s*'https:\/\//);
    // api.mainnet-beta.solana.com answers 403 to every browser Origin.
    expect(staking).not.toContain("'https://api.mainnet-beta.solana.com'");
  });
});
