/**
 * Register Cyber Snake in CM v2.1 GameProgramRegistryV2.
 *
 * Cyber Snake GameState layout (after 8-byte Anchor discriminator):
 *   0..8   : discriminator
 *   8..16  : game_id (u64)
 *   16..48 : p1 (Pubkey)
 *   48..80 : p2 (Pubkey)
 *   80     : status (u8)  0=waiting, 1=active, 2=finished
 *   81     : winner_flag (u8)  0=draw, 1=p1, 2=p2
 *   82..   : tick/dirs/positions/grid ...
 *   total  : 8 + 32 + 32 + 1 + 1 + 4 + 1 + 1 + 2 + 2 + 4 + 4 + 1 + 1 + 1024 = 1117
 *            + 8-byte discriminator = 1125 bytes
 *
 * Idempotent.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { ContentionMarkets } from "../target/types/contention_markets";

const SNAKE_PROGRAM_ID = new PublicKey(
  "EK8gFE1ojW61QuLTvy6dHyLxCq5yjCnauJz8eisNPTk3"
);

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace
    .ContentionMarkets as Program<ContentionMarkets>;
  const admin = (provider.wallet as any).payer;

  console.log("=".repeat(64));
  console.log("Register Cyber Snake in CM v2.1 Adapter Registry");
  console.log("=".repeat(64));
  console.log("CM Program:         ", program.programId.toBase58());
  console.log("Cyber Snake Program:", SNAKE_PROGRAM_ID.toBase58());
  console.log("Admin:              ", admin.publicKey.toBase58());

  const [registryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_program_registry_v2"), SNAKE_PROGRAM_ID.toBuffer()],
    program.programId
  );
  console.log("Registry PDA:       ", registryPda.toBase58());

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
    minAccountLen: 1125,
  };

  console.log("\n→ Registering with adapter:");
  console.log(JSON.stringify(adapter, null, 2));

  const sig = await program.methods
    .registerGameProgramV2("cyber-snake", adapter as any)
    .accountsStrict({
      gameProgramRegistryV2: registryPda,
      gameProgram: SNAKE_PROGRAM_ID,
      protocolConfig: PublicKey.findProgramAddressSync(
        [Buffer.from("protocol_config")],
        program.programId
      )[0],
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`\n✅ Registered cyber-snake in v2.1 registry — tx ${sig}`);
  console.log(
    `   https://explorer.solana.com/tx/${sig}?cluster=devnet`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
