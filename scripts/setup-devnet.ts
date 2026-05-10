/**
 * One-time devnet setup:
 * 1. Create a USDC-like mint for testing
 * 2. Initialize protocol config (admin + treasury + 2% fee)
 * 3. Generate a partner keypair for Gamerplex
 * 4. Register Gamerplex as a partner (50% fee share)
 * 5. Print all addresses for .env configuration
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ContentionMarkets } from "../target/types/contention_markets";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

async function main() {
  // Setup provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace
    .ContentionMarkets as Program<ContentionMarkets>;
  const admin = (provider.wallet as any).payer as Keypair;

  console.log("=== GAMERPLEX DEVNET SETUP ===\n");
  console.log(`Program ID: ${program.programId.toBase58()}`);
  console.log(`Admin: ${admin.publicKey.toBase58()}`);
  console.log(`Balance: ${(await provider.connection.getBalance(admin.publicKey)) / LAMPORTS_PER_SOL} SOL\n`);

  // 1. Create test USDC mint
  console.log("1. Creating test USDC mint...");
  const mint = await createMint(
    provider.connection,
    admin,
    admin.publicKey,
    null,
    6 // USDC has 6 decimals
  );
  console.log(`   Mint: ${mint.toBase58()}`);

  // 2. Create treasury token accounts
  console.log("2. Creating treasury token accounts...");
  const protocolTreasuryAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    admin,
    mint,
    admin.publicKey
  );
  console.log(`   Protocol Treasury ATA: ${protocolTreasuryAta.address.toBase58()}`);

  // 3. Initialize protocol config
  console.log("3. Initializing protocol config...");
  const [protocolConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    program.programId
  );

  try {
    await program.methods
      .initializeProtocol(admin.publicKey, 200) // 2% fee
      .accounts({
        protocolConfig: protocolConfigPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    console.log(`   Protocol Config PDA: ${protocolConfigPda.toBase58()}`);
    console.log(`   Fee: 200 bps (2%)`);
  } catch (err: any) {
    if (err.toString().includes("already in use")) {
      console.log("   Protocol config already initialized, skipping.");
    } else {
      throw err;
    }
  }

  // 4. Generate partner keypair for Gamerplex
  console.log("4. Generating Gamerplex partner keypair...");
  const partnerKeypair = Keypair.generate();

  // Fund partner with SOL for signing (transfer from admin, not airdrop)
  const fundTx = new (await import("@solana/web3.js")).Transaction().add(
    SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: partnerKeypair.publicKey,
      lamports: 0.5 * LAMPORTS_PER_SOL,
    })
  );
  await provider.sendAndConfirm(fundTx);

  // Create partner treasury ATA
  const partnerTreasuryAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    admin,
    mint,
    partnerKeypair.publicKey
  );
  console.log(`   Partner Authority: ${partnerKeypair.publicKey.toBase58()}`);
  console.log(`   Partner Treasury ATA: ${partnerTreasuryAta.address.toBase58()}`);

  // 5. Register partner
  console.log("5. Registering Gamerplex as partner...");
  const [partnerRegistryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("partner_registry"), partnerKeypair.publicKey.toBuffer()],
    program.programId
  );

  await program.methods
    .registerPartner(5000) // 50% fee share
    .accounts({
      partnerRegistry: partnerRegistryPda,
      partnerProgram: partnerKeypair.publicKey,
      partnerTreasury: partnerTreasuryAta.address,
      admin: admin.publicKey,
      protocolConfig: protocolConfigPda,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();
  console.log(`   Partner Registry PDA: ${partnerRegistryPda.toBase58()}`);
  console.log(`   Fee Share: 5000 bps (50% of protocol fee)`);

  // 6. Create test player wallets with funded token accounts
  console.log("6. Creating test players...");
  const p1 = Keypair.generate();
  const p2 = Keypair.generate();

  // Fund players with SOL (transfer from admin)
  for (const kp of [p1, p2]) {
    const tx = new (await import("@solana/web3.js")).Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: kp.publicKey,
        lamports: 0.3 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(tx);
  }

  // Create ATAs and mint test USDC
  const p1Ata = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    admin,
    mint,
    p1.publicKey
  );
  const p2Ata = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    admin,
    mint,
    p2.publicKey
  );

  await mintTo(provider.connection, admin, mint, p1Ata.address, admin, 100_000_000); // 100 USDC
  await mintTo(provider.connection, admin, mint, p2Ata.address, admin, 100_000_000); // 100 USDC

  console.log(`   P1: ${p1.publicKey.toBase58()} (100 USDC)`);
  console.log(`   P2: ${p2.publicKey.toBase58()} (100 USDC)`);

  // 7. Save config
  const config = {
    programId: program.programId.toBase58(),
    mint: mint.toBase58(),
    protocolConfig: protocolConfigPda.toBase58(),
    admin: admin.publicKey.toBase58(),
    protocolTreasury: protocolTreasuryAta.address.toBase58(),
    partner: {
      authority: partnerKeypair.publicKey.toBase58(),
      secretKey: JSON.stringify(Array.from(partnerKeypair.secretKey)),
      registry: partnerRegistryPda.toBase58(),
      treasury: partnerTreasuryAta.address.toBase58(),
    },
    testPlayers: {
      p1: {
        publicKey: p1.publicKey.toBase58(),
        secretKey: JSON.stringify(Array.from(p1.secretKey)),
        tokenAccount: p1Ata.address.toBase58(),
      },
      p2: {
        publicKey: p2.publicKey.toBase58(),
        secretKey: JSON.stringify(Array.from(p2.secretKey)),
        tokenAccount: p2Ata.address.toBase58(),
      },
    },
  };

  const outPath = path.join(__dirname, "../devnet-config.json");
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2));
  console.log(`\n7. Config saved to ${outPath}`);

  // 8. Print .env for resolver
  console.log("\n=== RESOLVER .env ===\n");
  console.log(`RPC_URL=https://api.devnet.solana.com`);
  console.log(`MINT=${mint.toBase58()}`);
  console.log(`PARTNER_SECRET_KEY=${JSON.stringify(Array.from(partnerKeypair.secretKey))}`);
  console.log(`PARTNER_TREASURY=${partnerTreasuryAta.address.toBase58()}`);
  console.log(`PROTOCOL_TREASURY=${protocolTreasuryAta.address.toBase58()}`);

  console.log("\n=== SETUP COMPLETE ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
