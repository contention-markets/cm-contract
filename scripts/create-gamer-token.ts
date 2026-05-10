/**
 * Create $GAMER token on devnet + 10 funded AI agent wallets.
 * These agents auto-play matches so the platform is never a ghost town.
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as fs from "fs";

const AGENT_NAMES = [
  "Molty-Prime", "DegenBot-9", "ShadowAlpha", "CrabDAO", "Ape.agent",
  "Whale-007", "NeonSamurai", "QuantumFish", "ZeroKnight", "FlashLoan",
];

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const admin = (provider.wallet as any).payer as Keypair;
  const usdcMint = new PublicKey("5cfYRyjyzq5DSHpJPr5ipQQ48RHSn49Y75AWNMxaambt");

  console.log("=== CREATING $GAMER TOKEN + AGENT ARMY ===\n");

  // 1. Create $GAMER mint
  console.log("1. Creating $GAMER token...");
  const gamerMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);
  console.log(`   GAMER Mint: ${gamerMint.toBase58()}`);

  // 2. Mint 1M GAMER to admin
  const adminGamerAta = await getOrCreateAssociatedTokenAccount(
    provider.connection, admin, gamerMint, admin.publicKey
  );
  await mintTo(provider.connection, admin, gamerMint, adminGamerAta.address, admin, 1_000_000_000_000);
  console.log(`   Admin has 1,000,000 $GAMER\n`);

  // 3. Create 10 agent wallets
  console.log("2. Creating agent wallets...");
  const agents = [];

  for (let i = 0; i < 10; i++) {
    const kp = Keypair.generate();

    // Fund with SOL
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: kp.publicKey,
        lamports: 0.05 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(fundTx);

    // USDC ATA + fund 500 USDC
    const usdcAta = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, kp.publicKey
    );
    await mintTo(provider.connection, admin, usdcMint, usdcAta.address, admin, 500_000_000);

    // GAMER ATA + fund 10K GAMER
    const gamerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, gamerMint, kp.publicKey
    );
    await mintTo(provider.connection, admin, gamerMint, gamerAta.address, admin, 10_000_000_000);

    agents.push({
      name: AGENT_NAMES[i],
      publicKey: kp.publicKey.toBase58(),
      secretKey: JSON.stringify(Array.from(kp.secretKey)),
      usdcAta: usdcAta.address.toBase58(),
      gamerAta: gamerAta.address.toBase58(),
    });

    console.log(`   ${AGENT_NAMES[i]}: ${kp.publicKey.toBase58()} (500 USDC + 10K GAMER)`);
  }

  // 4. Save config
  const config = {
    gamerMint: gamerMint.toBase58(),
    adminGamerAta: adminGamerAta.address.toBase58(),
    agents,
  };

  fs.writeFileSync("agent-config.json", JSON.stringify(config, null, 2));

  console.log(`\n=== DONE ===`);
  console.log(`$GAMER Mint: ${gamerMint.toBase58()}`);
  console.log(`10 agents created with 500 USDC + 10K $GAMER each`);
  console.log(`Config saved to agent-config.json`);
}

main().catch(console.error);
