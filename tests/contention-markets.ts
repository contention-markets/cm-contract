import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ContentionMarkets } from "../target/types/contention_markets";
import { expect } from "chai";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";

describe("contention-markets", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace
    .ContentionMarkets as Program<ContentionMarkets>;

  // Keypairs
  const admin = (provider.wallet as any).payer as Keypair;
  const partner = Keypair.generate();
  const p1 = Keypair.generate();
  const p2 = Keypair.generate();
  const outsider = Keypair.generate();

  // Token
  let mint: PublicKey;
  const DECIMALS = 6;
  const ONE_TOKEN = 1_000_000; // 1.0 with 6 decimals

  // Token accounts
  let partnerTreasuryAta: PublicKey;
  let protocolTreasuryAta: PublicKey;
  let p1Ata: PublicKey;
  let p2Ata: PublicKey;

  // PDAs
  let protocolConfigPda: PublicKey;
  let protocolConfigBump: number;
  let partnerRegistryPda: PublicKey;

  // Protocol config
  const PROTOCOL_FEE_BPS = 200; // 2%
  const PARTNER_FEE_SHARE_BPS = 5000; // 50% of protocol fee
  const PROTOCOL_TREASURY_WALLET = Keypair.generate();

  // ──────────────────────────────────────────────────────────────────────
  // Setup
  // ──────────────────────────────────────────────────────────────────────

  before(async () => {
    // Airdrop SOL to all participants
    const airdropTargets = [partner, p1, p2, outsider, PROTOCOL_TREASURY_WALLET];
    for (const kp of airdropTargets) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Create SPL token mint (simulating USDC)
    mint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      DECIMALS
    );

    // Create ATAs and mint tokens to players
    const p1Account = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      mint,
      p1.publicKey
    );
    p1Ata = p1Account.address;

    const p2Account = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      mint,
      p2.publicKey
    );
    p2Ata = p2Account.address;

    // Partner treasury ATA (owned by partner keypair for simplicity)
    const partnerTreasuryAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      mint,
      partner.publicKey
    );
    partnerTreasuryAta = partnerTreasuryAccount.address;

    // Protocol treasury ATA
    const protocolTreasuryAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      mint,
      PROTOCOL_TREASURY_WALLET.publicKey
    );
    protocolTreasuryAta = protocolTreasuryAccount.address;

    // Mint 100 tokens to each player
    await mintTo(
      provider.connection,
      admin,
      mint,
      p1Ata,
      admin,
      100 * ONE_TOKEN
    );
    await mintTo(
      provider.connection,
      admin,
      mint,
      p2Ata,
      admin,
      100 * ONE_TOKEN
    );

    // Derive PDAs
    [protocolConfigPda, protocolConfigBump] =
      PublicKey.findProgramAddressSync(
        [Buffer.from("protocol_config")],
        program.programId
      );

    [partnerRegistryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("partner_registry"), partner.publicKey.toBuffer()],
      program.programId
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────

  function deriveMarketPda(eventId: anchor.BN): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("market"), eventId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  }

  function deriveVaultPda(marketPda: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer()],
      program.programId
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // 1. Protocol Initialization
  // ──────────────────────────────────────────────────────────────────────

  describe("Protocol Initialization", () => {
    it("initializes the protocol config", async () => {
      // Store the ATA address (not wallet address) so resolve can match it
      await program.methods
        .initializeProtocol(
          protocolTreasuryAta,
          PROTOCOL_FEE_BPS
        )
        .accounts({
          protocolConfig: protocolConfigPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const config = await program.account.protocolConfig.fetch(
        protocolConfigPda
      );
      expect(config.admin.toBase58()).to.equal(admin.publicKey.toBase58());
      expect(config.treasury.toBase58()).to.equal(
        protocolTreasuryAta.toBase58()
      );
      expect(config.protocolFeeBps).to.equal(PROTOCOL_FEE_BPS);
    });

    it("rejects fee > 10%", async () => {
      try {
        // Can't re-init (PDA already exists), but we can test update
        await program.methods
          .updateProtocolConfig(1001, null)
          .accounts({
            protocolConfig: protocolConfigPda,
            admin: admin.publicKey,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("FeeTooHigh");
      }
    });

    it("rejects non-admin config update", async () => {
      try {
        await program.methods
          .updateProtocolConfig(100, null)
          .accounts({
            protocolConfig: protocolConfigPda,
            admin: outsider.publicKey,
          })
          .signers([outsider])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 2. Partner Management
  // ──────────────────────────────────────────────────────────────────────

  describe("Partner Management", () => {
    it("registers a partner", async () => {
      await program.methods
        .registerPartner(PARTNER_FEE_SHARE_BPS)
        .accounts({
          partnerRegistry: partnerRegistryPda,
          partnerProgram: partner.publicKey,
          partnerTreasury: partnerTreasuryAta,
          admin: admin.publicKey,
          protocolConfig: protocolConfigPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const registry = await program.account.partnerRegistry.fetch(
        partnerRegistryPda
      );
      expect(registry.partnerProgramId.toBase58()).to.equal(
        partner.publicKey.toBase58()
      );
      expect(registry.verifiedTreasury.toBase58()).to.equal(
        partnerTreasuryAta.toBase58()
      );
      expect(registry.feeShareBps).to.equal(PARTNER_FEE_SHARE_BPS);
      expect(registry.isActive).to.be.true;
    });

    it("rejects non-admin partner registration", async () => {
      const fakePartner = Keypair.generate();
      const [fakePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("partner_registry"), fakePartner.publicKey.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .registerPartner(5000)
          .accounts({
            partnerRegistry: fakePda,
            partnerProgram: fakePartner.publicKey,
            partnerTreasury: partnerTreasuryAta,
            admin: outsider.publicKey,
            protocolConfig: protocolConfigPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([outsider])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });

    it("admin can deactivate a partner", async () => {
      await program.methods
        .setPartnerActive(false)
        .accounts({
          partnerRegistry: partnerRegistryPda,
          protocolConfig: protocolConfigPda,
          admin: admin.publicKey,
        })
        .rpc();

      let registry = await program.account.partnerRegistry.fetch(
        partnerRegistryPda
      );
      expect(registry.isActive).to.be.false;

      // Re-activate for subsequent tests
      await program.methods
        .setPartnerActive(true)
        .accounts({
          partnerRegistry: partnerRegistryPda,
          protocolConfig: protocolConfigPda,
          admin: admin.publicKey,
        })
        .rpc();

      registry = await program.account.partnerRegistry.fetch(
        partnerRegistryPda
      );
      expect(registry.isActive).to.be.true;
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 3. Market Lifecycle — Happy Path (P1 Wins)
  // ──────────────────────────────────────────────────────────────────────

  describe("Market Lifecycle — P1 Wins", () => {
    const eventId = new anchor.BN(1000001);
    let marketPda: PublicKey;
    let vaultPda: PublicKey;

    before(() => {
      [marketPda] = deriveMarketPda(eventId);
      [vaultPda] = deriveVaultPda(marketPda);
    });

    it("initializes a market with vault", async () => {
      await program.methods
        .initializeMarket(
          eventId,
          '{"game":"molty_chess","chat":"Let\'s go!"}',
          p1.publicKey,
          p2.publicKey,
          new anchor.BN(0) // no expiry
        )
        .accounts({
          market: marketPda,
          marketVault: vaultPda,
          mint: mint,
          partnerRegistry: partnerRegistryPda,
          authority: partner.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([partner])
        .rpc();

      const market = await program.account.marketState.fetch(marketPda);
      expect(market.authority.toBase58()).to.equal(
        partner.publicKey.toBase58()
      );
      expect(market.mint.toBase58()).to.equal(mint.toBase58());
      expect(market.p1.toBase58()).to.equal(p1.publicKey.toBase58());
      expect(market.p2.toBase58()).to.equal(p2.publicKey.toBase58());
      expect(market.eventId.toNumber()).to.equal(eventId.toNumber());
      expect(market.p1Deposit.toNumber()).to.equal(0);
      expect(market.p2Deposit.toNumber()).to.equal(0);
      expect(market.resolved).to.be.false;
      expect(market.settled).to.be.false;

      // Vault should exist and be empty
      const vault = await getAccount(provider.connection, vaultPda);
      expect(Number(vault.amount)).to.equal(0);
    });

    it("P1 deposits 10 tokens", async () => {
      const amount = 10 * ONE_TOKEN;

      await program.methods
        .deposit(new anchor.BN(amount))
        .accounts({
          market: marketPda,
          marketVault: vaultPda,
          userTokenAccount: p1Ata,
          user: p1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([p1])
        .rpc();

      const market = await program.account.marketState.fetch(marketPda);
      expect(market.p1Deposit.toNumber()).to.equal(amount);

      const vault = await getAccount(provider.connection, vaultPda);
      expect(Number(vault.amount)).to.equal(amount);
    });

    it("P2 deposits 10 tokens", async () => {
      const amount = 10 * ONE_TOKEN;

      await program.methods
        .deposit(new anchor.BN(amount))
        .accounts({
          market: marketPda,
          marketVault: vaultPda,
          userTokenAccount: p2Ata,
          user: p2.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([p2])
        .rpc();

      const market = await program.account.marketState.fetch(marketPda);
      expect(market.p2Deposit.toNumber()).to.equal(amount);

      const vault = await getAccount(provider.connection, vaultPda);
      expect(Number(vault.amount)).to.equal(2 * amount);
    });

    it("rejects deposit from non-player", async () => {
      try {
        await program.methods
          .deposit(new anchor.BN(ONE_TOKEN))
          .accounts({
            market: marketPda,
            marketVault: vaultPda,
            userTokenAccount: p1Ata,
            user: outsider.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([outsider])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Constraint check fires on either UnauthorizedPlayer or TokenOwnerMismatch
        expect(err.toString()).to.match(
          /UnauthorizedPlayer|TokenOwnerMismatch|ConstraintRaw/
        );
      }
    });

    it("resolves market — P1 wins with correct fee distribution", async () => {
      const totalPot = 20 * ONE_TOKEN; // 20.0 tokens
      const protocolFee = (totalPot * PROTOCOL_FEE_BPS) / 10000; // 0.4 tokens
      const partnerShare =
        (protocolFee * PARTNER_FEE_SHARE_BPS) / 10000; // 0.2 tokens
      const contentionShare = protocolFee - partnerShare; // 0.2 tokens
      const winnerPayout = totalPot - protocolFee; // 19.6 tokens

      const p1Before = await getAccount(provider.connection, p1Ata);
      const partnerBefore = await getAccount(
        provider.connection,
        partnerTreasuryAta
      );
      const protocolBefore = await getAccount(
        provider.connection,
        protocolTreasuryAta
      );

      await program.methods
        .resolveMarket(0) // P1 wins
        .accounts({
          market: marketPda,
          authority: partner.publicKey,
          partnerRegistry: partnerRegistryPda,
          protocolConfig: protocolConfigPda,
          marketVault: vaultPda,
          p1TokenAccount: p1Ata,
          p2TokenAccount: p2Ata,
          partnerTreasury: partnerTreasuryAta,
          protocolTreasury: protocolTreasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([partner])
        .rpc();

      // Verify market state
      const market = await program.account.marketState.fetch(marketPda);
      expect(market.resolved).to.be.true;
      expect(market.settled).to.be.true;
      expect(market.winningOutcome).to.equal(0);

      // Verify P1 received winnings
      const p1After = await getAccount(provider.connection, p1Ata);
      expect(Number(p1After.amount) - Number(p1Before.amount)).to.equal(
        winnerPayout
      );

      // Verify partner received fee share
      const partnerAfter = await getAccount(
        provider.connection,
        partnerTreasuryAta
      );
      expect(
        Number(partnerAfter.amount) - Number(partnerBefore.amount)
      ).to.equal(partnerShare);

      // Verify protocol received fee share
      const protocolAfter = await getAccount(
        provider.connection,
        protocolTreasuryAta
      );
      expect(
        Number(protocolAfter.amount) - Number(protocolBefore.amount)
      ).to.equal(contentionShare);

      // Vault should be empty
      const vault = await getAccount(provider.connection, vaultPda);
      expect(Number(vault.amount)).to.equal(0);
    });

    it("rejects double resolution", async () => {
      try {
        await program.methods
          .resolveMarket(1)
          .accounts({
            market: marketPda,
            authority: partner.publicKey,
            partnerRegistry: partnerRegistryPda,
            protocolConfig: protocolConfigPda,
            marketVault: vaultPda,
            p1TokenAccount: p1Ata,
            p2TokenAccount: p2Ata,
            partnerTreasury: partnerTreasuryAta,
            protocolTreasury: protocolTreasuryAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([partner])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("MarketAlreadyResolved");
      }
    });

    it("closes market and reclaims rent", async () => {
      await program.methods
        .closeMarket()
        .accounts({
          market: marketPda,
          marketVault: vaultPda,
          authority: partner.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([partner])
        .rpc();

      // Market account should no longer exist
      try {
        await program.account.marketState.fetch(marketPda);
        expect.fail("Account should be closed");
      } catch (err: any) {
        expect(err.toString()).to.include("Account does not exist");
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 4. Market Lifecycle — Cancel (Refund)
  // ──────────────────────────────────────────────────────────────────────

  describe("Market Lifecycle — Cancel", () => {
    const eventId = new anchor.BN(2000001);
    let marketPda: PublicKey;
    let vaultPda: PublicKey;

    before(async () => {
      [marketPda] = deriveMarketPda(eventId);
      [vaultPda] = deriveVaultPda(marketPda);

      // Init market
      await program.methods
        .initializeMarket(
          eventId,
          '{"game":"test","chat":"Cancel test"}',
          p1.publicKey,
          p2.publicKey,
          new anchor.BN(0)
        )
        .accounts({
          market: marketPda,
          marketVault: vaultPda,
          mint: mint,
          partnerRegistry: partnerRegistryPda,
          authority: partner.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([partner])
        .rpc();

      // Both players deposit 5 tokens
      for (const [user, ata] of [
        [p1, p1Ata],
        [p2, p2Ata],
      ] as [Keypair, PublicKey][]) {
        await program.methods
          .deposit(new anchor.BN(5 * ONE_TOKEN))
          .accounts({
            market: marketPda,
            marketVault: vaultPda,
            userTokenAccount: ata,
            user: user.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc();
      }
    });

    it("contested cancel: both deposited → fee taken, proportional refund", async () => {
      const depositEach = 5 * ONE_TOKEN;
      const totalPot = 2 * depositEach; // 10 tokens
      const cancelFee = (totalPot * PROTOCOL_FEE_BPS) / 10000; // 0.2 tokens
      const partnerFeeShare =
        (cancelFee * PARTNER_FEE_SHARE_BPS) / 10000; // 0.1 tokens
      const contentionFeeShare = cancelFee - partnerFeeShare; // 0.1 tokens
      const remaining = totalPot - cancelFee; // 9.8 tokens
      // Equal deposits → equal refunds: 4.9 each
      const p1Refund = Math.floor(
        (remaining * depositEach) / (2 * depositEach)
      );
      const p2Refund = remaining - p1Refund;

      const p1Before = await getAccount(provider.connection, p1Ata);
      const p2Before = await getAccount(provider.connection, p2Ata);
      const partnerBefore = await getAccount(
        provider.connection,
        partnerTreasuryAta
      );
      const protocolBefore = await getAccount(
        provider.connection,
        protocolTreasuryAta
      );

      await program.methods
        .resolveMarket(255) // CANCELLED
        .accounts({
          market: marketPda,
          authority: partner.publicKey,
          partnerRegistry: partnerRegistryPda,
          protocolConfig: protocolConfigPda,
          marketVault: vaultPda,
          p1TokenAccount: p1Ata,
          p2TokenAccount: p2Ata,
          partnerTreasury: partnerTreasuryAta,
          protocolTreasury: protocolTreasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([partner])
        .rpc();

      // Players get proportional refund (minus fee)
      const p1After = await getAccount(provider.connection, p1Ata);
      const p2After = await getAccount(provider.connection, p2Ata);
      expect(Number(p1After.amount) - Number(p1Before.amount)).to.equal(
        p1Refund
      );
      expect(Number(p2After.amount) - Number(p2Before.amount)).to.equal(
        p2Refund
      );

      // Fees collected
      const partnerAfter = await getAccount(
        provider.connection,
        partnerTreasuryAta
      );
      expect(
        Number(partnerAfter.amount) - Number(partnerBefore.amount)
      ).to.equal(partnerFeeShare);

      const protocolAfter = await getAccount(
        provider.connection,
        protocolTreasuryAta
      );
      expect(
        Number(protocolAfter.amount) - Number(protocolBefore.amount)
      ).to.equal(contentionFeeShare);

      const market = await program.account.marketState.fetch(marketPda);
      expect(market.resolved).to.be.true;
      expect(market.settled).to.be.true;
      expect(market.winningOutcome).to.be.null;
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 5. Market Lifecycle — Expiry
  // ──────────────────────────────────────────────────────────────────────

  describe("Market Lifecycle — Expiry", () => {
    const eventId = new anchor.BN(3000001);
    let marketPda: PublicKey;
    let vaultPda: PublicKey;

    it("creates a market with short expiry and deposits", async () => {
      [marketPda] = deriveMarketPda(eventId);
      [vaultPda] = deriveVaultPda(marketPda);

      // Expire 3 seconds from now
      const clock = await provider.connection.getSlot();
      const blockTime = await provider.connection.getBlockTime(clock);
      const expiresAt = new anchor.BN(blockTime! + 3);

      await program.methods
        .initializeMarket(
          eventId,
          '{"game":"test","chat":"Expire test"}',
          p1.publicKey,
          p2.publicKey,
          expiresAt
        )
        .accounts({
          market: marketPda,
          marketVault: vaultPda,
          mint: mint,
          partnerRegistry: partnerRegistryPda,
          authority: partner.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([partner])
        .rpc();

      // P1 deposits
      await program.methods
        .deposit(new anchor.BN(3 * ONE_TOKEN))
        .accounts({
          market: marketPda,
          marketVault: vaultPda,
          userTokenAccount: p1Ata,
          user: p1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([p1])
        .rpc();
    });

    it("rejects expire before timeout", async () => {
      try {
        await program.methods
          .expireMarket()
          .accounts({
            market: marketPda,
            marketVault: vaultPda,
            p1TokenAccount: p1Ata,
            p2TokenAccount: p2Ata,
            caller: outsider.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([outsider])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("NotExpired");
      }
    });

    it("anyone can expire after timeout and P1 gets refund", async () => {
      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 4000));

      const p1Before = await getAccount(provider.connection, p1Ata);

      await program.methods
        .expireMarket()
        .accounts({
          market: marketPda,
          marketVault: vaultPda,
          p1TokenAccount: p1Ata,
          p2TokenAccount: p2Ata,
          caller: outsider.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([outsider])
        .rpc();

      // P1 gets full refund
      const p1After = await getAccount(provider.connection, p1Ata);
      expect(Number(p1After.amount) - Number(p1Before.amount)).to.equal(
        3 * ONE_TOKEN
      );

      const market = await program.account.marketState.fetch(marketPda);
      expect(market.resolved).to.be.true;
      expect(market.settled).to.be.true;
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 6. Security / Edge Cases
  // ──────────────────────────────────────────────────────────────────────

  describe("Security", () => {
    const eventId = new anchor.BN(4000001);
    let marketPda: PublicKey;
    let vaultPda: PublicKey;

    before(async () => {
      [marketPda] = deriveMarketPda(eventId);
      [vaultPda] = deriveVaultPda(marketPda);

      await program.methods
        .initializeMarket(
          eventId,
          '{"game":"test","chat":"Security test"}',
          p1.publicKey,
          p2.publicKey,
          new anchor.BN(0)
        )
        .accounts({
          market: marketPda,
          marketVault: vaultPda,
          mint: mint,
          partnerRegistry: partnerRegistryPda,
          authority: partner.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([partner])
        .rpc();
    });

    it("rejects duplicate players", async () => {
      const dupEventId = new anchor.BN(4000002);
      const [dupMarket] = deriveMarketPda(dupEventId);
      const [dupVault] = deriveVaultPda(dupMarket);

      try {
        await program.methods
          .initializeMarket(
            dupEventId,
            '{"game":"test","chat":"dup"}',
            p1.publicKey,
            p1.publicKey, // same as P1!
            new anchor.BN(0)
          )
          .accounts({
            market: dupMarket,
            marketVault: dupVault,
            mint: mint,
            partnerRegistry: partnerRegistryPda,
            authority: partner.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([partner])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("DuplicatePlayers");
      }
    });

    it("rejects metadata too long", async () => {
      const longEventId = new anchor.BN(4000003);
      const [longMarket] = deriveMarketPda(longEventId);
      const [longVault] = deriveVaultPda(longMarket);

      try {
        await program.methods
          .initializeMarket(
            longEventId,
            "x".repeat(513), // Over 512 limit
            p1.publicKey,
            p2.publicKey,
            new anchor.BN(0)
          )
          .accounts({
            market: longMarket,
            marketVault: longVault,
            mint: mint,
            partnerRegistry: partnerRegistryPda,
            authority: partner.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([partner])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("MetadataTooLong");
      }
    });

    it("rejects unauthorized authority on resolve", async () => {
      try {
        await program.methods
          .resolveMarket(0)
          .accounts({
            market: marketPda,
            authority: outsider.publicKey, // not the partner
            partnerRegistry: partnerRegistryPda,
            protocolConfig: protocolConfigPda,
            marketVault: vaultPda,
            p1TokenAccount: p1Ata,
            p2TokenAccount: p2Ata,
            partnerTreasury: partnerTreasuryAta,
            protocolTreasury: protocolTreasuryAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([outsider])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Anchor has_one check or constraint will fail
        expect(err.toString()).to.match(
          /UnauthorizedPartner|ConstraintHasOne|ConstraintSeeds/
        );
      }
    });

    it("rejects invalid outcome (e.g. 5)", async () => {
      // Deposit so market has funds
      await program.methods
        .deposit(new anchor.BN(ONE_TOKEN))
        .accounts({
          market: marketPda,
          marketVault: vaultPda,
          userTokenAccount: p1Ata,
          user: p1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([p1])
        .rpc();

      try {
        await program.methods
          .resolveMarket(5) // invalid
          .accounts({
            market: marketPda,
            authority: partner.publicKey,
            partnerRegistry: partnerRegistryPda,
            protocolConfig: protocolConfigPda,
            marketVault: vaultPda,
            p1TokenAccount: p1Ata,
            p2TokenAccount: p2Ata,
            partnerTreasury: partnerTreasuryAta,
            protocolTreasury: protocolTreasuryAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([partner])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidOutcome");
      }
    });

    it("rejects zero deposit", async () => {
      try {
        await program.methods
          .deposit(new anchor.BN(0))
          .accounts({
            market: marketPda,
            marketVault: vaultPda,
            userTokenAccount: p1Ata,
            user: p1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([p1])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("ZeroAmount");
      }
    });

    it("rejects deposit after resolution", async () => {
      // First resolve the market
      await program.methods
        .resolveMarket(255) // cancel for simplicity
        .accounts({
          market: marketPda,
          authority: partner.publicKey,
          partnerRegistry: partnerRegistryPda,
          protocolConfig: protocolConfigPda,
          marketVault: vaultPda,
          p1TokenAccount: p1Ata,
          p2TokenAccount: p2Ata,
          partnerTreasury: partnerTreasuryAta,
          protocolTreasury: protocolTreasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([partner])
        .rpc();

      try {
        await program.methods
          .deposit(new anchor.BN(ONE_TOKEN))
          .accounts({
            market: marketPda,
            marketVault: vaultPda,
            userTokenAccount: p1Ata,
            user: p1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([p1])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("MarketAlreadyResolved");
      }
    });

    it("rejects close before settlement", async () => {
      // Create a new unresolved market
      const freshEventId = new anchor.BN(4000010);
      const [freshMarket] = deriveMarketPda(freshEventId);
      const [freshVault] = deriveVaultPda(freshMarket);

      await program.methods
        .initializeMarket(
          freshEventId,
          '{"game":"test","chat":"close test"}',
          p1.publicKey,
          p2.publicKey,
          new anchor.BN(0)
        )
        .accounts({
          market: freshMarket,
          marketVault: freshVault,
          mint: mint,
          partnerRegistry: partnerRegistryPda,
          authority: partner.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([partner])
        .rpc();

      try {
        await program.methods
          .closeMarket()
          .accounts({
            market: freshMarket,
            marketVault: freshVault,
            authority: partner.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([partner])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("MarketNotResolved");
      }
    });

    it("rejects expire on market without expiry", async () => {
      const noExpiryEventId = new anchor.BN(4000020);
      const [neMarket] = deriveMarketPda(noExpiryEventId);
      const [neVault] = deriveVaultPda(neMarket);

      await program.methods
        .initializeMarket(
          noExpiryEventId,
          '{"game":"test","chat":"no expiry"}',
          p1.publicKey,
          p2.publicKey,
          new anchor.BN(0) // no expiry
        )
        .accounts({
          market: neMarket,
          marketVault: neVault,
          mint: mint,
          partnerRegistry: partnerRegistryPda,
          authority: partner.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([partner])
        .rpc();

      try {
        await program.methods
          .expireMarket()
          .accounts({
            market: neMarket,
            marketVault: neVault,
            p1TokenAccount: p1Ata,
            p2TokenAccount: p2Ata,
            caller: outsider.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([outsider])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("NoExpiry");
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 7. P2 Wins Flow
  // ──────────────────────────────────────────────────────────────────────

  describe("Market Lifecycle — P2 Wins", () => {
    const eventId = new anchor.BN(5000001);
    let marketPda: PublicKey;
    let vaultPda: PublicKey;

    before(async () => {
      [marketPda] = deriveMarketPda(eventId);
      [vaultPda] = deriveVaultPda(marketPda);

      await program.methods
        .initializeMarket(
          eventId,
          '{"game":"test","chat":"P2 wins test"}',
          p1.publicKey,
          p2.publicKey,
          new anchor.BN(0)
        )
        .accounts({
          market: marketPda,
          marketVault: vaultPda,
          mint: mint,
          partnerRegistry: partnerRegistryPda,
          authority: partner.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([partner])
        .rpc();

      // Both deposit
      await program.methods
        .deposit(new anchor.BN(5 * ONE_TOKEN))
        .accounts({
          market: marketPda,
          marketVault: vaultPda,
          userTokenAccount: p1Ata,
          user: p1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([p1])
        .rpc();

      await program.methods
        .deposit(new anchor.BN(5 * ONE_TOKEN))
        .accounts({
          market: marketPda,
          marketVault: vaultPda,
          userTokenAccount: p2Ata,
          user: p2.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([p2])
        .rpc();
    });

    it("resolves with P2 as winner", async () => {
      const p2Before = await getAccount(provider.connection, p2Ata);

      await program.methods
        .resolveMarket(1) // P2 wins
        .accounts({
          market: marketPda,
          authority: partner.publicKey,
          partnerRegistry: partnerRegistryPda,
          protocolConfig: protocolConfigPda,
          marketVault: vaultPda,
          p1TokenAccount: p1Ata,
          p2TokenAccount: p2Ata,
          partnerTreasury: partnerTreasuryAta,
          protocolTreasury: protocolTreasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([partner])
        .rpc();

      const market = await program.account.marketState.fetch(marketPda);
      expect(market.winningOutcome).to.equal(1);

      // P2 should receive pot minus fees
      const totalPot = 10 * ONE_TOKEN;
      const fee = (totalPot * PROTOCOL_FEE_BPS) / 10000;
      const expectedPayout = totalPot - fee;

      const p2After = await getAccount(provider.connection, p2Ata);
      expect(Number(p2After.amount) - Number(p2Before.amount)).to.equal(
        expectedPayout
      );
    });
  });
});
