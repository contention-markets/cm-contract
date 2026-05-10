/**
 * Fix: Update protocol config treasury to match our current ATA.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ContentionMarkets } from "../target/types/contention_markets";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ContentionMarkets as Program<ContentionMarkets>;

  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../devnet-config.json"), "utf-8"));
  const protocolConfigPda = new PublicKey(config.protocolConfig);
  const newTreasury = new PublicKey(config.protocolTreasury);

  console.log("Updating protocol treasury to:", newTreasury.toBase58());

  await program.methods
    .updateProtocolConfig(null, newTreasury)
    .accounts({
      protocolConfig: protocolConfigPda,
      admin: provider.wallet.publicKey,
    } as any)
    .rpc();

  console.log("Done. Treasury updated.");
}

main().catch(console.error);
