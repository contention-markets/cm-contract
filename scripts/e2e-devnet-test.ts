/**
 * End-to-end devnet test:
 * 1. Create a wagered match (P1 vs P2, 5 USDC each)
 * 2. P1 deposits 5 USDC
 * 3. P2 deposits 5 USDC
 * 4. Resolve: P1 wins
 * 5. Verify: P1 got winnings, fees went to treasuries, vault empty
 * 6. Close market, reclaim rent
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ContentionMarkets } from "../target/types/contention_markets";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ContentionMarkets as Program<ContentionMarkets>;

  // Load devnet config
  const configPath = path.join(__dirname, "../devnet-config.json");
  if (!fs.existsSync(configPath)) {
    console.error("Run setup-devnet.ts first!");
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  const mint = new PublicKey(config.mint);
  const protocolConfigPda = new PublicKey(config.protocolConfig);
  const partnerKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(config.partner.secretKey))
  );
  const partnerRegistryPda = new PublicKey(config.partner.registry);
  const partnerTreasury = new PublicKey(config.partner.treasury);
  const protocolTreasury = new PublicKey(config.protocolTreasury);

  const p1 = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(config.testPlayers.p1.secretKey))
  );
  const p2 = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(config.testPlayers.p2.secretKey))
  );
  const p1Ata = getAssociatedTokenAddressSync(mint, p1.publicKey);
  const p2Ata = getAssociatedTokenAddressSync(mint, p2.publicKey);

  const STAKE = 5_000_000; // 5 USDC

  console.log("=== E2E DEVNET TEST ===\n");

  // Check balances before
  const p1Before = await getAccount(provider.connection, p1Ata);
  const p2Before = await getAccount(provider.connection, p2Ata);
  const partnerBefore = await getAccount(provider.connection, partnerTreasury);
  const protocolBefore = await getAccount(provider.connection, protocolTreasury);
  console.log(`P1 balance: ${Number(p1Before.amount) / 1e6} USDC`);
  console.log(`P2 balance: ${Number(p2Before.amount) / 1e6} USDC`);
  console.log(`Partner treasury: ${Number(partnerBefore.amount) / 1e6} USDC`);
  console.log(`Protocol treasury: ${Number(protocolBefore.amount) / 1e6} USDC\n`);

  // 1. Create match
  console.log("1. Creating match...");
  const eventId = new anchor.BN(Date.now());
  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), eventId.toArrayLike(Buffer, "le", 8)],
    program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), marketPda.toBuffer()],
    program.programId
  );

  const initSig = await program.methods
    .initializeMarket(
      eventId,
      JSON.stringify({ game: "e2e_test", chat: "Testing on devnet!" }),
      p1.publicKey,
      p2.publicKey,
      new anchor.BN(0) // no expiry
    )
    .accounts({
      market: marketPda,
      marketVault: vaultPda,
      mint: mint,
      partnerRegistry: partnerRegistryPda,
      authority: partnerKeypair.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .signers([partnerKeypair])
    .rpc();
  console.log(`   Market: ${marketPda.toBase58()}`);
  console.log(`   Vault:  ${vaultPda.toBase58()}`);
  console.log(`   Tx: ${initSig}\n`);

  // 2. P1 deposits
  console.log("2. P1 deposits 5 USDC...");
  const dep1Sig = await program.methods
    .deposit(new anchor.BN(STAKE))
    .accounts({
      market: marketPda,
      marketVault: vaultPda,
      userTokenAccount: p1Ata,
      user: p1.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .signers([p1])
    .rpc();
  console.log(`   Tx: ${dep1Sig}\n`);

  // 3. P2 deposits
  console.log("3. P2 deposits 5 USDC...");
  const dep2Sig = await program.methods
    .deposit(new anchor.BN(STAKE))
    .accounts({
      market: marketPda,
      marketVault: vaultPda,
      userTokenAccount: p2Ata,
      user: p2.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .signers([p2])
    .rpc();
  console.log(`   Tx: ${dep2Sig}\n`);

  // Check vault
  const vaultAfterDeposits = await getAccount(provider.connection, vaultPda);
  console.log(`   Vault balance: ${Number(vaultAfterDeposits.amount) / 1e6} USDC (should be 10.0)\n`);

  // 4. Resolve: P1 wins
  console.log("4. Resolving: P1 wins...");
  const resolveSig = await program.methods
    .resolveMarket(0) // P1 wins
    .accounts({
      market: marketPda,
      authority: partnerKeypair.publicKey,
      partnerRegistry: partnerRegistryPda,
      protocolConfig: protocolConfigPda,
      marketVault: vaultPda,
      p1TokenAccount: p1Ata,
      p2TokenAccount: p2Ata,
      partnerTreasury: partnerTreasury,
      protocolTreasury: protocolTreasury,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .signers([partnerKeypair])
    .rpc();
  console.log(`   Tx: ${resolveSig}\n`);

  // 5. Verify results
  console.log("5. Verifying results...");
  const p1After = await getAccount(provider.connection, p1Ata);
  const p2After = await getAccount(provider.connection, p2Ata);
  const partnerAfter = await getAccount(provider.connection, partnerTreasury);
  const protocolAfter = await getAccount(provider.connection, protocolTreasury);
  const vaultAfter = await getAccount(provider.connection, vaultPda);

  const totalPot = STAKE * 2; // 10 USDC
  const protocolFee = (totalPot * 200) / 10000; // 2% = 0.2 USDC
  const partnerShare = (protocolFee * 5000) / 10000; // 50% = 0.1 USDC
  const contentionShare = protocolFee - partnerShare; // 0.1 USDC
  const winnerPayout = totalPot - protocolFee; // 9.8 USDC

  const p1Diff = Number(p1After.amount) - Number(p1Before.amount);
  const p2Diff = Number(p2After.amount) - Number(p2Before.amount);
  const partnerDiff = Number(partnerAfter.amount) - Number(partnerBefore.amount);
  const protocolDiff = Number(protocolAfter.amount) - Number(protocolBefore.amount);

  console.log(`   P1 change:       ${p1Diff > 0 ? "+" : ""}${(p1Diff / 1e6).toFixed(6)} USDC (expected: +${((winnerPayout - STAKE) / 1e6).toFixed(6)})`);
  console.log(`   P2 change:       ${p2Diff > 0 ? "+" : ""}${(p2Diff / 1e6).toFixed(6)} USDC (expected: -${(STAKE / 1e6).toFixed(6)})`);
  console.log(`   Partner fee:     +${(partnerDiff / 1e6).toFixed(6)} USDC (expected: +${(partnerShare / 1e6).toFixed(6)})`);
  console.log(`   Protocol fee:    +${(protocolDiff / 1e6).toFixed(6)} USDC (expected: +${(contentionShare / 1e6).toFixed(6)})`);
  console.log(`   Vault balance:   ${(Number(vaultAfter.amount) / 1e6).toFixed(6)} USDC (expected: 0.000000)`);

  // Assertions
  const pass = (name: string, actual: number, expected: number) => {
    const ok = actual === expected;
    console.log(`   ${ok ? "✅" : "❌"} ${name}: ${ok ? "PASS" : `FAIL (got ${actual}, expected ${expected})`}`);
    return ok;
  };

  console.log("\n   --- ASSERTIONS ---");
  let allPass = true;
  allPass = pass("P1 net gain", p1Diff, winnerPayout - STAKE) && allPass;
  allPass = pass("P2 net loss", p2Diff, -STAKE) && allPass;
  allPass = pass("Partner fee", partnerDiff, partnerShare) && allPass;
  allPass = pass("Protocol fee", protocolDiff, contentionShare) && allPass;
  allPass = pass("Vault empty", Number(vaultAfter.amount), 0) && allPass;

  // 6. Close market
  console.log("\n6. Closing market (reclaiming rent)...");
  const closeSig = await program.methods
    .closeMarket()
    .accounts({
      market: marketPda,
      marketVault: vaultPda,
      authority: partnerKeypair.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .signers([partnerKeypair])
    .rpc();
  console.log(`   Tx: ${closeSig}`);

  // Verify market is gone
  const marketInfo = await provider.connection.getAccountInfo(marketPda);
  console.log(`   Market account: ${marketInfo ? "STILL EXISTS ❌" : "CLOSED ✅"}\n`);

  if (allPass && !marketInfo) {
    console.log("=== ALL TESTS PASSED ✅ ===");
    console.log("Contention Markets is working on Solana devnet.");
    console.log(`Explorer: https://explorer.solana.com/tx/${resolveSig}?cluster=devnet`);
  } else {
    console.log("=== SOME TESTS FAILED ❌ ===");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
