# Security

`contention-markets` is the on-chain settlement program for skill-contest pari-mutuel markets on Solana. Deployed to **devnet only** at program ID `69YfcveAbLbJ5LNERjq6k5wnszfZbXMYVzx2j8Ca1Xo8`. Not yet audited for mainnet. This document describes the current security posture.

## Status

**Devnet:** live, hardened against the major Solana hack classes, validated by 11 end-to-end tests in `gamerplex-tests/`.

**Mainnet:** **not deployed.** Skill-Battle surface ships only after the items in [Pre-mainnet hardening](#pre-mainnet-hardening) clear.

## Threat model

The program holds USDF (or any SPL mint) stakes from two players in a skill-contest match. After the off-chain game finishes, anyone can settle the market — payout direction comes from the on-chain `game_state` account, not from the keeper's input. The protocol's value-at-risk:

1. **Player stakes** in active markets (held in vault PDAs). Should pay out to the on-chain winner only.
2. **Treasury fees** (0.80% protocol + 1.00% partner + 0.20% PoolBacker) accumulating in admin-controlled token accounts.
3. **PoolBacker rent pool** funding ephemeral rollup operations.

Adversaries we model: malicious player, malicious keeper, malicious partner, malicious admin (with key compromise), unaudited consumer programs.

## Hack-class coverage

The contract is defended against the major Solana program-level hack classes:

| Class | Defense | Coverage |
|---|---|---:|
| **Integer overflow** (Drift, Kelp class) | `checked_*` arithmetic everywhere; no `+=` / `-=` on `u64` fields | **45 guards · 0 unsafe** |
| **Missing signer / auth bypass** (Wormhole class) | `Signer<>` constraints + `has_one = admin` + `constraint =` on every privileged path | **25 + 62 = 87 gates** |
| **PDA bump confusion** | Use stored bumps from account data, never re-derive at use-time | **39 stored / 10 init-only** |
| **Improper CPI signing** | `CpiContext::new_with_signer` with vault PDA seeds; user→vault transfers use user authority | **21 invoke_signed / 2 user-auth** |
| **Double-resolve / replay** (Polymarket class) | Idempotency `require!(!market.resolved)` etc. on all money paths | **All 4 money paths gated** |
| **Close-account exploit** | `close = authority` + cooldown + vault-empty + caller≠beneficiary | **Both close ix protected** |
| **OOB read on permissionless resolve** | Adapter offset bounds + length check + binding triple-match | **7-layer defense in resolve** |
| **Vault drain** | Vault PDA self-signs only with stored `vault_bump` | **Single signing path** |
| **UncheckedAccount surfaces** | Handler validates owner / size / sentinel for every unchecked account | **All 7 validated** |
| **Drift-class admin-replay** | `deadline: i64` parameter on every admin instruction; reject `now > deadline` and `deadline > now + 7 days` | **All admin ix gated** |

## Critical paths

### `resolve_market_from_game_pda` (permissionless settlement)

Seven sequential validation layers before any token transfer:

1. **Idempotency** — `require!(!market.resolved)`
2. **PoolBacker sentinel** — `pool_backer.key() == config_v2.pool_backer`
3. **Binding triple-match** — market PDA + game_state pubkey + game_program pubkey
4. **Account ownership** — `game_state.owner == registry_v2.game_program`
5. **Adapter offset bounds** — verifies p1/p2 offset + 32 ≤ data length, status/winner offsets in range
6. **Player match** — game_state's p1/p2 must equal market's p1/p2 (order-tolerant)
7. **Status finished** — game_state byte at `status_offset` matches adapter's `status_finished_value`

Payout direction comes from `game_state` byte at `winner_offset`. Keeper cannot redirect funds.

### `back_contestant` + `claim_backer_winnings` (pari-mutuel pool)

- Double-claim prevention via `claimed: bool` flag
- Refund-on-cancel branch
- Proportional payout `(stake / winning_pool) × total_pool` computed in `u128` (no overflow), checked subtraction for fee
- Per-backer PDA `[b"backer_stake", market, backer]` — one record per (market, backer)

### `deposit`

- Depositor must equal `market.p1` or `market.p2` (Anchor `constraint =`)
- `checked_add` accumulation
- USDF→vault transfer with depositor authority (no PDA signing needed)

## Admin defenses

### Deadline gating (Drift-class defense)

Every admin instruction takes a `deadline: i64` parameter and rejects:
- `now > deadline` (deadline already passed)
- `deadline > now + 7 days` (deadline too far in future)

This prevents an attacker who intercepts a signed admin tx (e.g., from a leaked keypair backup) from replaying it indefinitely. Mirrors the pattern shipped in `gamerplex-arcade` after the Drift Apr-2026 incident.

Covered: `update_protocol_config`, `update_protocol_config_v2`, `register_partner`, `set_partner_active`, `update_partner_treasury`, `register_game_program`, `register_game_program_v2`.

### 48-hour timelock (defense in depth)

For the highest-blast-radius admin operation (`update_protocol_config_v2` — fees + PoolBacker destination), a propose/execute/cancel pattern is available:

1. `propose_admin_action(deadline, action)` — admin queues a change; PDA at `[b"timelock_proposal"]`
2. `execute_admin_action()` — anyone can crank execution after `proposed_at + 48h`
3. `cancel_admin_action()` — admin can abort before timelock elapses

Allows external observers a 48-hour window to react if a malicious change is queued (e.g., raising fees to 100%).

The direct `update_protocol_config_v2` ix remains available for fast operations on devnet but will be locked behind a Squads multisig + mandatory timelock for the mainnet skill-contest surface.

## Pre-mainnet hardening

Items required before the skill-contest surface ships to mainnet:

- [ ] **External security audit** — multi-firm review of contract + adapters
- [ ] **Squads 3-of-5 multisig** on upgrade authority — currently single admin keypair
- [ ] **Mandatory timelock** on all admin ix (not just `update_protocol_config_v2`) — propose/execute/cancel pattern across the board
- [ ] **Reproducible build attestation** — published SHA256 of the deployed `.so` matching a public build pipeline
- [ ] **24-hour soak test** — continuous play at scale, no stuck PDAs / auth drift
- [ ] **Geofencing** at the frontend layer — 10 US ban-states + sanctioned countries
- [ ] **Skill-predominance counsel memo** per game — required for Skill-Battle on AU mainnet

Tracking: see [`MAINNET_READINESS.md`](https://github.com/johnforfar/contention-gg/blob/main/ENGINEERING/MAINNET_READINESS.md) Skill-Battle Readiness Gate (64 items, 19/64 ✅ as of 2026-05-09).

## Reporting

Open a GitHub issue for non-sensitive reports.

For sensitive vulnerabilities, contact `info@pixelboss.io` directly. We'll acknowledge within 48 hours and coordinate disclosure.

## Verification

```bash
# Build the program from source
anchor build

# Confirm the on-chain .so matches the local build
sha256sum target/deploy/contention_markets.so
solana program dump 69YfcveAbLbJ5LNERjq6k5wnszfZbXMYVzx2j8Ca1Xo8 onchain.so --url devnet
sha256sum onchain.so
```

The hashes will match if the deployed program is the source code in this repo.

## Test receipts

End-to-end tests in `gamerplex-tests/src/e2e-{cyber-snake,cross-game}.test.ts` (private monorepo) drive the full money flow on devnet:

- 11/11 passing as of 2026-05-10 (post-deadline-gating + timelock deploy)
- Real USDF stakes, real on-chain settlement, real fee splits
- 6 tests cover the Cyber Snake Battle full path (`init_market_v21` → `bind` → 2× `deposit` → game match → `resolve_market_from_game_pda` → payout)
- 5 tests cover the cross-game adapter (chess + blockwords + cyber-snake all use the same CM v2.1 escrow)
