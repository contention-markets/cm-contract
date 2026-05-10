use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::anchor::ephemeral;

declare_id!("69YfcveAbLbJ5LNERjq6k5wnszfZbXMYVzx2j8Ca1Xo8");

// ============================================================================
// Constants
// ============================================================================

/// Maximum metadata length (bytes). Derived from Solana's 1232-byte MTU budget.
pub const MAX_METADATA_LEN: usize = 512;

/// Basis point ceiling (100%).
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Maximum protocol fee: 10% (1000 bps). Prevents admin from setting predatory fees.
pub const MAX_PROTOCOL_FEE_BPS: u16 = 1_000;

/// Outcome codes for 1v1 Direct Settlement.
pub const OUTCOME_P1_WINS: u8 = 0;
pub const OUTCOME_P2_WINS: u8 = 1;
pub const OUTCOME_CANCELLED: u8 = 255;

// ============================================================================
// V2 Constants
// ============================================================================

/// V2 fee split defaults (basis points of pot, not of "protocol fee"):
/// Protocol treasury:   0.80% (80 bps)
/// Partner (creator):   1.00% (100 bps)
/// PoolBacker (free):  0.20% (20 bps)
/// Total rake:          2.00% (200 bps)
/// Winner payout:      98.00% (9800 bps)
pub const V2_PROTOCOL_FEE_BPS: u16 = 80;
pub const V2_PARTNER_FEE_BPS: u16 = 100;
pub const V2_POOL_SPONSOR_FEE_BPS: u16 = 20;

/// Maximum combined v2 rake: 5% safety ceiling on any individual fee component.
pub const V2_MAX_COMPONENT_FEE_BPS: u16 = 500;

/// Permissionless close cooldown: markets can't be closed until this long after creation.
/// Conservative 48hr window ensures any legitimate resolve/claim activity has time to settle.
pub const V2_CLOSE_COOLDOWN_SECONDS: i64 = 172_800; // 48 hours

/// Legacy (v2.0) fixed-offset layout — retained for backward compatibility.
/// Real production v2.1 uses `GameProgramRegistryV2`'s per-game adapter schema
/// so each registered game can declare its own layout (see `register_game_program_v2`).
pub const V2_GAME_STATE_MIN_LEN: usize = 74;
pub const V2_GAME_STATE_P1_OFFSET: usize = 8;
pub const V2_GAME_STATE_P2_OFFSET: usize = 40;
pub const V2_GAME_STATE_STATUS_OFFSET: usize = 72;
pub const V2_GAME_STATE_WINNER_OFFSET: usize = 73;
pub const V2_GAME_STATUS_FINISHED: u8 = 2;
pub const V2_GAME_WINNER_DRAW: u8 = 255;

/// Safety cap on how large a registered game's offsets can point. Prevents
/// admin mistakes / pointer oob in permissionless-resolve reads.
pub const V2_ADAPTER_MAX_OFFSET: u16 = 16_384;
pub const V2_ADAPTER_MAX_ACCOUNT_LEN: u16 = 16_384;

/// Drift-class admin-replay defense window cap.
pub const MAX_DEADLINE_FUTURE_SEC: i64 = 7 * 24 * 60 * 60;

/// 48-hour timelock for queued admin proposals.
pub const ADMIN_TIMELOCK_SECONDS: i64 = 172_800;

fn check_deadline(deadline: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(now <= deadline, MarketError::DeadlineExceeded);
    require!(deadline <= now + MAX_DEADLINE_FUTURE_SEC, MarketError::DeadlineTooFar);
    Ok(())
}

// ============================================================================
// Program
// ============================================================================

#[ephemeral]
#[program]
pub mod contention_markets {
    use super::*;

    // --- MagicBlock Ephemeral Rollup Delegation ---

    /// Delegate a market account to an ephemeral rollup for high-frequency gameplay.
    /// The `#[ephemeral]` macro intercepts this instruction to handle delegation via MagicBlock.
    pub fn delegate(_ctx: Context<Delegate>) -> Result<()> {
        Ok(())
    }

    /// Return a market account from ephemeral rollup back to L1.
    /// The `#[ephemeral]` macro intercepts this instruction to handle undelegation via MagicBlock.
    pub fn undelegate(_ctx: Context<Undelegate>) -> Result<()> {
        Ok(())
    }

    // --- Protocol Administration ---

    /// One-time initialization of the global protocol configuration.
    /// Sets the admin, treasury wallet, and protocol fee rate.
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        treasury: Pubkey,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        require!(
            protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS,
            MarketError::FeeTooHigh
        );

        let config = &mut ctx.accounts.protocol_config;
        config.admin = ctx.accounts.admin.key();
        config.treasury = treasury;
        config.protocol_fee_bps = protocol_fee_bps;
        config.bump = ctx.bumps.protocol_config;
        Ok(())
    }

    /// Update protocol fee rate or treasury wallet. Admin only.
    pub fn update_protocol_config(
        ctx: Context<UpdateProtocolConfig>,
        deadline: i64,
        new_fee_bps: Option<u16>,
        new_treasury: Option<Pubkey>,
    ) -> Result<()> {
        check_deadline(deadline)?;
        let config = &mut ctx.accounts.protocol_config;

        if let Some(fee) = new_fee_bps {
            require!(fee <= MAX_PROTOCOL_FEE_BPS, MarketError::FeeTooHigh);
            config.protocol_fee_bps = fee;
        }
        if let Some(treasury) = new_treasury {
            config.treasury = treasury;
        }
        Ok(())
    }

    // --- Partner Management ---

    /// Register a new partner (game engine / event source).
    /// Only the protocol admin can register partners.
    pub fn register_partner(
        ctx: Context<RegisterPartner>,
        deadline: i64,
        fee_share_bps: u16,
    ) -> Result<()> {
        check_deadline(deadline)?;
        require!(
            fee_share_bps <= BPS_DENOMINATOR as u16,
            MarketError::FeeTooHigh
        );

        let registry = &mut ctx.accounts.partner_registry;
        registry.partner_program_id = ctx.accounts.partner_program.key();
        registry.verified_treasury = ctx.accounts.partner_treasury.key();
        registry.fee_share_bps = fee_share_bps;
        registry.is_active = true;
        registry.bump = ctx.bumps.partner_registry;
        Ok(())
    }

    /// Update the treasury wallet for a partner. Requires the current treasury to sign.
    pub fn update_partner_treasury(ctx: Context<UpdatePartnerTreasury>, deadline: i64) -> Result<()> {
        check_deadline(deadline)?;
        let registry = &mut ctx.accounts.registry;
        registry.verified_treasury = ctx.accounts.new_treasury.key();
        Ok(())
    }

    /// Activate or deactivate a partner. Admin only.
    pub fn set_partner_active(ctx: Context<SetPartnerActive>, deadline: i64, is_active: bool) -> Result<()> {
        check_deadline(deadline)?;
        ctx.accounts.partner_registry.is_active = is_active;
        Ok(())
    }

    // --- Market Lifecycle ---

    /// Create a new 1v1 market with an associated token vault.
    /// Only registered, active partners can initialize markets (Partner Handshake).
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        event_id: u64,
        metadata: String,
        p1: Pubkey,
        p2: Pubkey,
        expires_at: i64,
        referrer: Option<Pubkey>,
    ) -> Result<()> {
        require!(
            metadata.len() <= MAX_METADATA_LEN,
            MarketError::MetadataTooLong
        );
        require!(p1 != p2, MarketError::DuplicatePlayers);

        let clock = Clock::get()?;
        if expires_at > 0 {
            require!(expires_at > clock.unix_timestamp, MarketError::ExpiryInPast);
        }

        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.authority.key();
        market.mint = ctx.accounts.mint.key();
        market.p1 = p1;
        market.p2 = p2;
        market.event_id = event_id;
        market.p1_deposit = 0;
        market.p2_deposit = 0;
        market.resolved = false;
        market.winning_outcome = None;
        market.created_at = clock.unix_timestamp;
        market.expires_at = expires_at;
        market.referrer = referrer.unwrap_or(Pubkey::default());
        market.backer_pool_p1 = 0;
        market.backer_pool_p2 = 0;
        market.settled = false;
        market.bump = ctx.bumps.market;
        market.vault_bump = ctx.bumps.market_vault;

        emit!(MarketInitialized {
            event_id,
            authority: market.authority,
            p1,
            p2,
            mint: market.mint,
            metadata,
        });

        Ok(())
    }

    /// Deposit collateral into a market. Only P1 or P2 can deposit.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, MarketError::ZeroAmount);

        let market = &mut ctx.accounts.market;
        let depositor = ctx.accounts.user.key();

        if depositor == market.p1 {
            market.p1_deposit = market
                .p1_deposit
                .checked_add(amount)
                .ok_or(MarketError::Overflow)?;
        } else {
            // Constraint already validated depositor is p1 or p2
            market.p2_deposit = market
                .p2_deposit
                .checked_add(amount)
                .ok_or(MarketError::Overflow)?;
        }

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.market_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(DepositMade {
            market: market.key(),
            user: depositor,
            amount,
        });

        Ok(())
    }

    /// Resolve a market and distribute funds atomically.
    ///
    /// Outcomes:
    /// - 0 (P1 wins): Fees taken, remainder to P1.
    /// - 1 (P2 wins): Fees taken, remainder to P2.
    /// - 255 (Cancelled):
    ///   - If only one player deposited: free refund (game never started).
    ///   - If both deposited: protocol fee still taken (prevents strategic cancel abuse).
    pub fn resolve_market(ctx: Context<ResolveMarket>, winning_outcome: u8) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let registry = &ctx.accounts.partner_registry;
        let config = &ctx.accounts.protocol_config;

        require!(!market.resolved, MarketError::MarketAlreadyResolved);

        let total_pot = ctx.accounts.market_vault.amount;
        let market_key = market.key();

        let vault_seeds: &[&[u8]] = &[b"vault", market_key.as_ref(), &[market.vault_bump]];
        let signer_seeds = &[vault_seeds];

        if winning_outcome == OUTCOME_CANCELLED {
            market.winning_outcome = None;
            market.resolved = true;

            let both_funded = market.p1_deposit > 0 && market.p2_deposit > 0;

            if both_funded {
                // ---- CONTESTED CANCEL: Both deposited, so fee applies ----
                // This prevents the partner from using cancel as a free option
                // (e.g., cancelling when their preferred player is losing).
                let cancel_fee = total_pot
                    .checked_mul(config.protocol_fee_bps as u64)
                    .ok_or(MarketError::Overflow)?
                    .checked_div(BPS_DENOMINATOR)
                    .ok_or(MarketError::Overflow)?;

                if cancel_fee > 0 {
                    let partner_share = cancel_fee
                        .checked_mul(registry.fee_share_bps as u64)
                        .ok_or(MarketError::Overflow)?
                        .checked_div(BPS_DENOMINATOR)
                        .ok_or(MarketError::Overflow)?;
                    let contention_share = cancel_fee
                        .checked_sub(partner_share)
                        .ok_or(MarketError::Overflow)?;

                    if partner_share > 0 {
                        token::transfer(
                            CpiContext::new_with_signer(
                                ctx.accounts.token_program.to_account_info(),
                                Transfer {
                                    from: ctx.accounts.market_vault.to_account_info(),
                                    to: ctx.accounts.partner_treasury.to_account_info(),
                                    authority: ctx.accounts.market_vault.to_account_info(),
                                },
                                signer_seeds,
                            ),
                            partner_share,
                        )?;
                    }

                    if contention_share > 0 {
                        token::transfer(
                            CpiContext::new_with_signer(
                                ctx.accounts.token_program.to_account_info(),
                                Transfer {
                                    from: ctx.accounts.market_vault.to_account_info(),
                                    to: ctx.accounts.protocol_treasury.to_account_info(),
                                    authority: ctx.accounts.market_vault.to_account_info(),
                                },
                                signer_seeds,
                            ),
                            contention_share,
                        )?;
                    }
                }

                // Refund each player proportionally from what remains
                let remaining = total_pot
                    .checked_sub(cancel_fee)
                    .ok_or(MarketError::Overflow)?;
                let p1_refund = remaining
                    .checked_mul(market.p1_deposit)
                    .ok_or(MarketError::Overflow)?
                    .checked_div(
                        market
                            .p1_deposit
                            .checked_add(market.p2_deposit)
                            .ok_or(MarketError::Overflow)?,
                    )
                    .ok_or(MarketError::Overflow)?;
                let p2_refund = remaining
                    .checked_sub(p1_refund)
                    .ok_or(MarketError::Overflow)?;

                if p1_refund > 0 {
                    token::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.token_program.to_account_info(),
                            Transfer {
                                from: ctx.accounts.market_vault.to_account_info(),
                                to: ctx.accounts.p1_token_account.to_account_info(),
                                authority: ctx.accounts.market_vault.to_account_info(),
                            },
                            signer_seeds,
                        ),
                        p1_refund,
                    )?;
                }

                if p2_refund > 0 {
                    token::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.token_program.to_account_info(),
                            Transfer {
                                from: ctx.accounts.market_vault.to_account_info(),
                                to: ctx.accounts.p2_token_account.to_account_info(),
                                authority: ctx.accounts.market_vault.to_account_info(),
                            },
                            signer_seeds,
                        ),
                        p2_refund,
                    )?;
                }
            } else {
                // ---- ONE-SIDED CANCEL: Free refund, game never started ----
                if market.p1_deposit > 0 {
                    token::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.token_program.to_account_info(),
                            Transfer {
                                from: ctx.accounts.market_vault.to_account_info(),
                                to: ctx.accounts.p1_token_account.to_account_info(),
                                authority: ctx.accounts.market_vault.to_account_info(),
                            },
                            signer_seeds,
                        ),
                        market.p1_deposit,
                    )?;
                }

                if market.p2_deposit > 0 {
                    token::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.token_program.to_account_info(),
                            Transfer {
                                from: ctx.accounts.market_vault.to_account_info(),
                                to: ctx.accounts.p2_token_account.to_account_info(),
                                authority: ctx.accounts.market_vault.to_account_info(),
                            },
                            signer_seeds,
                        ),
                        market.p2_deposit,
                    )?;
                }
            }

            market.settled = true;
        } else {
            // ---- RESOLVE: Pay winner, take fees ----
            require!(
                winning_outcome == OUTCOME_P1_WINS || winning_outcome == OUTCOME_P2_WINS,
                MarketError::InvalidOutcome
            );

            market.winning_outcome = Some(winning_outcome);
            market.resolved = true;

            // Calculate protocol fee
            let protocol_fee = total_pot
                .checked_mul(config.protocol_fee_bps as u64)
                .ok_or(MarketError::Overflow)?
                .checked_div(BPS_DENOMINATOR)
                .ok_or(MarketError::Overflow)?;

            if protocol_fee > 0 {
                let has_referrer = market.referrer != Pubkey::default();

                // Fee split: with referrer = 40/40/20, without = 50/50
                let (partner_share, contention_share, referrer_share) = if has_referrer {
                    let partner = protocol_fee
                        .checked_mul(4000).ok_or(MarketError::Overflow)?
                        .checked_div(BPS_DENOMINATOR).ok_or(MarketError::Overflow)?;
                    let referrer = protocol_fee
                        .checked_mul(2000).ok_or(MarketError::Overflow)?
                        .checked_div(BPS_DENOMINATOR).ok_or(MarketError::Overflow)?;
                    let contention = protocol_fee
                        .checked_sub(partner).ok_or(MarketError::Overflow)?
                        .checked_sub(referrer).ok_or(MarketError::Overflow)?;
                    (partner, contention, referrer)
                } else {
                    let partner = protocol_fee
                        .checked_mul(registry.fee_share_bps as u64).ok_or(MarketError::Overflow)?
                        .checked_div(BPS_DENOMINATOR).ok_or(MarketError::Overflow)?;
                    let contention = protocol_fee
                        .checked_sub(partner).ok_or(MarketError::Overflow)?;
                    (partner, contention, 0u64)
                };

                if partner_share > 0 {
                    token::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.token_program.to_account_info(),
                            Transfer {
                                from: ctx.accounts.market_vault.to_account_info(),
                                to: ctx.accounts.partner_treasury.to_account_info(),
                                authority: ctx.accounts.market_vault.to_account_info(),
                            },
                            signer_seeds,
                        ),
                        partner_share,
                    )?;
                }

                if contention_share > 0 {
                    token::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.token_program.to_account_info(),
                            Transfer {
                                from: ctx.accounts.market_vault.to_account_info(),
                                to: ctx.accounts.protocol_treasury.to_account_info(),
                                authority: ctx.accounts.market_vault.to_account_info(),
                            },
                            signer_seeds,
                        ),
                        contention_share,
                    )?;
                }

                // Pay referrer on-chain (provable, automatic)
                if referrer_share > 0 && has_referrer {
                    token::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.token_program.to_account_info(),
                            Transfer {
                                from: ctx.accounts.market_vault.to_account_info(),
                                to: ctx.accounts.referrer_token_account.to_account_info(),
                                authority: ctx.accounts.market_vault.to_account_info(),
                            },
                            signer_seeds,
                        ),
                        referrer_share,
                    )?;
                }
            }

            // Transfer remaining pot to winner
            let winner_payout = total_pot
                .checked_sub(protocol_fee)
                .ok_or(MarketError::Overflow)?;

            if winner_payout > 0 {
                let winner_account = if winning_outcome == OUTCOME_P1_WINS {
                    ctx.accounts.p1_token_account.to_account_info()
                } else {
                    ctx.accounts.p2_token_account.to_account_info()
                };

                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.market_vault.to_account_info(),
                            to: winner_account,
                            authority: ctx.accounts.market_vault.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    winner_payout,
                )?;
            }

            market.settled = true;
        }

        emit!(MarketResolved {
            market: market_key,
            winner: winning_outcome,
            total_pot,
        });

        Ok(())
    }

    /// Permissionless expiry. Anyone can call after the market's `expires_at` timestamp.
    /// Full refund to both players, no fees taken.
    pub fn expire_market(ctx: Context<ExpireMarket>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;

        require!(!market.resolved, MarketError::MarketAlreadyResolved);
        require!(market.expires_at > 0, MarketError::NoExpiry);
        require!(
            clock.unix_timestamp >= market.expires_at,
            MarketError::NotExpired
        );

        let market_key = market.key();
        let vault_seeds: &[&[u8]] = &[b"vault", market_key.as_ref(), &[market.vault_bump]];
        let signer_seeds = &[vault_seeds];

        market.resolved = true;
        market.winning_outcome = None;

        if market.p1_deposit > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.market_vault.to_account_info(),
                        to: ctx.accounts.p1_token_account.to_account_info(),
                        authority: ctx.accounts.market_vault.to_account_info(),
                    },
                    signer_seeds,
                ),
                market.p1_deposit,
            )?;
        }

        if market.p2_deposit > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.market_vault.to_account_info(),
                        to: ctx.accounts.p2_token_account.to_account_info(),
                        authority: ctx.accounts.market_vault.to_account_info(),
                    },
                    signer_seeds,
                ),
                market.p2_deposit,
            )?;
        }

        market.settled = true;

        emit!(MarketExpired {
            market: market_key,
        });

        Ok(())
    }

    // ── Skill-contest pari-mutuel ─────────────────────────────────────────

    /// Stake on a contestant. Resolves against the underlying game program.
    pub fn back_contestant(
        ctx: Context<BackContestant>,
        outcome: u8, // 0 = P1 wins, 1 = P2 wins
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, MarketError::ZeroAmount);
        require!(
            outcome == OUTCOME_P1_WINS || outcome == OUTCOME_P2_WINS,
            MarketError::InvalidOutcome
        );

        let market = &ctx.accounts.market;
        require!(!market.resolved, MarketError::MarketAlreadyResolved);

        // Create or update the bet record
        let bet = &mut ctx.accounts.bet;
        bet.market = market.key();
        bet.backer = ctx.accounts.backer.key();
        bet.outcome = outcome;
        bet.amount = bet.amount.checked_add(amount).ok_or(MarketError::Overflow)?;
        bet.claimed = false;

        // Update backer pool totals on the market
        let market = &mut ctx.accounts.market;
        if outcome == OUTCOME_P1_WINS {
            market.backer_pool_p1 = market
                .backer_pool_p1
                .checked_add(amount)
                .ok_or(MarketError::Overflow)?;
        } else {
            market.backer_pool_p2 = market
                .backer_pool_p2
                .checked_add(amount)
                .ok_or(MarketError::Overflow)?;
        }

        // Transfer tokens to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.backer_token_account.to_account_info(),
                    to: ctx.accounts.market_vault.to_account_info(),
                    authority: ctx.accounts.backer.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(ContestantBacked {
            market: market.key(),
            backer: ctx.accounts.backer.key(),
            outcome,
            amount,
            total_p1: market.backer_pool_p1,
            total_p2: market.backer_pool_p2,
        });

        Ok(())
    }

    /// Claim backer winnings after market resolution.
    /// Payout = (your_stake / winning_pool) * total_backer_pool * (1 - fee)
    /// Each winner calls this individually. Double-claim prevented by `claimed` flag.
    pub fn claim_backer_winnings(ctx: Context<ClaimBackerWinnings>) -> Result<()> {
        let market = &ctx.accounts.market;
        let config = &ctx.accounts.protocol_config;
        let bet = &mut ctx.accounts.bet;

        require!(market.resolved, MarketError::MarketNotResolved);
        require!(!bet.claimed, MarketError::AlreadyClaimed);

        let winning_outcome = market.winning_outcome.ok_or(MarketError::MarketNotResolved)?;

        // If market was cancelled (no winner), refund the bet
        let is_winner = bet.outcome == winning_outcome;
        let is_cancelled = market.winning_outcome.is_none();

        let total_backer_pool = market
            .backer_pool_p1
            .checked_add(market.backer_pool_p2)
            .ok_or(MarketError::Overflow)?;

        let payout = if is_cancelled {
            // Refund
            bet.amount
        } else if is_winner {
            let winning_pool = if winning_outcome == OUTCOME_P1_WINS {
                market.backer_pool_p1
            } else {
                market.backer_pool_p2
            };

            if winning_pool == 0 {
                return Err(MarketError::Overflow.into());
            }

            // Proportional payout: (your_stake / winning_pool) * total_pool
            let gross_payout = (bet.amount as u128)
                .checked_mul(total_backer_pool as u128)
                .ok_or(MarketError::Overflow)?
                .checked_div(winning_pool as u128)
                .ok_or(MarketError::Overflow)? as u64;

            // Deduct protocol fee
            let fee = gross_payout
                .checked_mul(config.protocol_fee_bps as u64)
                .ok_or(MarketError::Overflow)?
                .checked_div(BPS_DENOMINATOR)
                .ok_or(MarketError::Overflow)?;

            gross_payout.checked_sub(fee).ok_or(MarketError::Overflow)?
        } else {
            // Loser gets nothing
            0
        };

        bet.claimed = true;

        if payout > 0 {
            let market_key = market.key();
            let vault_seeds: &[&[u8]] = &[b"vault", market_key.as_ref(), &[market.vault_bump]];
            let signer_seeds = &[vault_seeds];

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.market_vault.to_account_info(),
                        to: ctx.accounts.backer_token_account.to_account_info(),
                        authority: ctx.accounts.market_vault.to_account_info(),
                    },
                    signer_seeds,
                ),
                payout,
            )?;
        }

        emit!(BackerWinningsClaimed {
            market: market.key(),
            backer: bet.backer,
            payout,
            outcome: bet.outcome,
        });

        Ok(())
    }

    // =========================================================================
    // V2 INSTRUCTIONS
    // - initialize_protocol_v2 / update_protocol_config_v2: v2 fee config PDA
    // - register_game_program: admin adds a game program to the on-chain allowlist
    // - resolve_market_from_game_pda: permissionless resolve by reading game state
    // - close_market_permissionless: anyone can close a 48h+ old settled market
    // =========================================================================

    /// One-time initialization of the v2 protocol configuration PDA.
    /// Stored at a SEPARATE PDA ("protocol_config_v2") — does not touch the v1
    /// ProtocolConfig (which stays admin/treasury source-of-truth). Must be called
    /// by the admin before any v2 instruction is usable.
    pub fn initialize_protocol_v2(
        ctx: Context<InitializeProtocolV2>,
        pool_backer: Pubkey,
        protocol_fee_bps: u16,
        partner_fee_bps: u16,
        pool_backer_fee_bps: u16,
    ) -> Result<()> {
        require!(
            protocol_fee_bps <= V2_MAX_COMPONENT_FEE_BPS,
            MarketError::V2FeeTooHigh
        );
        require!(
            partner_fee_bps <= V2_MAX_COMPONENT_FEE_BPS,
            MarketError::V2FeeTooHigh
        );
        require!(
            pool_backer_fee_bps <= V2_MAX_COMPONENT_FEE_BPS,
            MarketError::V2FeeTooHigh
        );

        let v2 = &mut ctx.accounts.protocol_config_v2;
        v2.pool_backer = pool_backer;
        v2.protocol_fee_bps = protocol_fee_bps;
        v2.partner_fee_bps = partner_fee_bps;
        v2.pool_backer_fee_bps = pool_backer_fee_bps;
        v2.bump = ctx.bumps.protocol_config_v2;

        emit!(ProtocolUpgradedToV2 {
            pool_backer,
            protocol_fee_bps,
            partner_fee_bps,
            pool_backer_fee_bps,
        });

        Ok(())
    }

    /// Admin may update v2 fee rates or PoolBacker destination. Each
    /// component bounded by V2_MAX_COMPONENT_FEE_BPS.
    pub fn update_protocol_config_v2(
        ctx: Context<UpdateProtocolConfigV2>,
        deadline: i64,
        new_pool_backer: Option<Pubkey>,
        new_protocol_fee_bps: Option<u16>,
        new_partner_fee_bps: Option<u16>,
        new_pool_backer_fee_bps: Option<u16>,
    ) -> Result<()> {
        check_deadline(deadline)?;
        let v2 = &mut ctx.accounts.protocol_config_v2;

        if let Some(ps) = new_pool_backer {
            v2.pool_backer = ps;
        }
        if let Some(bps) = new_protocol_fee_bps {
            require!(bps <= V2_MAX_COMPONENT_FEE_BPS, MarketError::V2FeeTooHigh);
            v2.protocol_fee_bps = bps;
        }
        if let Some(bps) = new_partner_fee_bps {
            require!(bps <= V2_MAX_COMPONENT_FEE_BPS, MarketError::V2FeeTooHigh);
            v2.partner_fee_bps = bps;
        }
        if let Some(bps) = new_pool_backer_fee_bps {
            require!(bps <= V2_MAX_COMPONENT_FEE_BPS, MarketError::V2FeeTooHigh);
            v2.pool_backer_fee_bps = bps;
        }

        Ok(())
    }

    /// Admin registers a game program whose state accounts may be read by
    /// `resolve_market_from_game_pda`. The game program's GameState accounts
    /// must follow the V2 layout (see module-level constants).
    pub fn register_game_program(
        ctx: Context<RegisterGameProgram>,
        deadline: i64,
        label: String,
    ) -> Result<()> {
        check_deadline(deadline)?;
        require!(label.len() <= 32, MarketError::MetadataTooLong);
        let registry = &mut ctx.accounts.game_program_registry;
        registry.game_program = ctx.accounts.game_program.key();
        let mut label_bytes = [0u8; 32];
        let src = label.as_bytes();
        label_bytes[..src.len()].copy_from_slice(src);
        registry.label = label_bytes;
        registry.is_active = true;
        registry.bump = ctx.bumps.game_program_registry;

        emit!(GameProgramRegistered {
            game_program: registry.game_program,
            label,
        });

        Ok(())
    }

    /// Production v2.1 registry: admin declares a full adapter schema for each
    /// game program, enabling permissionless resolve against ANY registered
    /// game's state layout — not just the hardcoded v2.0 offsets.
    ///
    /// Chess example: p1@16 (after 8-byte disc + 8-byte game_id prefix),
    /// p2@48, status@80, winner@85, status_finished_value=2 (GameStatus::Finished),
    /// winner_p1_value=1 (white wins), winner_p2_value=2 (black wins),
    /// winner_draw_value=0 (status=Finished + winner=0 → draw).
    ///
    /// Forward-compatible: Blockwords and PLA register their own offsets
    /// without CM v2 upgrades.
    pub fn register_game_program_v2(
        ctx: Context<RegisterGameProgramV2>,
        deadline: i64,
        label: String,
        adapter: GameAdapterSchema,
    ) -> Result<()> {
        check_deadline(deadline)?;
        require!(label.len() <= 32, MarketError::MetadataTooLong);
        // Range-check every offset so an admin typo can't point outside the
        // account data. Also assert p1_offset + 32 ≤ min_account_len so the
        // permissionless resolver can't OOB-read.
        require!(
            adapter.p1_offset <= V2_ADAPTER_MAX_OFFSET
                && adapter.p2_offset <= V2_ADAPTER_MAX_OFFSET
                && adapter.status_offset <= V2_ADAPTER_MAX_OFFSET
                && adapter.winner_offset <= V2_ADAPTER_MAX_OFFSET
                && adapter.min_account_len <= V2_ADAPTER_MAX_ACCOUNT_LEN,
            MarketError::V2AdapterOffsetTooLarge
        );
        require!(
            (adapter.p1_offset as usize) + 32 <= adapter.min_account_len as usize
                && (adapter.p2_offset as usize) + 32 <= adapter.min_account_len as usize
                && (adapter.status_offset as usize) < adapter.min_account_len as usize
                && (adapter.winner_offset as usize) < adapter.min_account_len as usize,
            MarketError::V2AdapterOffsetOverflow
        );
        // p1 and p2 pubkeys must not overlap (each is 32 bytes).
        let p1_end = (adapter.p1_offset as usize) + 32;
        let p2_end = (adapter.p2_offset as usize) + 32;
        require!(
            p1_end <= adapter.p2_offset as usize || p2_end <= adapter.p1_offset as usize,
            MarketError::V2AdapterOffsetOverlap
        );
        // Winner-byte values must be distinct so mapping is unambiguous.
        require!(
            adapter.winner_p1_value != adapter.winner_p2_value
                && adapter.winner_p1_value != adapter.winner_draw_value
                && adapter.winner_p2_value != adapter.winner_draw_value,
            MarketError::V2AdapterWinnerValuesCollide
        );

        let registry = &mut ctx.accounts.game_program_registry_v2;
        registry.game_program = ctx.accounts.game_program.key();
        let mut label_bytes = [0u8; 32];
        let src = label.as_bytes();
        label_bytes[..src.len()].copy_from_slice(src);
        registry.label = label_bytes;
        registry.is_active = true;
        registry.bump = ctx.bumps.game_program_registry_v2;
        registry.adapter = adapter;

        emit!(GameProgramRegisteredV2 {
            game_program: registry.game_program,
            label,
        });

        Ok(())
    }

    /// Binds a market to a specific game-state account so the permissionless
    /// resolver can't be pointed at an unrelated finished game that happens to
    /// have matching p1/p2 pubkeys. Called once per market, immediately after
    /// `initialize_market` (usually atomically via Orchestrator CPI).
    ///
    /// Authority = market.authority (the partner who created the market, can be
    /// a PDA). Payer pays rent separately (so a data-carrying PDA authority
    /// doesn't block `system_program::create_account`).
    pub fn bind_market_to_game(
        ctx: Context<BindMarketToGame>,
        game_state: Pubkey,
    ) -> Result<()> {
        let binding = &mut ctx.accounts.binding;
        binding.market = ctx.accounts.market.key();
        binding.game_program = ctx.accounts.game_program_registry_v2.game_program;
        binding.game_state = game_state;
        binding.bump = ctx.bumps.binding;

        emit!(MarketBoundToGame {
            market: binding.market,
            game_program: binding.game_program,
            game_state,
        });

        Ok(())
    }

    /// v2.1 market creation with separate payer + authority.
    /// Mirrors `initialize_market` but `payer` pays rent and `authority` only
    /// proves partner identity (can be a PDA via CPI invoke_signed).
    pub fn initialize_market_v21(
        ctx: Context<InitializeMarketV21>,
        event_id: u64,
        metadata: String,
        p1: Pubkey,
        p2: Pubkey,
        expires_at: i64,
        referrer: Option<Pubkey>,
    ) -> Result<()> {
        require!(
            metadata.len() <= MAX_METADATA_LEN,
            MarketError::MetadataTooLong
        );

        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.authority.key();
        market.mint = ctx.accounts.mint.key();
        market.p1 = p1;
        market.p2 = p2;
        market.event_id = event_id;
        market.p1_deposit = 0;
        market.p2_deposit = 0;
        market.resolved = false;
        market.winning_outcome = None;
        market.created_at = Clock::get()?.unix_timestamp;
        market.expires_at = expires_at;
        market.referrer = referrer.unwrap_or_default();
        market.backer_pool_p1 = 0;
        market.backer_pool_p2 = 0;
        market.settled = false;
        market.bump = ctx.bumps.market;
        market.vault_bump = ctx.bumps.market_vault;

        emit!(MarketInitialized {
            event_id,
            authority: market.authority,
            p1,
            p2,
            mint: market.mint,
            metadata,
        });

        Ok(())
    }

    /// Permissionless resolve: anyone can settle a market whose referenced game
    /// program has recorded a definitive winner. No partner key required.
    ///
    /// Validation flow:
    ///   1. Market must not already be resolved (idempotency).
    ///   2. V2 must be initialized.
    ///   3. `game_state` account must be owned by a registered game program.
    ///   4. `game_state` layout must be V2-compliant (≥ 74 bytes).
    ///   5. `game_state` p1/p2 must match this market's p1/p2 (no cross-game hijack).
    ///   6. `game_state` status must be `finished` (2) and winner index valid.
    ///   7. Winner pubkey must match one of the market's declared players.
    ///
    /// Fee math (v2 defaults, configurable via upgrade_protocol_to_v2):
    ///   protocol_fee     = total × protocol_fee_bps     / 10000   (default 80 bps)
    ///   partner_fee      = total × partner_fee_bps      / 10000   (default 100 bps)
    ///   pool_backer_fee = total × pool_backer_fee_bps / 10000   (default 20 bps)
    ///   winner_payout    = total − (all three fees)
    pub fn resolve_market_from_game_pda(
        ctx: Context<ResolveMarketFromGamePda>,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let config_v2 = &ctx.accounts.protocol_config_v2;
        let registry = &ctx.accounts.partner_registry;
        let game_state_info = &ctx.accounts.game_state;
        let registry_v2 = &ctx.accounts.game_program_registry_v2;
        let binding = &ctx.accounts.market_game_binding;

        // (1) Idempotency — no double-resolve
        require!(!market.resolved, MarketError::MarketAlreadyResolved);

        // (2) V2 config must exist + PoolBacker sentinel must match
        require!(
            ctx.accounts.pool_backer.key() == config_v2.pool_backer,
            MarketError::InvalidPoolBacker
        );

        // (3) Binding must reference THIS market + THIS game_state + registered program
        require!(binding.market == market.key(), MarketError::BindingMarketMismatch);
        require!(
            binding.game_state == game_state_info.key(),
            MarketError::BindingGameStateMismatch
        );
        require!(
            binding.game_program == registry_v2.game_program,
            MarketError::BindingGameProgramMismatch
        );

        // (4) game_state account must be owned by the registered program
        require!(
            *game_state_info.owner == registry_v2.game_program,
            MarketError::UnregisteredGameProgram
        );

        // (5) read + validate account length against the registered adapter schema
        let adapter = registry_v2.adapter.clone();
        let data = game_state_info.try_borrow_data()?;
        require!(
            data.len() >= adapter.min_account_len as usize,
            MarketError::GameStateTooSmall
        );
        // Defense-in-depth: re-verify the adapter's offsets fit within the
        // runtime account length (not just the admin-declared min_account_len).
        let p1_end = (adapter.p1_offset as usize).saturating_add(32);
        let p2_end = (adapter.p2_offset as usize).saturating_add(32);
        require!(
            p1_end <= data.len()
                && p2_end <= data.len()
                && (adapter.status_offset as usize) < data.len()
                && (adapter.winner_offset as usize) < data.len(),
            MarketError::V2AdapterOffsetOverflow
        );

        // (6) p1/p2 match at the adapter-declared offsets
        let game_p1 = Pubkey::new_from_array(
            data[adapter.p1_offset as usize..p1_end]
                .try_into()
                .map_err(|_| error!(MarketError::GameStateTooSmall))?,
        );
        let game_p2 = Pubkey::new_from_array(
            data[adapter.p2_offset as usize..p2_end]
                .try_into()
                .map_err(|_| error!(MarketError::GameStateTooSmall))?,
        );
        require!(
            (game_p1 == market.p1 && game_p2 == market.p2)
                || (game_p1 == market.p2 && game_p2 == market.p1),
            MarketError::GamePlayerMismatch
        );

        // (7) status finished (per adapter's status_finished_value sentinel)
        let status_byte = data[adapter.status_offset as usize];
        require!(
            status_byte == adapter.status_finished_value,
            MarketError::GameNotFinished
        );
        let winner_byte = data[adapter.winner_offset as usize];

        // Map the game's winner byte (per adapter's win-encoding) to market outcome.
        // Adapter declares which byte value = p1_wins, p2_wins, draw.
        let winning_outcome = if winner_byte == adapter.winner_p1_value {
            if game_p1 == market.p1 { OUTCOME_P1_WINS } else { OUTCOME_P2_WINS }
        } else if winner_byte == adapter.winner_p2_value {
            if game_p2 == market.p2 { OUTCOME_P2_WINS } else { OUTCOME_P1_WINS }
        } else if winner_byte == adapter.winner_draw_value {
            OUTCOME_CANCELLED
        } else {
            return Err(MarketError::InvalidGameWinner.into());
        };

        drop(data); // release borrow before mutating market

        market.winning_outcome = if winning_outcome == OUTCOME_CANCELLED {
            None
        } else {
            Some(winning_outcome)
        };
        market.resolved = true;

        let market_key = market.key();
        let vault_seeds: &[&[u8]] = &[b"vault", market_key.as_ref(), &[market.vault_bump]];
        let signer_seeds = &[vault_seeds];

        let total_pot = ctx.accounts.market_vault.amount;

        // Draw case: no winner, split fees-free (full refund each side)
        if winning_outcome == OUTCOME_CANCELLED {
            if market.p1_deposit > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.market_vault.to_account_info(),
                            to: ctx.accounts.p1_token_account.to_account_info(),
                            authority: ctx.accounts.market_vault.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    market.p1_deposit,
                )?;
            }
            if market.p2_deposit > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.market_vault.to_account_info(),
                            to: ctx.accounts.p2_token_account.to_account_info(),
                            authority: ctx.accounts.market_vault.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    market.p2_deposit,
                )?;
            }
            market.settled = true;
            emit!(MarketResolvedV2 {
                market: market_key,
                game_program: ctx.accounts.game_program_registry_v2.game_program,
                game_state: game_state_info.key(),
                winning_outcome: OUTCOME_CANCELLED,
                total_pot,
                protocol_fee: 0,
                partner_fee: 0,
                pool_backer_fee: 0,
                winner_payout: 0,
                resolver: ctx.accounts.keeper.key(),
            });
            return Ok(());
        }

        // V2 fee math — three independent bps slices of the total pot.
        let protocol_fee = total_pot
            .checked_mul(config_v2.protocol_fee_bps as u64)
            .ok_or(MarketError::Overflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(MarketError::Overflow)?;
        let partner_fee = total_pot
            .checked_mul(config_v2.partner_fee_bps as u64)
            .ok_or(MarketError::Overflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(MarketError::Overflow)?;
        let pool_backer_fee = total_pot
            .checked_mul(config_v2.pool_backer_fee_bps as u64)
            .ok_or(MarketError::Overflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(MarketError::Overflow)?;

        let total_fees = protocol_fee
            .checked_add(partner_fee)
            .ok_or(MarketError::Overflow)?
            .checked_add(pool_backer_fee)
            .ok_or(MarketError::Overflow)?;
        let winner_payout = total_pot
            .checked_sub(total_fees)
            .ok_or(MarketError::Overflow)?;

        // Transfer protocol treasury
        if protocol_fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.market_vault.to_account_info(),
                        to: ctx.accounts.protocol_treasury.to_account_info(),
                        authority: ctx.accounts.market_vault.to_account_info(),
                    },
                    signer_seeds,
                ),
                protocol_fee,
            )?;
        }

        // Transfer partner
        if partner_fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.market_vault.to_account_info(),
                        to: ctx.accounts.partner_treasury.to_account_info(),
                        authority: ctx.accounts.market_vault.to_account_info(),
                    },
                    signer_seeds,
                ),
                partner_fee,
            )?;
        }

        // Transfer PoolBacker
        if pool_backer_fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.market_vault.to_account_info(),
                        to: ctx.accounts.pool_backer_treasury.to_account_info(),
                        authority: ctx.accounts.market_vault.to_account_info(),
                    },
                    signer_seeds,
                ),
                pool_backer_fee,
            )?;
        }

        // Transfer payout to winner
        if winner_payout > 0 {
            let winner_account = if winning_outcome == OUTCOME_P1_WINS {
                ctx.accounts.p1_token_account.to_account_info()
            } else {
                ctx.accounts.p2_token_account.to_account_info()
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.market_vault.to_account_info(),
                        to: winner_account,
                        authority: ctx.accounts.market_vault.to_account_info(),
                    },
                    signer_seeds,
                ),
                winner_payout,
            )?;
        }

        market.settled = true;

        // v1 event for index compatibility
        emit!(MarketResolved {
            market: market_key,
            winner: winning_outcome,
            total_pot,
        });
        // v2 event with full fee breakdown
        emit!(MarketResolvedV2 {
            market: market_key,
            game_program: ctx.accounts.game_program_registry_v2.game_program,
            game_state: game_state_info.key(),
            winning_outcome,
            total_pot,
            protocol_fee,
            partner_fee,
            pool_backer_fee,
            winner_payout,
            resolver: ctx.accounts.keeper.key(),
        });

        // Silence unused-variable warning for registry (read via Anchor constraint only).
        let _ = registry;

        Ok(())
    }

    /// Permissionless close: anyone can reclaim rent from a fully-settled market
    /// after the V2_CLOSE_COOLDOWN_SECONDS (48hr) window since creation. Rent
    /// is always returned to the original creator (market.authority) — never
    /// the caller — to prevent grief-close economics.
    pub fn close_market_permissionless(
        ctx: Context<CloseMarketPermissionless>,
    ) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(market.resolved, MarketError::MarketNotResolved);
        require!(market.settled, MarketError::MarketNotSettled);

        let clock = Clock::get()?;
        let cooldown_end = market
            .created_at
            .saturating_add(V2_CLOSE_COOLDOWN_SECONDS);
        require!(
            clock.unix_timestamp > cooldown_end,
            MarketError::CloseCooldownActive
        );

        let market_key = market.key();
        let vault_seeds: &[&[u8]] = &[b"vault", market_key.as_ref(), &[market.vault_bump]];
        let signer_seeds = &[vault_seeds];

        // Close vault — rent goes to original creator
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.market_vault.to_account_info(),
                destination: ctx.accounts.authority.to_account_info(),
                authority: ctx.accounts.market_vault.to_account_info(),
            },
            signer_seeds,
        ))?;

        emit!(MarketClosedPermissionlessly {
            market: market_key,
            authority: market.authority,
            caller: ctx.accounts.caller.key(),
        });

        // Market account rent also goes to `authority` via Anchor `close = authority` constraint.
        Ok(())
    }

    // Admin timelock — propose/execute/cancel for highest-risk fee changes.

    /// Admin queues a timelocked action.
    pub fn propose_admin_action(
        ctx: Context<ProposeAdminAction>,
        deadline: i64,
        action: TimelockedAction,
    ) -> Result<()> {
        check_deadline(deadline)?;
        let proposal = &mut ctx.accounts.timelock_proposal;
        proposal.admin = ctx.accounts.admin.key();
        proposal.proposed_at = Clock::get()?.unix_timestamp;
        proposal.action = action.clone();
        proposal.bump = ctx.bumps.timelock_proposal;
        emit!(AdminActionProposed {
            admin: proposal.admin,
            proposed_at: proposal.proposed_at,
            executable_at: proposal.proposed_at + ADMIN_TIMELOCK_SECONDS,
        });
        Ok(())
    }

    /// Permissionless execution after 48h timelock; rent refunds to admin.
    pub fn execute_admin_action(ctx: Context<ExecuteAdminAction>) -> Result<()> {
        let proposal = &ctx.accounts.timelock_proposal;
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= proposal.proposed_at + ADMIN_TIMELOCK_SECONDS,
            MarketError::TimelockNotElapsed
        );

        match proposal.action.clone() {
            TimelockedAction::UpdateProtocolConfigV2 {
                new_pool_backer,
                new_protocol_fee_bps,
                new_partner_fee_bps,
                new_pool_backer_fee_bps,
            } => {
                let v2 = &mut ctx.accounts.protocol_config_v2;
                if let Some(ps) = new_pool_backer {
                    v2.pool_backer = ps;
                }
                if let Some(bps) = new_protocol_fee_bps {
                    require!(bps <= V2_MAX_COMPONENT_FEE_BPS, MarketError::V2FeeTooHigh);
                    v2.protocol_fee_bps = bps;
                }
                if let Some(bps) = new_partner_fee_bps {
                    require!(bps <= V2_MAX_COMPONENT_FEE_BPS, MarketError::V2FeeTooHigh);
                    v2.partner_fee_bps = bps;
                }
                if let Some(bps) = new_pool_backer_fee_bps {
                    require!(bps <= V2_MAX_COMPONENT_FEE_BPS, MarketError::V2FeeTooHigh);
                    v2.pool_backer_fee_bps = bps;
                }
            }
        }

        emit!(AdminActionExecuted {
            admin: proposal.admin,
            executor: ctx.accounts.executor.key(),
        });
        Ok(())
    }

    /// Admin cancels a queued proposal; rent refunds.
    pub fn cancel_admin_action(_ctx: Context<CancelAdminAction>) -> Result<()> {
        Ok(())
    }

    /// Close a fully settled market and reclaim rent.
    /// Vault token account is closed (rent to authority).
    /// Market account is closed via Anchor `close` constraint.
    pub fn close_market(ctx: Context<CloseMarket>) -> Result<()> {
        let market = &ctx.accounts.market;
        let market_key = market.key();

        let vault_seeds: &[&[u8]] = &[b"vault", market_key.as_ref(), &[market.vault_bump]];
        let signer_seeds = &[vault_seeds];

        // Close the vault token account, return rent to authority
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.market_vault.to_account_info(),
                destination: ctx.accounts.authority.to_account_info(),
                authority: ctx.accounts.market_vault.to_account_info(),
            },
            signer_seeds,
        ))?;

        // Market account rent reclaimed via `close = authority` on the account constraint.
        Ok(())
    }
}

// ============================================================================
// Account Contexts
// ============================================================================

// --- Protocol Admin ---

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = admin,
        space = ProtocolConfig::SPACE,
        seeds = [b"protocol_config"],
        bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateProtocolConfig<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        has_one = admin @ MarketError::Unauthorized,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    pub admin: Signer<'info>,
}

// --- Partner Management ---

#[derive(Accounts)]
pub struct RegisterPartner<'info> {
    #[account(
        init,
        payer = admin,
        space = PartnerRegistry::SPACE,
        seeds = [b"partner_registry", partner_program.key().as_ref()],
        bump,
    )]
    pub partner_registry: Account<'info, PartnerRegistry>,
    /// CHECK: The partner's signing authority keypair being registered.
    pub partner_program: UncheckedAccount<'info>,
    /// The partner's treasury wallet. Validated as a real token account.
    pub partner_treasury: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = admin.key() == protocol_config.admin @ MarketError::Unauthorized,
    )]
    pub admin: Signer<'info>,
    #[account(seeds = [b"protocol_config"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePartnerTreasury<'info> {
    #[account(
        mut,
        seeds = [b"partner_registry", registry.partner_program_id.as_ref()],
        bump = registry.bump,
        has_one = verified_treasury @ MarketError::InvalidPartnerTreasury,
    )]
    pub registry: Account<'info, PartnerRegistry>,
    /// Current treasury wallet must sign to authorize the change.
    pub verified_treasury: Signer<'info>,
    /// New treasury token account.
    pub new_treasury: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct SetPartnerActive<'info> {
    #[account(
        mut,
        seeds = [b"partner_registry", partner_registry.partner_program_id.as_ref()],
        bump = partner_registry.bump,
    )]
    pub partner_registry: Account<'info, PartnerRegistry>,
    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        has_one = admin @ MarketError::Unauthorized,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    pub admin: Signer<'info>,
}

// --- Market Lifecycle ---

#[derive(Accounts)]
#[instruction(event_id: u64)]
pub struct InitializeMarket<'info> {
    #[account(
        init,
        payer = authority,
        space = MarketState::SPACE,
        seeds = [b"market", event_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub market: Account<'info, MarketState>,

    #[account(
        init,
        payer = authority,
        token::mint = mint,
        token::authority = market_vault,
        seeds = [b"vault", market.key().as_ref()],
        bump,
    )]
    pub market_vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [b"partner_registry", authority.key().as_ref()],
        bump = partner_registry.bump,
        constraint = partner_registry.is_active @ MarketError::PartnerInactive,
        constraint = partner_registry.partner_program_id == authority.key() @ MarketError::UnauthorizedPartner,
    )]
    pub partner_registry: Account<'info, PartnerRegistry>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        constraint = !market.resolved @ MarketError::MarketAlreadyResolved,
    )]
    pub market: Account<'info, MarketState>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
        constraint = market_vault.mint == market.mint @ MarketError::MintMismatch,
    )]
    pub market_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_account.mint == market.mint @ MarketError::MintMismatch,
        constraint = user_token_account.owner == user.key() @ MarketError::TokenOwnerMismatch,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        constraint = user.key() == market.p1 || user.key() == market.p2 @ MarketError::UnauthorizedPlayer,
    )]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    #[account(
        mut,
        has_one = authority @ MarketError::UnauthorizedPartner,
    )]
    pub market: Box<Account<'info, MarketState>>,

    pub authority: Signer<'info>,

    #[account(
        seeds = [b"partner_registry", authority.key().as_ref()],
        bump = partner_registry.bump,
        constraint = partner_registry.is_active @ MarketError::PartnerInactive,
    )]
    pub partner_registry: Box<Account<'info, PartnerRegistry>>,

    #[account(seeds = [b"protocol_config"], bump = protocol_config.bump)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// P1's token account to receive winnings or refund.
    #[account(
        mut,
        constraint = p1_token_account.mint == market.mint @ MarketError::MintMismatch,
        constraint = p1_token_account.owner == market.p1 @ MarketError::TokenOwnerMismatch,
    )]
    pub p1_token_account: Box<Account<'info, TokenAccount>>,

    /// P2's token account to receive winnings or refund.
    #[account(
        mut,
        constraint = p2_token_account.mint == market.mint @ MarketError::MintMismatch,
        constraint = p2_token_account.owner == market.p2 @ MarketError::TokenOwnerMismatch,
    )]
    pub p2_token_account: Box<Account<'info, TokenAccount>>,

    /// Partner's treasury token account for fee share.
    #[account(
        mut,
        constraint = partner_treasury.key() == partner_registry.verified_treasury @ MarketError::InvalidPartnerTreasury,
    )]
    pub partner_treasury: Box<Account<'info, TokenAccount>>,

    /// Protocol treasury token account for contention's fee share.
    #[account(
        mut,
        constraint = protocol_treasury.mint == market.mint @ MarketError::MintMismatch,
        constraint = protocol_treasury.key() == protocol_config.treasury @ MarketError::InvalidProtocolTreasury,
    )]
    pub protocol_treasury: Box<Account<'info, TokenAccount>>,

    /// Referrer's token account for referral fee. Optional — if no referrer, pass protocol_treasury as placeholder.
    #[account(
        mut,
        constraint = referrer_token_account.mint == market.mint @ MarketError::MintMismatch,
    )]
    pub referrer_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExpireMarket<'info> {
    #[account(
        mut,
        constraint = !market.resolved @ MarketError::MarketAlreadyResolved,
        constraint = market.expires_at > 0 @ MarketError::NoExpiry,
    )]
    pub market: Account<'info, MarketState>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub market_vault: Account<'info, TokenAccount>,

    /// P1's token account for refund.
    #[account(
        mut,
        constraint = p1_token_account.mint == market.mint @ MarketError::MintMismatch,
        constraint = p1_token_account.owner == market.p1 @ MarketError::TokenOwnerMismatch,
    )]
    pub p1_token_account: Account<'info, TokenAccount>,

    /// P2's token account for refund.
    #[account(
        mut,
        constraint = p2_token_account.mint == market.mint @ MarketError::MintMismatch,
        constraint = p2_token_account.owner == market.p2 @ MarketError::TokenOwnerMismatch,
    )]
    pub p2_token_account: Account<'info, TokenAccount>,

    /// Permissionless: anyone can trigger expiry.
    pub caller: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// --- Skill-contest pari-mutuel ---

#[derive(Accounts)]
#[instruction(outcome: u8)]
pub struct BackContestant<'info> {
    #[account(
        mut,
        constraint = !market.resolved @ MarketError::MarketAlreadyResolved,
    )]
    pub market: Box<Account<'info, MarketState>>,

    #[account(
        init_if_needed,
        payer = backer,
        space = BackerStake::SPACE,
        seeds = [b"backer_stake", market.key().as_ref(), backer.key().as_ref()],
        bump,
    )]
    pub bet: Account<'info, BackerStake>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = backer_token_account.mint == market.mint @ MarketError::MintMismatch,
        constraint = backer_token_account.owner == backer.key() @ MarketError::TokenOwnerMismatch,
    )]
    pub backer_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub backer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimBackerWinnings<'info> {
    #[account(
        constraint = market.resolved @ MarketError::MarketNotResolved,
    )]
    pub market: Box<Account<'info, MarketState>>,

    #[account(seeds = [b"protocol_config"], bump = protocol_config.bump)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        seeds = [b"backer_stake", market.key().as_ref(), backer.key().as_ref()],
        bump,
        constraint = bet.backer == backer.key() @ MarketError::UnauthorizedPlayer,
        constraint = !bet.claimed @ MarketError::AlreadyClaimed,
    )]
    pub bet: Account<'info, BackerStake>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = backer_token_account.mint == market.mint @ MarketError::MintMismatch,
        constraint = backer_token_account.owner == backer.key() @ MarketError::TokenOwnerMismatch,
    )]
    pub backer_token_account: Account<'info, TokenAccount>,

    pub backer: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// --- V2 Account Contexts ---

#[derive(Accounts)]
pub struct InitializeProtocolV2<'info> {
    #[account(
        init,
        payer = admin,
        space = ProtocolConfigV2::SPACE,
        seeds = [b"protocol_config_v2"],
        bump,
    )]
    pub protocol_config_v2: Account<'info, ProtocolConfigV2>,

    /// Admin authority (validated against v1 ProtocolConfig).
    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        has_one = admin @ MarketError::Unauthorized,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateProtocolConfigV2<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config_v2"],
        bump = protocol_config_v2.bump,
    )]
    pub protocol_config_v2: Account<'info, ProtocolConfigV2>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        has_one = admin @ MarketError::Unauthorized,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(label: String)]
pub struct RegisterGameProgram<'info> {
    #[account(
        init,
        payer = admin,
        space = GameProgramRegistry::SPACE,
        seeds = [b"game_program_registry", game_program.key().as_ref()],
        bump,
    )]
    pub game_program_registry: Account<'info, GameProgramRegistry>,

    /// CHECK: Game program's executable address. Admin vouches for it.
    pub game_program: UncheckedAccount<'info>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        has_one = admin @ MarketError::Unauthorized,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(label: String, adapter: GameAdapterSchema)]
pub struct RegisterGameProgramV2<'info> {
    #[account(
        init,
        payer = admin,
        space = GameProgramRegistryV2::SPACE,
        seeds = [b"game_program_registry_v2", game_program.key().as_ref()],
        bump,
    )]
    pub game_program_registry_v2: Account<'info, GameProgramRegistryV2>,

    /// CHECK: Game program's executable address. Admin vouches for it.
    pub game_program: UncheckedAccount<'info>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        has_one = admin @ MarketError::Unauthorized,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BindMarketToGame<'info> {
    /// The market being bound. Authority must sign to prove they created it.
    #[account(
        has_one = authority @ MarketError::Unauthorized,
    )]
    pub market: Box<Account<'info, MarketState>>,

    /// V2.1 registry entry for the game program whose state will resolve this market.
    #[account(
        seeds = [b"game_program_registry_v2", game_program_registry_v2.game_program.as_ref()],
        bump = game_program_registry_v2.bump,
        constraint = game_program_registry_v2.is_active @ MarketError::UnregisteredGameProgram,
    )]
    pub game_program_registry_v2: Box<Account<'info, GameProgramRegistryV2>>,

    /// The binding PDA (new). Created once per market.
    #[account(
        init,
        payer = payer,
        space = MarketGameBinding::SPACE,
        seeds = [b"market_binding", market.key().as_ref()],
        bump,
    )]
    pub binding: Account<'info, MarketGameBinding>,

    /// Market's partner authority — must sign to prove ownership of the market.
    /// Can be a PDA (via CPI invoke_signed). Not mutable because rent payment
    /// is delegated to `payer`.
    pub authority: Signer<'info>,

    /// Rent payer — must be a regular wallet (or system-owned empty PDA).
    /// Split from `authority` so PDAs with data can still authorize binds.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(event_id: u64)]
pub struct InitializeMarketV21<'info> {
    #[account(
        init,
        payer = payer,
        space = MarketState::SPACE,
        seeds = [b"market", event_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub market: Account<'info, MarketState>,

    #[account(
        init,
        payer = payer,
        token::mint = mint,
        token::authority = market_vault,
        seeds = [b"vault", market.key().as_ref()],
        bump,
    )]
    pub market_vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [b"partner_registry", authority.key().as_ref()],
        bump = partner_registry.bump,
        constraint = partner_registry.is_active @ MarketError::PartnerInactive,
        constraint = partner_registry.partner_program_id == authority.key() @ MarketError::UnauthorizedPartner,
    )]
    pub partner_registry: Account<'info, PartnerRegistry>,

    /// Partner authority — signs to prove partnership. Can be a PDA via invoke_signed.
    /// Not mutable — rent payment is delegated to `payer`.
    pub authority: Signer<'info>,

    /// Rent payer — must be a regular wallet. Funds market + vault rent.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ResolveMarketFromGamePda<'info> {
    #[account(mut)]
    pub market: Box<Account<'info, MarketState>>,

    #[account(
        seeds = [b"partner_registry", market.authority.as_ref()],
        bump = partner_registry.bump,
        constraint = partner_registry.is_active @ MarketError::PartnerInactive,
    )]
    pub partner_registry: Box<Account<'info, PartnerRegistry>>,

    /// V1 ProtocolConfig — we only read `treasury` from here.
    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// V2 ProtocolConfig — fee bps + PoolBacker live here.
    #[account(
        seeds = [b"protocol_config_v2"],
        bump = protocol_config_v2.bump,
    )]
    pub protocol_config_v2: Box<Account<'info, ProtocolConfigV2>>,

    /// V2.1 registry with per-game adapter schema (replaces V2.0 fixed offsets).
    #[account(
        seeds = [b"game_program_registry_v2", game_program_registry_v2.game_program.as_ref()],
        bump = game_program_registry_v2.bump,
        constraint = game_program_registry_v2.is_active @ MarketError::UnregisteredGameProgram,
    )]
    pub game_program_registry_v2: Box<Account<'info, GameProgramRegistryV2>>,

    /// Cryptographic binding market ↔ game_state. Created by `bind_market_to_game`
    /// atomically with (or immediately after) market init. Prevents an attacker
    /// from pointing resolve at a different finished game with matching p1/p2.
    #[account(
        seeds = [b"market_binding", market.key().as_ref()],
        bump = market_game_binding.bump,
    )]
    pub market_game_binding: Box<Account<'info, MarketGameBinding>>,

    /// The game program's state account. Owner + layout validated in handler
    /// against the adapter schema declared in the registry.
    /// CHECK: Validated in handler (owner == registry_v2.game_program,
    /// account length ≥ adapter.min_account_len, binding.game_state match).
    pub game_state: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = p1_token_account.mint == market.mint @ MarketError::MintMismatch,
        constraint = p1_token_account.owner == market.p1 @ MarketError::TokenOwnerMismatch,
    )]
    pub p1_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = p2_token_account.mint == market.mint @ MarketError::MintMismatch,
        constraint = p2_token_account.owner == market.p2 @ MarketError::TokenOwnerMismatch,
    )]
    pub p2_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = partner_treasury.key() == partner_registry.verified_treasury @ MarketError::InvalidPartnerTreasury,
    )]
    pub partner_treasury: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = protocol_treasury.mint == market.mint @ MarketError::MintMismatch,
        constraint = protocol_treasury.key() == protocol_config.treasury @ MarketError::InvalidProtocolTreasury,
    )]
    pub protocol_treasury: Box<Account<'info, TokenAccount>>,

    /// PoolBacker's sentinel (checked against `config.pool_backer`).
    /// CHECK: validated in handler against protocol_config.pool_backer.
    pub pool_backer: UncheckedAccount<'info>,

    /// PoolBacker's token account (receives the 0.20% slice).
    #[account(
        mut,
        constraint = pool_backer_treasury.mint == market.mint @ MarketError::MintMismatch,
    )]
    pub pool_backer_treasury: Box<Account<'info, TokenAccount>>,

    /// Keeper who invokes permissionless resolve. Not paid by protocol;
    /// pays their own tx fee. Any wallet works.
    pub keeper: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseMarketPermissionless<'info> {
    #[account(
        mut,
        close = authority,
        has_one = authority @ MarketError::UnauthorizedPartner,
        constraint = market.resolved @ MarketError::MarketNotResolved,
        constraint = market.settled @ MarketError::MarketNotSettled,
    )]
    pub market: Account<'info, MarketState>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
        constraint = market_vault.amount == 0 @ MarketError::VaultNotEmpty,
    )]
    pub market_vault: Account<'info, TokenAccount>,

    /// Original creator — receives all rent regardless of who calls this.
    /// CHECK: constraint ensures this matches market.authority.
    #[account(mut)]
    pub authority: UncheckedAccount<'info>,

    /// Whoever triggers the close. Pays the tx fee, receives nothing.
    pub caller: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseMarket<'info> {
    #[account(
        mut,
        close = authority,
        has_one = authority @ MarketError::UnauthorizedPartner,
        constraint = market.resolved @ MarketError::MarketNotResolved,
        constraint = market.settled @ MarketError::MarketNotSettled,
    )]
    pub market: Account<'info, MarketState>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
        constraint = market_vault.amount == 0 @ MarketError::VaultNotEmpty,
    )]
    pub market_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// --- MagicBlock Delegation ---

#[derive(Accounts)]
pub struct Delegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, has_one = authority @ MarketError::UnauthorizedPartner)]
    pub pda: Account<'info, MarketState>,
    /// The market's authority (partner) must sign delegation.
    pub authority: Signer<'info>,
    /// CHECK: Delegation program owner account.
    pub owner: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Undelegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub pda: Account<'info, MarketState>,
    pub system_program: Program<'info, System>,
}

// ============================================================================
// Account State
// ============================================================================

/// Global protocol configuration (v1). Singleton PDA: ["protocol_config"].
/// Preserved as-is so the already-deployed devnet account continues to deserialize.
#[account]
pub struct ProtocolConfig {
    /// Admin wallet that can register partners and update config.
    pub admin: Pubkey,
    /// Treasury wallet address that receives contention's fee share.
    pub treasury: Pubkey,
    /// Protocol fee in basis points (v1 meaning: total rake split between partner+contention).
    pub protocol_fee_bps: u16,
    pub bump: u8,
}

impl ProtocolConfig {
    pub const SPACE: usize = 8 + 32 + 32 + 2 + 1; // 75
}

/// V2 protocol configuration — SEPARATE PDA. Singleton: ["protocol_config_v2"].
/// Kept distinct from the v1 ProtocolConfig PDA to avoid touching the
/// already-deployed account's layout.
#[account]
pub struct ProtocolConfigV2 {
    /// PoolBacker account whose treasury token account receives the 0.20% slice.
    pub pool_backer: Pubkey,
    /// Protocol treasury slice (default 80 bps = 0.80%).
    pub protocol_fee_bps: u16,
    /// Partner (creator) slice (default 100 bps = 1.00%). Absolute, not relative.
    pub partner_fee_bps: u16,
    /// PoolBacker slice (default 20 bps = 0.20%).
    pub pool_backer_fee_bps: u16,
    pub bump: u8,
}

impl ProtocolConfigV2 {
    pub const SPACE: usize = 8 + 32 + 2 + 2 + 2 + 1; // 47
}

/// Registered partner. PDA: ["partner_registry", partner_program_id].
#[account]
pub struct PartnerRegistry {
    /// The partner's signing authority keypair public key.
    pub partner_program_id: Pubkey,
    /// The partner's treasury token account address for receiving fee share.
    pub verified_treasury: Pubkey,
    /// Partner's share of the protocol fee, in basis points.
    /// E.g., 5000 = 50% of protocol fee goes to partner.
    pub fee_share_bps: u16,
    pub is_active: bool,
    pub bump: u8,
}

impl PartnerRegistry {
    pub const SPACE: usize = 8 + 32 + 32 + 2 + 1 + 1; // 76
}

/// 1v1 market state. PDA: ["market", event_id (u64 LE)].
#[account]
pub struct MarketState {
    /// Partner authority that controls this market.
    pub authority: Pubkey,
    /// Collateral token mint (e.g., USDC).
    pub mint: Pubkey,
    /// Player 1 wallet.
    pub p1: Pubkey,
    /// Player 2 wallet.
    pub p2: Pubkey,
    /// Unique event identifier.
    pub event_id: u64,
    /// Amount P1 has deposited.
    pub p1_deposit: u64,
    /// Amount P2 has deposited.
    pub p2_deposit: u64,
    /// Whether the market has been resolved.
    pub resolved: bool,
    /// Winning outcome: Some(0)=P1, Some(1)=P2, None=cancelled/void.
    pub winning_outcome: Option<u8>,
    /// Unix timestamp of market creation.
    pub created_at: i64,
    /// Unix timestamp after which anyone can expire the market. 0 = no expiry.
    pub expires_at: i64,
    /// Referrer wallet that shared the challenge link. Earns 20% of protocol fee.
    pub referrer: Pubkey,
    /// Backer pool: total staked on P1.
    pub backer_pool_p1: u64,
    /// Backer pool: total staked on P2.
    pub backer_pool_p2: u64,
    /// Whether all funds have been distributed from the vault.
    pub settled: bool,
    /// Market PDA bump seed.
    pub bump: u8,
    /// Vault PDA bump seed.
    pub vault_bump: u8,
}

impl MarketState {
    pub const SPACE: usize = 8 // discriminator
        + 32  // authority
        + 32  // mint
        + 32  // p1
        + 32  // p2
        + 8   // event_id
        + 8   // p1_deposit
        + 8   // p2_deposit
        + 1   // resolved
        + 2   // winning_outcome (Option<u8>)
        + 8   // created_at
        + 8   // expires_at
        + 32  // referrer
        + 8   // backer_pool_p1
        + 8   // backer_pool_p2
        + 1   // settled
        + 1   // bump
        + 1;  // vault_bump  = 230
}

/// Per-user stake on a contestant. PDA: ["backer_stake", market, backer].
#[account]
pub struct BackerStake {
    pub market: Pubkey,
    pub backer: Pubkey,
    pub outcome: u8,     // 0 = P1, 1 = P2
    pub amount: u64,
    pub claimed: bool,
}

impl BackerStake {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 8 + 1; // 82
}

/// V2 game program allowlist. PDA: ["game_program_registry", game_program_id].
/// Admin-gated via `register_game_program`. Enables `resolve_market_from_game_pda`.
#[account]
pub struct GameProgramRegistry {
    pub game_program: Pubkey,
    pub label: [u8; 32],   // short human label, e.g. "chess", "blockwords", "pla"
    pub is_active: bool,
    pub bump: u8,
}

impl GameProgramRegistry {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 1; // 74
}

/// Per-game layout schema. Declared at v2.1 registration so `resolve_market_from_game_pda`
/// can read ANY registered game's state without hardcoding offsets. Safety-checked
/// at register-time (offsets in range, pubkey slots don't overlap, winner values distinct).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct GameAdapterSchema {
    /// Byte offset of p1/white Pubkey in the game's state account.
    pub p1_offset: u16,
    /// Byte offset of p2/black Pubkey.
    pub p2_offset: u16,
    /// Byte offset of the status byte.
    pub status_offset: u16,
    /// Value of the status byte that indicates "game is finished".
    pub status_finished_value: u8,
    /// Byte offset of the winner byte.
    pub winner_offset: u16,
    /// Winner byte value meaning "p1/white wins".
    pub winner_p1_value: u8,
    /// Winner byte value meaning "p2/black wins".
    pub winner_p2_value: u8,
    /// Winner byte value meaning "draw / cancelled".
    pub winner_draw_value: u8,
    /// Minimum account length for the game state (declared by admin, re-checked at resolve).
    pub min_account_len: u16,
}

impl GameAdapterSchema {
    /// Borsh serialized size: 5×u16 + 4×u8 = 14 bytes.
    pub const SIZE: usize = 2 + 2 + 2 + 1 + 2 + 1 + 1 + 1 + 2;
}

/// V2.1 game program registry with adapter schema. PDA: ["game_program_registry_v2", game_program].
/// Replaces the V2.0 fixed-offset registry for new registrations.
#[account]
pub struct GameProgramRegistryV2 {
    pub game_program: Pubkey,
    pub label: [u8; 32],
    pub is_active: bool,
    pub bump: u8,
    pub adapter: GameAdapterSchema,
}

impl GameProgramRegistryV2 {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 1 + GameAdapterSchema::SIZE; // 88
}

/// Cryptographic binding market ↔ game_state. PDA: ["market_binding", market].
/// Created once per market immediately after `initialize_market`. Prevents the
/// permissionless resolver being pointed at an unrelated finished game.
#[account]
pub struct MarketGameBinding {
    pub market: Pubkey,
    pub game_program: Pubkey,
    pub game_state: Pubkey,
    pub bump: u8,
}

impl MarketGameBinding {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 1; // 105
}

// ============================================================================
// Events
// ============================================================================

#[event]
pub struct MarketInitialized {
    pub event_id: u64,
    pub authority: Pubkey,
    pub p1: Pubkey,
    pub p2: Pubkey,
    pub mint: Pubkey,
    pub metadata: String,
}

#[event]
pub struct DepositMade {
    pub market: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct MarketResolved {
    pub market: Pubkey,
    pub winner: u8,
    pub total_pot: u64,
}

#[event]
pub struct MarketExpired {
    pub market: Pubkey,
}

// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum MarketError {
    #[msg("Market is already resolved.")]
    MarketAlreadyResolved,
    #[msg("Invalid outcome index. Must be 0 (P1), 1 (P2), or 255 (Cancel).")]
    InvalidOutcome,
    #[msg("Partner is not active in the registry.")]
    PartnerInactive,
    #[msg("Partner treasury does not match registry.")]
    InvalidPartnerTreasury,
    #[msg("Protocol treasury does not match config.")]
    InvalidProtocolTreasury,
    #[msg("Market has not been resolved yet.")]
    MarketNotResolved,
    #[msg("Market has not been fully settled yet.")]
    MarketNotSettled,
    #[msg("Signer is not the authorized partner for this market.")]
    UnauthorizedPartner,
    #[msg("Signer is not the protocol admin.")]
    Unauthorized,
    #[msg("Signer is not P1 or P2 for this market.")]
    UnauthorizedPlayer,
    #[msg("Metadata exceeds maximum length of 512 bytes.")]
    MetadataTooLong,
    #[msg("P1 and P2 must be different wallets.")]
    DuplicatePlayers,
    #[msg("Expiry timestamp must be in the future.")]
    ExpiryInPast,
    #[msg("Market has no expiry set.")]
    NoExpiry,
    #[msg("Market has not expired yet.")]
    NotExpired,
    #[msg("Vault still contains tokens.")]
    VaultNotEmpty,
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Arithmetic overflow.")]
    Overflow,
    #[msg("Fee exceeds maximum allowed.")]
    FeeTooHigh,
    #[msg("Token mint does not match market collateral.")]
    MintMismatch,
    #[msg("Token account owner does not match expected wallet.")]
    TokenOwnerMismatch,
    #[msg("Backer winnings already claimed.")]
    AlreadyClaimed,

    // --- V2 errors ---
    #[msg("V2 protocol upgrade has not been performed. Call upgrade_protocol_to_v2.")]
    V2NotInitialized,
    #[msg("V2 protocol has already been initialized.")]
    V2AlreadyInitialized,
    #[msg("Game state account is too small to be a valid v2 game.")]
    GameStateTooSmall,
    #[msg("Game program is not registered. Admin must add it via register_game_program.")]
    UnregisteredGameProgram,
    #[msg("Game has not reached finished status yet.")]
    GameNotFinished,
    #[msg("Game winner index is invalid (not 0 for P1, 1 for P2, or 255 for draw).")]
    InvalidGameWinner,
    #[msg("Winner from game state does not match either player in this market.")]
    WinnerNotInMarket,
    #[msg("Game state p1/p2 do not match this market's p1/p2.")]
    GamePlayerMismatch,
    #[msg("PoolBacker account does not match the one registered in protocol config.")]
    InvalidPoolBacker,
    #[msg("Market cannot be closed yet — 48-hour cooldown after creation still active.")]
    CloseCooldownActive,
    #[msg("Fee bps exceeds the v2 component ceiling (500 bps = 5%).")]
    V2FeeTooHigh,
    // --- V2.1 adapter-schema errors ---
    #[msg("Adapter offset exceeds the safety cap (16KB).")]
    V2AdapterOffsetTooLarge,
    #[msg("Adapter offset points outside the declared min_account_len.")]
    V2AdapterOffsetOverflow,
    #[msg("Adapter p1/p2 pubkey slots overlap in the game state layout.")]
    V2AdapterOffsetOverlap,
    #[msg("Adapter winner_p1/p2/draw values must all be distinct.")]
    V2AdapterWinnerValuesCollide,
    #[msg("MarketGameBinding references a different market than the one being resolved.")]
    BindingMarketMismatch,
    #[msg("MarketGameBinding references a different game_state than the one provided.")]
    BindingGameStateMismatch,
    #[msg("MarketGameBinding references a different game_program than the registered one.")]
    BindingGameProgramMismatch,
    #[msg("Admin tx deadline has already passed (replay defense).")]
    DeadlineExceeded,
    #[msg("Admin tx deadline is more than 7 days in the future (replay defense).")]
    DeadlineTooFar,
    #[msg("No timelock proposal queued.")]
    NoTimelockProposal,
    #[msg("Timelock period has not elapsed yet.")]
    TimelockNotElapsed,
    #[msg("A timelock proposal is already queued; cancel it first.")]
    TimelockAlreadyQueued,
}

// ============================================================================
// Timelock state + actions
// ============================================================================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum TimelockedAction {
    UpdateProtocolConfigV2 {
        new_pool_backer: Option<Pubkey>,
        new_protocol_fee_bps: Option<u16>,
        new_partner_fee_bps: Option<u16>,
        new_pool_backer_fee_bps: Option<u16>,
    },
}

/// Singleton PDA: [b"timelock_proposal"].
#[account]
pub struct TimelockProposal {
    pub admin: Pubkey,
    pub proposed_at: i64,
    pub action: TimelockedAction,
    pub bump: u8,
}

impl TimelockProposal {
    // 8 disc + 32 admin + 8 proposed_at + ~80 action (max variant) + 1 bump
    pub const SPACE: usize = 8 + 32 + 8 + 96 + 1;
}

#[derive(Accounts)]
pub struct ProposeAdminAction<'info> {
    #[account(
        init,
        payer = admin,
        space = TimelockProposal::SPACE,
        seeds = [b"timelock_proposal"],
        bump,
    )]
    pub timelock_proposal: Account<'info, TimelockProposal>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        has_one = admin @ MarketError::Unauthorized,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteAdminAction<'info> {
    #[account(
        mut,
        close = admin,
        seeds = [b"timelock_proposal"],
        bump = timelock_proposal.bump,
    )]
    pub timelock_proposal: Account<'info, TimelockProposal>,

    #[account(
        mut,
        seeds = [b"protocol_config_v2"],
        bump = protocol_config_v2.bump,
    )]
    pub protocol_config_v2: Account<'info, ProtocolConfigV2>,

    /// Original admin who proposed — receives rent refund via `close = admin`.
    /// CHECK: matches proposal.admin via constraint.
    #[account(
        mut,
        constraint = admin.key() == timelock_proposal.admin @ MarketError::Unauthorized,
    )]
    pub admin: UncheckedAccount<'info>,

    /// Anyone can crank execution after the timelock elapses.
    pub executor: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelAdminAction<'info> {
    #[account(
        mut,
        close = admin,
        seeds = [b"timelock_proposal"],
        bump = timelock_proposal.bump,
        constraint = admin.key() == timelock_proposal.admin @ MarketError::Unauthorized,
    )]
    pub timelock_proposal: Account<'info, TimelockProposal>,

    #[account(mut)]
    pub admin: Signer<'info>,
}

#[event]
pub struct AdminActionProposed {
    pub admin: Pubkey,
    pub proposed_at: i64,
    pub executable_at: i64,
}

#[event]
pub struct AdminActionExecuted {
    pub admin: Pubkey,
    pub executor: Pubkey,
}

// ============================================================================
// Backer Events
// ============================================================================

#[event]
pub struct ContestantBacked {
    pub market: Pubkey,
    pub backer: Pubkey,
    pub outcome: u8,
    pub amount: u64,
    pub total_p1: u64,
    pub total_p2: u64,
}

#[event]
pub struct BackerWinningsClaimed {
    pub market: Pubkey,
    pub backer: Pubkey,
    pub payout: u64,
    pub outcome: u8,
}

// --- V2 Events ---

#[event]
pub struct ProtocolUpgradedToV2 {
    pub pool_backer: Pubkey,
    pub protocol_fee_bps: u16,
    pub partner_fee_bps: u16,
    pub pool_backer_fee_bps: u16,
}

#[event]
pub struct MarketResolvedV2 {
    pub market: Pubkey,
    pub game_program: Pubkey,
    pub game_state: Pubkey,
    pub winning_outcome: u8,
    pub total_pot: u64,
    pub protocol_fee: u64,
    pub partner_fee: u64,
    pub pool_backer_fee: u64,
    pub winner_payout: u64,
    pub resolver: Pubkey,
}

#[event]
pub struct MarketClosedPermissionlessly {
    pub market: Pubkey,
    pub authority: Pubkey,
    pub caller: Pubkey,
}

#[event]
pub struct GameProgramRegistered {
    pub game_program: Pubkey,
    pub label: String,
}

#[event]
pub struct GameProgramRegisteredV2 {
    pub game_program: Pubkey,
    pub label: String,
}

#[event]
pub struct MarketBoundToGame {
    pub market: Pubkey,
    pub game_program: Pubkey,
    pub game_state: Pubkey,
}
