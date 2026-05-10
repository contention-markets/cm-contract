import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { ContentionMarkets } from "../target/types/contention_markets";

const POOL_SPONSOR = new PublicKey("FNKPP6q2qk3wqMd7ErkWYk98etrZfuMnvGh2EQKdrrcJ");

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ContentionMarkets as Program<ContentionMarkets>;
  const admin = (provider.wallet as any).payer;

  const [pcv2] = PublicKey.findProgramAddressSync([Buffer.from("protocol_config_v2")], program.programId);
  const cfg = await program.account.protocolConfigV2.fetch(pcv2);
  console.log("Current pool_sponsor:", cfg.poolSponsor.toBase58());
  console.log("Target pool_sponsor:", POOL_SPONSOR.toBase58());

  if (cfg.poolSponsor.equals(POOL_SPONSOR)) {
    console.log("Already correct. Nothing to do.");
    return;
  }

  const [pc] = PublicKey.findProgramAddressSync([Buffer.from("protocol_config")], program.programId);
  const sig = await program.methods
    .updateProtocolConfigV2(POOL_SPONSOR, null, null, null)
    .accountsStrict({ protocolConfigV2: pcv2, protocolConfig: pc, admin: admin.publicKey } as any)
    .rpc();
  console.log("Updated. tx", sig);
}
main().catch(e => { console.error(e); process.exit(1); });
