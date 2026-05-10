/**
 * CM v2 bootstrap — Day 2 of 5-day plan (2026-04-20)
 *
 * One-shot initialization after deploying CM v2 to devnet:
 *   1. Verify v1 ProtocolConfig still deserializes (regression guard)
 *   2. Call initialize_protocol_v2 to create the ProtocolConfigV2 PDA
 *   3. Register chess as the first game program in GameProgramRegistry
 *
 * Idempotent: re-running skips any step that's already complete.
 *
 * Run:
 *   cd contention-markets
 *   ANCHOR_WALLET=$HOME/.config/solana/id.json \
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   yarn ts-node migrations/init-v2.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { ContentionMarkets } from "../target/types/contention_markets";

// Known devnet addresses (from ENGINEERING/TECHNICAL/DEVNET_CONTRACTS.md)
const POOL_SPONSOR_PDA = new PublicKey(
  "FNKPP6q2qk3wqMd7ErkWYk98etrZfuMnvGh2EQKdrrcJ"
);
const CHESS_PROGRAM_ID = new PublicKey(
  "3LVg8uUsHtq6fusjrSfyGUCLQ83TFegDKmY3bCNz3QYr"
);

// V2 fee defaults
const V2_PROTOCOL_FEE_BPS = 80;      // 0.80% protocol treasury
const V2_PARTNER_FEE_BPS = 100;      // 1.00% partner
const V2_POOL_SPONSOR_FEE_BPS = 20;  // 0.20% PoolSponsor

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .ContentionMarkets as Program<ContentionMarkets>;
  const admin = (provider.wallet as any).payer;

  console.log("=".repeat(60));
  console.log("CM v2 bootstrap");
  console.log("Program:", program.programId.toBase58());
  console.log("Admin:  ", admin.publicKey.toBase58());
  console.log("Cluster:", provider.connection.rpcEndpoint);
  console.log("=".repeat(60));

  // ── Step 1: v1 regression guard ───────────────────────────────────────
  const [protocolConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    program.programId
  );
  console.log("\n[1/3] Verifying v1 ProtocolConfig still deserializes...");
  const v1Config = await program.account.protocolConfig.fetch(
    protocolConfigPda
  );
  console.log("      admin:           ", v1Config.admin.toBase58());
  console.log("      treasury:        ", v1Config.treasury.toBase58());
  console.log("      protocol_fee_bps:", v1Config.protocolFeeBps);
  if (!v1Config.admin.equals(admin.publicKey)) {
    throw new Error(
      `v1 admin mismatch: on-chain=${v1Config.admin.toBase58()} wallet=${admin.publicKey.toBase58()}`
    );
  }
  console.log("      ✅ v1 deserialize OK — v2 upgrade did not break v1 state");

  // ── Step 2: initialize_protocol_v2 ────────────────────────────────────
  const [protocolConfigV2Pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config_v2")],
    program.programId
  );
  console.log("\n[2/3] initialize_protocol_v2 → ", protocolConfigV2Pda.toBase58());

  const existingV2 = await provider.connection.getAccountInfo(
    protocolConfigV2Pda
  );
  if (existingV2) {
    const v2Config = await program.account.protocolConfigV2.fetch(
      protocolConfigV2Pda
    );
    console.log("      ⏭  Already initialized — skipping");
    console.log("      pool_sponsor:   ", v2Config.poolSponsor.toBase58());
    console.log("      protocol_fee:   ", v2Config.protocolFeeBps, "bps");
    console.log("      partner_fee:    ", v2Config.partnerFeeBps, "bps");
    console.log("      pool_sp_fee:    ", v2Config.poolSponsorFeeBps, "bps");
  } else {
    const sig = await program.methods
      .initializeProtocolV2(
        POOL_SPONSOR_PDA,
        V2_PROTOCOL_FEE_BPS,
        V2_PARTNER_FEE_BPS,
        V2_POOL_SPONSOR_FEE_BPS
      )
      .accountsStrict({
        protocolConfigV2: protocolConfigV2Pda,
        protocolConfig: protocolConfigPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("      ✅ initialized — tx", sig);
    console.log(
      "      explorer: https://explorer.solana.com/tx/" + sig + "?cluster=devnet"
    );
  }

  // ── Step 3: register chess as first game program ──────────────────────
  const [chessRegistryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_program_registry"), CHESS_PROGRAM_ID.toBuffer()],
    program.programId
  );
  console.log(
    "\n[3/3] register_game_program(chess) →",
    chessRegistryPda.toBase58()
  );

  const existingChess = await provider.connection.getAccountInfo(
    chessRegistryPda
  );
  if (existingChess) {
    const entry = await program.account.gameProgramRegistry.fetch(
      chessRegistryPda
    );
    console.log("      ⏭  Already registered — skipping");
    console.log("      game_program:   ", entry.gameProgram.toBase58());
    console.log(
      "      label:          ",
      Buffer.from(entry.label).toString("utf8").replace(/\u0000+$/, "")
    );
    console.log("      is_active:      ", entry.isActive);
  } else {
    const sig = await program.methods
      .registerGameProgram("chess")
      .accountsStrict({
        gameProgramRegistry: chessRegistryPda,
        gameProgram: CHESS_PROGRAM_ID,
        protocolConfig: protocolConfigPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("      ✅ registered — tx", sig);
    console.log(
      "      explorer: https://explorer.solana.com/tx/" + sig + "?cluster=devnet"
    );
  }

  console.log("\n" + "=".repeat(60));
  console.log("CM v2 bootstrap complete");
  console.log("=".repeat(60));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
