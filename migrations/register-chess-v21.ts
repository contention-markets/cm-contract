/**
 * Register Chess in CM v2.1 GameProgramRegistryV2 with its real adapter schema.
 *
 * Chess GameState layout (Borsh-serialized after 8-byte Anchor discriminator):
 *   offset  0..8   : discriminator
 *   offset  8..16  : game_id (u64)
 *   offset 16..48  : white (Pubkey)         ← p1
 *   offset 48..80  : black (Pubkey)         ← p2
 *   offset    80   : status (u8: 0=WaitingForBlack, 1=Active, 2=Finished)
 *   offset    81   : turn (u8)
 *   offset 82..84  : move_count (u16)
 *   offset    84   : winner (u8: 0=draw, 1=white wins, 2=black wins)
 *   ... (rest: time_per_move, last_move_at, en_passant, castling, board, moves)
 *   total  : 673 bytes
 *
 * Idempotent. Run:
 *   ANCHOR_WALLET=$HOME/.config/solana/id.json \
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   yarn ts-node migrations/register-chess-v21.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { ContentionMarkets } from "../target/types/contention_markets";

const CHESS_PROGRAM_ID = new PublicKey(
  "3LVg8uUsHtq6fusjrSfyGUCLQ83TFegDKmY3bCNz3QYr"
);

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace
    .ContentionMarkets as Program<ContentionMarkets>;
  const admin = (provider.wallet as any).payer;

  console.log("=".repeat(64));
  console.log("Register Chess in CM v2.1 Adapter Registry");
  console.log("=".repeat(64));
  console.log("CM Program:   ", program.programId.toBase58());
  console.log("Chess Program:", CHESS_PROGRAM_ID.toBase58());
  console.log("Admin:        ", admin.publicKey.toBase58());

  const [registryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_program_registry_v2"), CHESS_PROGRAM_ID.toBuffer()],
    program.programId
  );
  console.log("Registry PDA: ", registryPda.toBase58());

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
    console.log("   winner_p1/p2/draw: ",
      entry.adapter.winnerP1Value,
      entry.adapter.winnerP2Value,
      entry.adapter.winnerDrawValue
    );
    console.log("   min_account_len:   ", entry.adapter.minAccountLen);
    return;
  }

  const adapter = {
    p1Offset: 16, // white Pubkey after disc(8) + game_id(8)
    p2Offset: 48, // black Pubkey
    statusOffset: 80, // status u8
    statusFinishedValue: 2, // GameStatus::Finished
    winnerOffset: 84, // winner u8 after turn(1) + move_count(2)
    winnerP1Value: 1, // white (p1) wins
    winnerP2Value: 2, // black (p2) wins
    winnerDrawValue: 0, // draw (status=Finished + winner=0)
    minAccountLen: 673, // full chess GameState: 8 + 8 + 32 + 32 + 1 + 1 + 2 + 1 + 2 + 8 + 1 + 1 + 64 + 512
  };

  console.log("\n→ Registering with adapter:");
  console.log(JSON.stringify(adapter, null, 2));

  const sig = await program.methods
    .registerGameProgramV2("chess", adapter as any)
    .accountsStrict({
      gameProgramRegistryV2: registryPda,
      gameProgram: CHESS_PROGRAM_ID,
      protocolConfig: PublicKey.findProgramAddressSync(
        [Buffer.from("protocol_config")],
        program.programId
      )[0],
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`\n✅ Registered chess in v2.1 registry — tx ${sig}`);
  console.log(
    `   https://explorer.solana.com/tx/${sig}?cluster=devnet`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
