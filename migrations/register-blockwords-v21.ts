/**
 * Register Blockwords (`words`) in CM v2.1 GameProgramRegistryV2.
 *
 * Blockwords GameState layout (after 8-byte Anchor discriminator):
 *   offset  0..8   : discriminator
 *   offset  8..16  : game_id (u64)
 *   offset 16..48  : p1 (Pubkey) — host
 *   offset 48..80  : p2 (Pubkey) — first guesser (Duel mode)
 *   offset    80   : status (u8: 0=Waiting, 1=Active, 2=Finished)
 *   offset    81   : winner_flag (u8: 0=draw, 1=p1, 2=p2)
 *   offset 82..114 : word_hash ([u8;32])
 *   ...
 *   total SPACE (ex-discriminator) = 434 → min_account_len = 442
 *
 * Wagering restricted to Duel mode (2 players). OneVsMany games still play,
 * just not through CM v2.1 resolution.
 *
 * Idempotent. Run:
 *   ANCHOR_WALLET=$HOME/.config/solana/id.json \
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   yarn ts-node migrations/register-blockwords-v21.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { ContentionMarkets } from "../target/types/contention_markets";

const WORDS_PROGRAM_ID = new PublicKey(
  "3XA1rz4f83FoTyvB7g1XHhsb4bx9SrUSBDtpLtAttU4o"
);

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace
    .ContentionMarkets as Program<ContentionMarkets>;
  const admin = (provider.wallet as any).payer;

  console.log("=".repeat(64));
  console.log("Register Blockwords in CM v2.1 Adapter Registry");
  console.log("=".repeat(64));
  console.log("CM Program:        ", program.programId.toBase58());
  console.log("Blockwords Program:", WORDS_PROGRAM_ID.toBase58());
  console.log("Admin:             ", admin.publicKey.toBase58());

  const [registryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_program_registry_v2"), WORDS_PROGRAM_ID.toBuffer()],
    program.programId
  );
  console.log("Registry PDA:      ", registryPda.toBase58());

  const existing = await provider.connection.getAccountInfo(registryPda);
  if (existing) {
    const entry = await program.account.gameProgramRegistryV2.fetch(
      registryPda
    );
    const labelStr = Buffer.from(entry.label)
      .toString("utf8")
      .replace(/\u0000+$/, "");
    console.log("\n⏭  Already registered:");
    console.log("   label:             ", labelStr);
    console.log("   is_active:         ", entry.isActive);
    console.log("   p1_offset:         ", entry.adapter.p1Offset);
    console.log("   p2_offset:         ", entry.adapter.p2Offset);
    console.log("   status_offset:     ", entry.adapter.statusOffset);
    console.log(
      "   status_finished:   ",
      entry.adapter.statusFinishedValue
    );
    console.log("   winner_offset:     ", entry.adapter.winnerOffset);
    console.log(
      "   winner_p1/p2/draw: ",
      entry.adapter.winnerP1Value,
      entry.adapter.winnerP2Value,
      entry.adapter.winnerDrawValue
    );
    console.log("   min_account_len:   ", entry.adapter.minAccountLen);
    return;
  }

  const adapter = {
    p1Offset: 16,
    p2Offset: 48,
    statusOffset: 80,
    statusFinishedValue: 2,
    winnerOffset: 81,
    winnerP1Value: 1,
    winnerP2Value: 2,
    winnerDrawValue: 0,
    minAccountLen: 442,
  };

  console.log("\n→ Registering with adapter:");
  console.log(JSON.stringify(adapter, null, 2));

  const sig = await program.methods
    .registerGameProgramV2("blockwords", adapter as any)
    .accountsStrict({
      gameProgramRegistryV2: registryPda,
      gameProgram: WORDS_PROGRAM_ID,
      protocolConfig: PublicKey.findProgramAddressSync(
        [Buffer.from("protocol_config")],
        program.programId
      )[0],
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`\n✅ Registered blockwords in v2.1 registry — tx ${sig}`);
  console.log(
    `   https://explorer.solana.com/tx/${sig}?cluster=devnet`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
