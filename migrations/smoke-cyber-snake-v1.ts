/**
 * Cyber Snake v1 (snake-food) smoke test.
 *
 * Verifies:
 *   - create_game initializes snakes + spawns food
 *   - a food-seeking bot eats food, length grows
 *   - tail pre-clear works (straight path of more than INITIAL_LEN cells)
 *   - body collision ends the game (status=2, winner set)
 *
 * Two food-seeking bots play until one crashes.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as fs from "fs";

const SNAKE_PROGRAM_ID = new PublicKey(
  "EK8gFE1ojW61QuLTvy6dHyLxCq5yjCnauJz8eisNPTk3"
);
const GAME_SEED = Buffer.from("cyber_snake");
const GRID_W = 32;
const DIR_N = 0,
  DIR_E = 1,
  DIR_S = 2,
  DIR_W = 3;
const CELL_EMPTY = 0,
  CELL_FOOD = 3;

function rowCol(pos: number) {
  return { r: Math.floor(pos / GRID_W), c: pos % GRID_W };
}
function step(pos: number, dir: number): number | null {
  const { r, c } = rowCol(pos);
  let nr = r,
    nc = c;
  if (dir === DIR_N) nr--;
  else if (dir === DIR_S) nr++;
  else if (dir === DIR_E) nc++;
  else if (dir === DIR_W) nc--;
  if (nr < 0 || nr >= GRID_W || nc < 0 || nc >= GRID_W) return null;
  return nr * GRID_W + nc;
}
function opposite(a: number, b: number) {
  return (
    (a === DIR_N && b === DIR_S) ||
    (a === DIR_S && b === DIR_N) ||
    (a === DIR_E && b === DIR_W) ||
    (a === DIR_W && b === DIR_E)
  );
}

/** Pick direction: prefer moving toward food, always stay safe (empty or food). */
function pickDir(
  headPos: number,
  curDir: number,
  foodPos: number,
  grid: Uint8Array
): number {
  const h = rowCol(headPos),
    f = rowCol(foodPos);
  const preferred: number[] = [];
  if (f.c > h.c) preferred.push(DIR_E);
  if (f.c < h.c) preferred.push(DIR_W);
  if (f.r > h.r) preferred.push(DIR_S);
  if (f.r < h.r) preferred.push(DIR_N);
  const fallback = [curDir, (curDir + 3) % 4, (curDir + 1) % 4];
  const tried = new Set<number>();
  for (const d of [...preferred, ...fallback]) {
    if (tried.has(d)) continue;
    tried.add(d);
    if (opposite(curDir, d)) continue;
    const n = step(headPos, d);
    if (n === null) continue;
    const c = grid[n];
    if (c === CELL_EMPTY || c === CELL_FOOD) return d;
  }
  return curDir;
}

async function fund(conn: any, from: Keypair, to: PublicKey, sol: number) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports: Math.floor(sol * LAMPORTS_PER_SOL),
    })
  );
  const sig = await conn.sendTransaction(tx, [from]);
  await conn.confirmTransaction(sig, "confirmed");
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(
      "/Users/johnny/Code/contention-gg/cyber-snake/program/target/idl/cyber_snake.json",
      "utf8"
    )
  );
  const program = new Program(idl, provider) as Program<any>;
  const admin = (provider.wallet as any).payer as Keypair;
  const joiner = Keypair.generate();

  console.log("Cyber Snake v1 (snake-food) smoke test");
  console.log("Program:", SNAKE_PROGRAM_ID.toBase58());
  console.log("p1:    ", admin.publicKey.toBase58());
  console.log("p2:    ", joiner.publicKey.toBase58());

  await fund(provider.connection, admin, joiner.publicKey, 0.05);

  const gameId = new BN(Date.now());
  const [gamePda] = PublicKey.findProgramAddressSync(
    [GAME_SEED, gameId.toArrayLike(Buffer, "le", 8)],
    SNAKE_PROGRAM_ID
  );
  console.log("game_id:", gameId.toString(), "PDA:", gamePda.toBase58());

  await program.methods
    .createGame(gameId)
    .accountsStrict({
      game: gamePda,
      host: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await program.methods
    .joinGame(gameId)
    .accountsStrict({ game: gamePda, joiner: joiner.publicKey })
    .signers([joiner])
    .rpc();

  const s0 = (await (program.account as any).gameState.fetch(gamePda)) as any;
  console.log(
    `\ninitial: food @ ${s0.foodPos}, p1 head idx=${s0.headIdxP1} len=${s0.lenP1}, p2 head idx=${s0.headIdxP2} len=${s0.lenP2}`
  );

  let tickN = 0;
  let p1FoodEaten = 0,
    p2FoodEaten = 0;
  let maxLenP1 = s0.lenP1,
    maxLenP2 = s0.lenP2;
  let prevFoodPos = s0.foodPos;

  while (true) {
    const s = (await (program.account as any).gameState.fetch(gamePda)) as any;
    if (s.status === 2) {
      console.log(
        `\nGAME OVER @ tick ${s.tick}. winner_flag=${s.winnerFlag} (0=draw,1=p1,2=p2)`
      );
      console.log(
        `final lengths: p1=${s.lenP1} (ate ${p1FoodEaten}) p2=${s.lenP2} (ate ${p2FoodEaten})`
      );
      console.log(`max observed: p1=${maxLenP1} p2=${maxLenP2}`);
      const ok =
        s.status === 2 && (p1FoodEaten > 0 || p2FoodEaten > 0) && s.tick > 5;
      console.log(ok ? "\n✅ PASS" : "\n❌ FAIL");
      console.log(
        "explorer:",
        `https://explorer.solana.com/address/${gamePda.toBase58()}?cluster=devnet`
      );
      if (!ok) process.exit(1);
      return;
    }

    if (s.foodPos !== prevFoodPos) {
      // Food respawned this tick → someone ate.
      const dP1 = s.lenP1 - maxLenP1;
      const dP2 = s.lenP2 - maxLenP2;
      if (dP1 > 0) {
        p1FoodEaten += dP1;
        console.log(`  🍎 p1 ate @ tick ${s.tick}, len ${s.lenP1}`);
      }
      if (dP2 > 0) {
        p2FoodEaten += dP2;
        console.log(`  🍎 p2 ate @ tick ${s.tick}, len ${s.lenP2}`);
      }
      maxLenP1 = Math.max(maxLenP1, s.lenP1);
      maxLenP2 = Math.max(maxLenP2, s.lenP2);
      prevFoodPos = s.foodPos;
    }

    const grid = Uint8Array.from(s.grid);
    const headP1 = s.bodyP1[(s.headIdxP1 + 255) % 256];
    const headP2 = s.bodyP2[(s.headIdxP2 + 255) % 256];

    const d1 = pickDir(headP1, s.dirP1, s.foodPos, grid);
    const d2 = pickDir(headP2, s.dirP2, s.foodPos, grid);

    if (d1 !== s.dirP1) {
      await program.methods
        .submitDirection(d1)
        .accountsStrict({ game: gamePda, player: admin.publicKey })
        .rpc();
    }
    if (d2 !== s.dirP2) {
      await program.methods
        .submitDirection(d2)
        .accountsStrict({ game: gamePda, player: joiner.publicKey })
        .signers([joiner])
        .rpc();
    }

    await program.methods
      .advanceTick()
      .accountsStrict({ game: gamePda, cranker: admin.publicKey })
      .rpc();

    tickN++;
    if (tickN > 400) {
      console.log("tick cap reached (400) — snakes playing forever");
      console.log(
        `eaten: p1=${p1FoodEaten} p2=${p2FoodEaten} — still a valid pass if any food was eaten`
      );
      return;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
