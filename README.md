# 0node.io

Client-side Solana staking interface for the 0node validator. The site is a
static Vite application: it has no backend, database, analytics, or custody of
wallet keys. Transactions are built in the browser and signed by the user's
wallet extension.

## Development

Requirements: Bun 1.4.3 and Node.js 22 (matching Netlify and CI).

```bash
bun install --frozen-lockfile
bun run dev
```

Run the complete local quality gate before every deployment:

```bash
bun run check
bun audit
```

`bun run check` runs ESLint, unit/configuration tests, and the production
build. The tests cover every transaction instruction builder, validator-metric
normalization, authority and lockup checks, stake-state classification, merge
eligibility, custom RPC validation, dynamic network limits, and deployment
cache invariants.

## Architecture

- `src/modules/staking.js` — wallet connection, RPC access, transactions, and UI orchestration.
- `src/modules/stake-instructions.js` — tested Solana Stake/System instruction builders.
- `src/modules/stake-utils.js` — pure authority/state/merge validation used by tests.
- `src/modules/rpc-accounts.js` — account discovery queries, parsed-record filtering, and signed validator-info selection.
- `src/modules/tx-utils.js` — user-facing transaction error messages (by kit error code) and the blockhash a wallet actually signed.
- `src/modules/validator.js` — validated Stakewiz metrics and cache/error states.
- `netlify.toml` — build command, redirects, CSP, and cache headers.
- `public/sw.js` — same-origin offline shell and asset cache.

Free public RPCs differ in what they serve: the endpoint that still answers
`getProgramAccounts` returns raw base64 only and throttles bursts, while the
jsonParsed-capable ones refuse indexed queries. Stake accounts and validator
info are therefore discovered as pubkeys only (zero-length `dataSlice`) on
`indexedEndpoints`, then read with `getMultipleAccounts` + `jsonParsed` from
the general endpoints. Validator names are shown only from validator-info
records signed by the validator identity.

Stake activation is calculated client-side from the Stake History sysvar using
Anza's official `@anza-xyz/solana-rpc-get-stake-activation` algorithm. Actions
are displayed only when the connected address has the required stake or
withdraw authority. Redelegation is intentionally a two-transaction flow:
deactivate, wait for cooldown, then delegate the same stake account to the
saved target validator.

## Deployment

Netlify builds `main` with the committed `bun.lock` and publishes `dist/`.
Assets are content-hashed and immutable; `sw.js` is always revalidated. After
push, verify the live asset hashes and the response headers before considering
the deployment complete.

Security reports: [support@0node.io](mailto:support@0node.io).
