/**
 * Cyber Snake smoke test — verifies the deployed program works end-to-end.
 *
 *   1. create_game (host = admin)
 *   2. join_game  (joiner = fresh keypair, funded from admin)
 *   3. submit_direction for both players
 *   4. advance_tick a few times, observe positions
 *   5. force p1 to wall-crash by driving W off-grid → verify winner = p2
 *
 * Run:
 *   ANCHOR_WALLET=$HOME/.config/solana/id.json \
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   yarn ts-node migrations/smoke-cyber-snake.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  Connection,
  LAMPORTS_PER_SOL,
  SendTransactionError,
} from "@solana/web3.js";
import * as fs from "fs";

const SNAKE_PROGRAM_ID = new PublicKey(
  "EK8gFE1ojW61QuLTvy6dHyLxCq5yjCnauJz8eisNPTk3"
);
const GAME_SEED = Buffer.from("cyber_snake");

const DIR_N = 0,
  DIR_E = 1,
  DIR_S = 2,
  DIR_W = 3;

async function fundIfNeeded(
  conn: Connection,
  from: Keypair,
  to: PublicKey,
  sol: number
) {
  const lamports = Math.floor(sol * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports,
    })
  );
  const sig = await conn.sendTransaction(tx, [from]);
  await conn.confirmTransaction(sig, "confirmed");
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const idlPath =
    "/Users/johnny/Code/contention-gg/cyber-snake/program/target/idl/cyber_snake.json";
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const program = new Program(idl, provider) as Program<any>;

  const admin = (provider.wallet as any).payer as Keypair;
  const joiner = Keypair.generate();

  console.log("=".repeat(64));
  console.log("Cyber Snake smoke test");
  console.log("=".repeat(64));
  console.log("Program:", SNAKE_PROGRAM_ID.toBase58());
  console.log("Host:   ", admin.publicKey.toBase58());
  console.log("Joiner: ", joiner.publicKey.toBase58());

  // Fund joiner
  console.log("\n→ Funding joiner with 0.02 SOL");
  await fundIfNeeded(provider.connection, admin, joiner.publicKey, 0.02);

  const gameId = new BN(Date.now());
  const [gamePda] = PublicKey.findProgramAddressSync(
    [GAME_SEED, gameId.toArrayLike(Buffer, "le", 8)],
    SNAKE_PROGRAM_ID
  );
  console.log("\n→ game_id:", gameId.toString(), "PDA:", gamePda.toBase58());

  // 1. create_game
  console.log("\n→ create_game");
  let sig = await program.methods
    .createGame(gameId)
    .accountsStrict({
      game: gamePda,
      host: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("   ✓", sig);

  // 2. join_game
  console.log("\n→ join_game");
  sig = await program.methods
    .joinGame(gameId)
    .accountsStrict({
      game: gamePda,
      joiner: joiner.publicKey,
    })
    .signers([joiner])
    .rpc();
  console.log("   ✓", sig);

  const printState = async (label: string) => {
    const s = await (program.account as any).gameState.fetch(gamePda);
    console.log(
      `   [${label}] status=${s.status} tick=${s.tick} p1=${s.posP1}(dir ${s.dirP1}) p2=${s.posP2}(dir ${s.dirP2}) winner=${s.winnerFlag}`
    );
  };
  await printState("after-join");

  // 3. advance 2 ticks with default dirs (p1→E, p2→W — they're heading at each other row 0 vs row 31, won't collide)
  for (let i = 0; i < 2; i++) {
    sig = await program.methods
      .advanceTick()
      .accountsStrict({ game: gamePda, cranker: admin.publicKey })
      .rpc();
    await printState(`tick-${i + 1}`);
  }

  // 4. Force p1 to reverse N→crash (wall death going N off row 0 is immediate).
  // p1 is at row 0 still. Submit dir=N → next advance_tick, pos row -1 → wall death.
  console.log("\n→ p1 submits N (into wall)");
  // BUT from E, N is not opposite (E's opposite is W). So allowed.
  sig = await program.methods
    .submitDirection(DIR_N)
    .accountsStrict({ game: gamePda, player: admin.publicKey })
    .rpc();
  console.log("   ✓", sig);

  console.log("\n→ advance_tick — expect p1 wall death, p2 wins");
  sig = await program.methods
    .advanceTick()
    .accountsStrict({ game: gamePda, cranker: admin.publicKey })
    .rpc();
  await printState("after-crash");

  const final = await (program.account as any).gameState.fetch(gamePda);
  const statusOk = final.status === 2;
  const winnerOk = final.winnerFlag === 2;
  console.log("\n" + (statusOk && winnerOk ? "✅ PASS" : "❌ FAIL"));
  console.log("   status=2 (Finished):", statusOk);
  console.log("   winner=2 (p2):      ", winnerOk);

  if (!statusOk || !winnerOk) process.exit(1);
}

main().catch((e) => {
  if (e instanceof SendTransactionError) {
    console.error("SendTransactionError logs:");
    console.error(e.logs);
  }
  console.error(e);
  process.exit(1);
});
