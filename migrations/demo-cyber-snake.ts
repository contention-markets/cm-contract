/**
 * Cyber Snake demo — two greedy trail-aware bots play a full game on devnet
 * until one crashes. Produces a clean tx trail for the Frontier demo video.
 *
 * Bot strategy (very simple, good enough for a visual demo):
 *   - Stay in bounds (never step off the 32×32 grid)
 *   - Avoid any already-marked cell (own trail or opponent's)
 *   - Prefer continuing straight; if blocked, turn toward center
 *
 * Run:
 *   ANCHOR_WALLET=$HOME/.config/solana/id.json \
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   yarn ts-node migrations/demo-cyber-snake.ts
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

const DIR_N = 0,
  DIR_E = 1,
  DIR_S = 2,
  DIR_W = 3;
const GRID_W = 32;

function step(pos: number, dir: number): number | null {
  const row = Math.floor(pos / GRID_W);
  const col = pos % GRID_W;
  let nr = row,
    nc = col;
  if (dir === DIR_N) nr -= 1;
  else if (dir === DIR_S) nr += 1;
  else if (dir === DIR_W) nc -= 1;
  else if (dir === DIR_E) nc += 1;
  if (nr < 0 || nr >= GRID_W || nc < 0 || nc >= GRID_W) return null;
  return nr * GRID_W + nc;
}

function isOpposite(a: number, b: number): boolean {
  return (
    (a === DIR_N && b === DIR_S) ||
    (a === DIR_S && b === DIR_N) ||
    (a === DIR_E && b === DIR_W) ||
    (a === DIR_W && b === DIR_E)
  );
}

/** Pick a safe direction given current pos/dir and grid. Prefers straight,
 * otherwise the first of {left-turn, right-turn} that's safe. Returns the
 * current dir if no safe option — bot will crash but that's the game. */
function pickDir(pos: number, dir: number, grid: Uint8Array): number {
  const options = [dir, (dir + 3) % 4, (dir + 1) % 4]; // straight, left, right
  for (const d of options) {
    if (isOpposite(dir, d)) continue;
    const n = step(pos, d);
    if (n !== null && grid[n] === 0) return d;
  }
  return dir;
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

  console.log("Cyber Snake demo — bot vs bot on devnet");
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

  let tickN = 0;
  let lastSig = "";
  while (true) {
    const s = (await (program.account as any).gameState.fetch(gamePda)) as any;
    if (s.status === 2) {
      console.log(
        `\nGAME OVER @ tick ${s.tick} — winner_flag=${s.winnerFlag} (0=draw, 1=p1, 2=p2)`
      );
      console.log(
        "final: ",
        `p1 pos=${s.posP1} dir=${s.dirP1} | p2 pos=${s.posP2} dir=${s.dirP2}`
      );
      console.log(
        "explorer:",
        `https://explorer.solana.com/address/${gamePda.toBase58()}?cluster=devnet`
      );
      if (lastSig)
        console.log(
          "last tx: https://explorer.solana.com/tx/" + lastSig + "?cluster=devnet"
        );
      return;
    }

    const grid = Uint8Array.from(s.grid);
    const d1 = pickDir(s.posP1, s.dirP1, grid);
    const d2 = pickDir(s.posP2, s.dirP2, grid);

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

    lastSig = await program.methods
      .advanceTick()
      .accountsStrict({ game: gamePda, cranker: admin.publicKey })
      .rpc();

    tickN++;
    if (tickN % 20 === 0) {
      console.log(
        `tick ${tickN}: p1 pos=${s.posP1}(dir${s.dirP1}→${d1}) p2 pos=${s.posP2}(dir${s.dirP2}→${d2})`
      );
    }
    if (tickN > 500) {
      console.log("tick cap reached — something's wrong");
      return;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
