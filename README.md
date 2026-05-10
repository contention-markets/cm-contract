# Contention Markets v2.1 — On-chain settlement for skill contests

Anchor program that settles **skill-based contests** on Solana. Two players each pay an entry fee, a contest plays out off-chain (via MagicBlock ER or any registered game program), and the program reads the on-chain game-state PDA to pay out the prize pool to the winner.

**Status:** devnet · program ID `69YfcveAbLbJ5LNERjq6k5wnszfZbXMYVzx2j8Ca1Xo8` · not yet audited for mainnet (see [SECURITY.md](./SECURITY.md)).

## What it is

A game-agnostic settlement layer. Any on-chain Solana game whose state account contains `(p1, p2, status, winner)` bytes at fixed offsets can register an adapter and use this program for prize-pool payouts. No oracles. No off-chain trust. The program reads the game's state directly.

Live integrations on devnet:
- 🐍 **Cyber Snake Battle** — Tron lightcycle 1v1 on MagicBlock ER
- ♟ **Magic Chess** — fully on-chain 3D chess
- 🔮 **Blockwords** — hidden-info word duels
- ⚔ **Pet Legends Arena** *(stealth)* — coming next

## How it works

```
Player A + Player B each pay $X USDF entry fee
        │
        ▼
   contention-markets vault PDA holds the prize pool
        │
        ▼
   off-chain skill contest plays out (MagicBlock ER or any registered game)
        │
        ▼
   game program writes status=finished + winner-byte to its state PDA
        │
        ▼
   anyone (permissionless keeper) calls resolve_market_from_game_pda
        │
        ▼
   contract reads game state via per-game adapter, pays winner 98%
   protocol fee 0.80% / partner fee 1.00% / pool-backer fee 0.20%
```

Settlement is **permissionless** — the keeper signing the resolve tx has no influence on payout direction. The on-chain game state determines the winner.

## Key instructions

| Instruction | Who | Purpose |
|---|---|---|
| `initialize_market_v21` | Partner authority | Create a market for a 2-player contest with given mint, p1, p2, expiry |
| `bind_market_to_game` | Partner authority | Pin the market to a specific game-state PDA (prevents resolve-redirect) |
| `deposit` | Player A or B | Pay entry fee into market vault |
| `resolve_market_from_game_pda` | **Anyone** | Read game state, validate, pay winner 98% + fees |
| `back_contestant` | Third-party backer | Stake on a player in the pari-mutuel pool *(separate surface)* |
| `claim_backer_winnings` | Backer | Claim proportional payout after resolution |
| `register_game_program_v2` | Admin | Register a game program with its `(p1, p2, status, winner)` adapter offsets |
| `propose_admin_action` / `execute_admin_action` / `cancel_admin_action` | Admin / anyone after 48h | Timelocked fee changes |

All admin instructions take a `deadline: i64` parameter (Drift-class replay defense — see SECURITY.md).

## Adapter pattern (game-agnostic settlement)

Any new on-chain game integrates by registering its state layout:

```rust
GameAdapterSchema {
    p1_offset: u16,             // byte offset of p1 Pubkey
    p2_offset: u16,             // byte offset of p2 Pubkey
    status_offset: u16,         // byte offset of status byte
    status_finished_value: u8,  // value meaning "game over"
    winner_offset: u16,         // byte offset of winner byte
    winner_p1_value: u8,        // value meaning p1 wins
    winner_p2_value: u8,
    winner_draw_value: u8,
    min_account_len: u16,       // safety bound
}
```

Cyber Snake / Magic Chess / Blockwords all use the same `(p1@16, p2@48, status@80, finished=2)` layout — only winner-byte position differs.

## Fee structure

| Slice | Default | Goes to |
|---|---|---|
| Protocol fee | 0.80% (80 bps) | Protocol treasury |
| Partner fee (creator) | 1.00% (100 bps) | Game-creator's verified treasury |
| PoolBacker fee | 0.20% (20 bps) | ER-rent pool sentinel |
| **Total rake** | **2.00%** | |
| **Winner payout** | **98.00%** | |

Configurable per-component via `update_protocol_config_v2` (admin, deadline-gated). Fee changes for `update_protocol_config_v2` can also be queued via the 48h timelock for additional defense in depth.

## Build + test

```bash
# Build the program
anchor build

# Verify the on-chain .so matches local source
sha256sum target/deploy/contention_markets.so
solana program dump 69YfcveAbLbJ5LNERjq6k5wnszfZbXMYVzx2j8Ca1Xo8 onchain.so --url devnet
sha256sum onchain.so   # should match
```

End-to-end devnet tests live in [`gamerplex-tests`](https://github.com/johnforfar/contention-gg) (private monorepo). 11/11 skill-contest escrow tests passing as of 2026-05-10:

- 6 tests cover the full Cyber Snake Battle money flow (`init_market_v21` → `bind` → 2× `deposit` → game match → `resolve_market_from_game_pda` → payout)
- 5 tests cover the cross-game adapter (chess, blockwords, cyber-snake all settle through the same path)

## Security

See [SECURITY.md](./SECURITY.md) for full hack-class coverage, threat model, and pre-mainnet hardening list.

**Devnet status:** hardened against the major Solana program-level hack classes (overflow, signer bypass, double-resolve, OOB read, vault drain, admin replay). 11/11 e2e tests passing.

**Mainnet status:** not deployed. Skill-Battle surface ships only after external audit + Squads multisig + mandatory timelock + counsel skill-predominance memos clear.

## License

MIT — settlement orchestration only, no custody. Operating any frontend on top of this program is the operator's legal responsibility (skill-contest exemption applies in most US states + AU under contest framing per Skillz precedent; jurisdiction-specific counsel advice required before launching for real-money play).
