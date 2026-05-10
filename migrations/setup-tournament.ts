/**
 * Tournament setup — creates the full on-chain shape for the 6-bot ELO tournament.
 *
 *   1. Fresh USDF mint (6 decimals, admin = mint authority)
 *   2. Gamerplex treasury ATA for USDF (owned by admin)
 *   3. Protocol treasury ATA for USDF
 *   4. PoolSponsor USDF ATA (owned by PoolSponsor PDA)
 *   5. Derive OrchestratorConfig PDA → register it as a CM v2 partner
 *   6. Mint $10 USDF to each of the 6 chess bot wallets (sf1200..sf3000)
 *   7. Write tournament-config.json with every address for downstream scripts
 *
 * Idempotent — rerunning skips any step already on-chain.
 *
 * Run:
 *   ANCHOR_WALLET=$HOME/.config/solana/id.json \
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   yarn ts-node migrations/setup-tournament.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
} from "@solana/spl-token";
import { ContentionMarkets } from "../target/types/contention_markets";
import { readFileSync, writeFileSync, existsSync } from "fs";
import * as path from "path";

const ORCHESTRATOR_PROGRAM_ID = new PublicKey(
  "tsHnDDmYyqpcRyQejKcvai6fECRWyNQ4F87QgKcHg4d"
);
const CHESS_PROGRAM_ID = new PublicKey(
  "3LVg8uUsHtq6fusjrSfyGUCLQ83TFegDKmY3bCNz3QYr"
);
const POOL_SPONSOR_PDA = new PublicKey(
  "FNKPP6q2qk3wqMd7ErkWYk98etrZfuMnvGh2EQKdrrcJ"
);

const BOT_NAMES = ["sf1200", "sf1500", "sf1800", "sf2100", "sf2400", "sf3000"];
const BOT_KEYS_DIR = path.join(__dirname, "../../gamerplex-agents/keys");
const CONFIG_PATH = path.join(__dirname, "../tournament-config.json");

const SEED_AMOUNT_USDF = BigInt(10_000_000); // $10.000000 per bot (6 decimals)
const ADMIN_USDF_BALANCE = BigInt(10_000_000_000); // 10,000 USDF for admin treasury ops

function loadBotKeypair(name: string): Keypair {
  const raw = JSON.parse(
    readFileSync(path.join(BOT_KEYS_DIR, `${name}.json`), "utf8")
  ) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace
    .ContentionMarkets as Program<ContentionMarkets>;
  const admin = (provider.wallet as any).payer as Keypair;
  const connection = provider.connection;

  console.log("=".repeat(64));
  console.log("Tournament Setup — 6 chess bots × $10 USDF");
  console.log("=".repeat(64));
  console.log("CM Program:       ", program.programId.toBase58());
  console.log("Orchestrator:     ", ORCHESTRATOR_PROGRAM_ID.toBase58());
  console.log("Chess:            ", CHESS_PROGRAM_ID.toBase58());
  console.log("Admin:            ", admin.publicKey.toBase58());

  // Load existing config (idempotency)
  const cfg: any = existsSync(CONFIG_PATH)
    ? JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
    : {};

  // ── Step 1: USDF mint ──────────────────────────────────────────────────
  let usdfMint: PublicKey;
  if (cfg.usdfMint) {
    usdfMint = new PublicKey(cfg.usdfMint);
    const info = await connection.getAccountInfo(usdfMint);
    if (!info) {
      throw new Error(`Configured USDF mint ${usdfMint.toBase58()} not on-chain`);
    }
    const m = await getMint(connection, usdfMint);
    console.log(
      `\n[1/7] USDF mint (existing): ${usdfMint.toBase58()} · decimals=${m.decimals} · supply=${m.supply}`
    );
  } else {
    console.log("\n[1/7] Creating fresh USDF mint...");
    usdfMint = await createMint(
      connection,
      admin,
      admin.publicKey, // mint authority
      null, // no freeze authority
      6 // USDF has 6 decimals
    );
    cfg.usdfMint = usdfMint.toBase58();
    console.log(`      ✅ USDF mint: ${usdfMint.toBase58()}`);
  }

  // ── Step 2: Gamerplex treasury (admin's USDF ATA) ──────────────────────
  console.log("\n[2/7] Gamerplex treasury (partner fee destination)...");
  const gamerplexTreasury = await getOrCreateAssociatedTokenAccount(
    connection,
    admin,
    usdfMint,
    admin.publicKey
  );
  cfg.gamerplexTreasury = gamerplexTreasury.address.toBase58();
  console.log(`      ✅ Gamerplex treasury ATA: ${gamerplexTreasury.address.toBase58()}`);

  // Mint admin supply if below threshold
  if (gamerplexTreasury.amount < ADMIN_USDF_BALANCE) {
    const need = ADMIN_USDF_BALANCE - gamerplexTreasury.amount;
    await mintTo(
      connection,
      admin,
      usdfMint,
      gamerplexTreasury.address,
      admin.publicKey,
      Number(need)
    );
    console.log(`      ✅ Minted ${need} (raw) USDF to gamerplex treasury`);
  }

  // ── Step 3: Protocol treasury ATA + sync to ProtocolConfig ─────────────
  console.log("\n[3/7] Protocol treasury ATA...");
  // For dev: protocol treasury = admin-owned USDF ATA, same as gamerplex
  // (production: a separate DAO-controlled wallet). Same ATA works here.
  const protocolTreasury = gamerplexTreasury.address;
  cfg.protocolTreasury = protocolTreasury.toBase58();
  console.log(`      ✅ Protocol treasury: ${protocolTreasury.toBase58()} (= gamerplex for devnet)`);

  // Sync ProtocolConfig.treasury to the fresh ATA so CM resolve constraints pass.
  const [protocolConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    program.programId
  );
  const pc = await program.account.protocolConfig.fetch(protocolConfigPda);
  if (!pc.treasury.equals(protocolTreasury)) {
    const sig = await program.methods
      .updateProtocolConfig(null, protocolTreasury)
      .accountsStrict({
        protocolConfig: protocolConfigPda,
        admin: admin.publicKey,
      })
      .rpc();
    console.log(`      ✅ Updated ProtocolConfig.treasury → ${protocolTreasury.toBase58()} (tx ${sig.slice(0,12)}...)`);
  } else {
    console.log(`      ⏭  ProtocolConfig.treasury already synced`);
  }

  // ── Step 4: PoolSponsor USDF ATA ───────────────────────────────────────
  console.log("\n[4/7] PoolSponsor USDF ATA...");
  const poolSponsorAta = await getOrCreateAssociatedTokenAccount(
    connection,
    admin,
    usdfMint,
    POOL_SPONSOR_PDA,
    true // allow owner off curve (PDA)
  );
  cfg.poolSponsorAta = poolSponsorAta.address.toBase58();
  console.log(`      ✅ PoolSponsor USDF ATA: ${poolSponsorAta.address.toBase58()}`);

  // ── Step 5: Register OrchestratorConfig PDA as CM v2 partner ──────────
  console.log("\n[5/7] Register Orchestrator as CM v2 partner...");
  const [orchestratorConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    ORCHESTRATOR_PROGRAM_ID
  );
  cfg.orchestratorConfigPda = orchestratorConfigPda.toBase58();
  console.log(`      OrchestratorConfig PDA: ${orchestratorConfigPda.toBase58()}`);

  const [partnerRegistryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("partner_registry"), orchestratorConfigPda.toBuffer()],
    program.programId
  );
  cfg.orchestratorPartnerRegistry = partnerRegistryPda.toBase58();

  const existingPartner = await connection.getAccountInfo(partnerRegistryPda);
  if (existingPartner) {
    console.log(`      ⏭  Partner already registered: ${partnerRegistryPda.toBase58()}`);
  } else {
    const sig = await program.methods
      .registerPartner(2000) // fee_share_bps = 2000 (kept for v1 compat; v2 uses ProtocolConfigV2 split)
      .accountsStrict({
        partnerRegistry: partnerRegistryPda,
        partnerProgram: orchestratorConfigPda,
        partnerTreasury: gamerplexTreasury.address,
        admin: admin.publicKey,
        protocolConfig: PublicKey.findProgramAddressSync(
          [Buffer.from("protocol_config")],
          program.programId
        )[0],
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`      ✅ Registered — tx ${sig}`);
  }

  // ── Step 6: Mint $10 USDF to each of 6 chess bots ──────────────────────
  console.log("\n[6/7] Fund 6 chess bots with $10 USDF each...");
  cfg.bots = {};
  for (const name of BOT_NAMES) {
    const bot = loadBotKeypair(name);
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      usdfMint,
      bot.publicKey
    );
    const need =
      ata.amount < SEED_AMOUNT_USDF ? SEED_AMOUNT_USDF - ata.amount : BigInt(0);
    if (need > BigInt(0)) {
      await mintTo(
        connection,
        admin,
        usdfMint,
        ata.address,
        admin.publicKey,
        Number(need)
      );
      const fresh = await getAccount(connection, ata.address);
      console.log(
        `      ✅ ${name}: ${ata.address.toBase58().slice(0, 12)}... · ${fresh.amount} (raw)`
      );
    } else {
      console.log(
        `      ⏭  ${name}: ${ata.address.toBase58().slice(0, 12)}... · ${ata.amount} (raw) already funded`
      );
    }
    cfg.bots[name] = {
      pubkey: bot.publicKey.toBase58(),
      ata: ata.address.toBase58(),
    };
  }

  // ── Step 7: Write config ──────────────────────────────────────────────
  cfg.chessProgram = CHESS_PROGRAM_ID.toBase58();
  cfg.orchestratorProgram = ORCHESTRATOR_PROGRAM_ID.toBase58();
  cfg.cmProgram = program.programId.toBase58();
  cfg.poolSponsor = POOL_SPONSOR_PDA.toBase58();
  cfg.admin = admin.publicKey.toBase58();
  cfg.updatedAt = new Date().toISOString();
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));

  console.log("\n" + "=".repeat(64));
  console.log(`Tournament setup complete. Config: ${CONFIG_PATH}`);
  console.log("=".repeat(64));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
