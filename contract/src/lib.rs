//! Proof Market: bonded worker agents reproduce a repository README's "do X, see Y" steps, a
//! randomly drawn verifier audits, and liars lose their bond.
//!
//! One contract holds every job, report, audit, balance and payout. There is no owner and no admin
//! method: the config is fixed at `new`. Money only moves between internal `free` and `locked`
//! balances and leaves through `withdraw` (pull payments). Slashed funds are burned: they stay in
//! the contract forever and are counted in `total_burned`, so nobody profits from faking a slash.
//!
//! The lifecycle of a job:
//! 1. `post_job` escrows the bounty and fixes the deadlines.
//! 2. Registered workers `claim` (locking the job's bond), `commit` a hash of their report, then
//!    `reveal` it once nobody can copy anyone (commit-reveal).
//! 3. When every claimant revealed (or `advance` after the reveal window), the job is Reported.
//!    Disagreeing reports, a random sample, or a `challenge` open an audit round with a randomly
//!    drawn verifier, who rules with `verify`. One appeal (round 2) is possible and final.
//! 4. `finalize` settles: reports contradicting the final verdicts are slashed, the rest get their
//!    bond back and split the bounty step by step.
//!
//! The full rules are in docs/SPEC.md; the README in this crate lists the methods and panics.
use near_sdk::json_types::U128;
use near_sdk::serde_json::{Value, json};
use near_sdk::store::{Lazy, LookupMap};
use near_sdk::{AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, near, require};

pub const MAX_TITLE: usize = 80;
pub const MAX_REPO: usize = 200;
pub const MAX_PATH: usize = 100;
pub const MAX_STEP_TEXT: usize = 400;
pub const MAX_URI: usize = 200;
pub const MAX_LABEL: usize = 32;
pub const MAX_MODEL: usize = 64;
/// Registration stops at this many workers, and separately at this many verifiers.
pub const MAX_POOL: usize = 64;
/// A round whose drawn verifier is a no-show is redrawn at most this many times.
pub const MAX_REDRAWS: u8 = 2;
pub const BPS: u128 = 10_000;
pub const REPORT_TAG: &str = "proof-market report v1";
const LIST_DEFAULT: u64 = 20;
const LIST_MAX: u64 = 100;
const EVENT_STANDARD: &str = "proof_market";
const EVENT_VERSION: &str = "1.0.0";
const WITHDRAW_CALLBACK_GAS: Gas = Gas::from_tgas(5);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Jobs,
    Accounts,
    Workers,
    Verifiers,
}

// ---------- types ----------

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    /// free balance an account must lock to register as a worker
    pub min_worker_bond: U128,
    /// locked while the account is in the verifier pool
    pub verifier_bond: U128,
    /// locked by whoever calls `challenge`
    pub challenge_bond: U128,
    /// chance (basis points) that a unanimous job is audited anyway
    pub audit_bps: u16,
    /// share of the bounty paid to the round-1 verifier when audited
    pub audit_fee_bps: u16,
    pub max_steps: u8,
    pub max_slots: u8,
    /// bounds for every per-job phase length
    pub min_phase_ms: u64,
    pub max_phase_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    Fail,
    Unverifiable,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    /// what to do (JSON field `do`)
    #[serde(rename = "do")]
    pub act: String,
    /// what you should see
    pub see: String,
}

/// The stored state of a job. `Committing` and `Revealing` are not stored: the view derives them
/// (and every other time-based phase) from this state plus the clock.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobStatus {
    /// claim, commit and reveal phases (before the job is Reported)
    Open,
    /// reports are in and no audit round is waiting for a ruling
    Reported,
    /// an audit round waits for its drawn verifier
    Auditing,
    Finalized,
    Expired,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClaimStatus {
    Claimed,
    Committed,
    Revealed,
    NoShow,
    Paid,
    Slashed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Disagreement,
    Sample,
    Challenge,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Worker,
    Verifier,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PayoutKind {
    Bounty,
    Fee,
    Refund,
    BondReturn,
    ChallengeReturn,
    ChallengeAward,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BurnKind {
    Slash,
    NoShow,
    Overruled,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Claim {
    pub worker: AccountId,
    pub claimed_at: u64,
    /// sha256 of the report preimage, 64 lowercase hex
    pub hash: Option<String>,
    pub verdicts: Option<Vec<Verdict>>,
    pub transcript_hash: Option<String>,
    pub transcript_uri: Option<String>,
    pub revealed_at: Option<u64>,
    pub status: ClaimStatus,
    /// bounty credited to this worker at finalize
    pub earned: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Round {
    /// 1 (audit or dispute) or 2 (appeal, final)
    pub round: u8,
    pub reason: Reason,
    /// the currently drawn verifier; None once replaced or when the round has no ruling
    pub verifier: Option<AccountId>,
    /// 0 for the first draw, then one more per no-show redraw
    pub attempt: u8,
    pub drawn_at: u64,
    pub deadline: u64,
    pub ruling: Option<Vec<Verdict>>,
    pub transcript_hash: Option<String>,
    pub transcript_uri: Option<String>,
    pub ruled_at: Option<u64>,
    pub challenger: Option<AccountId>,
    /// resolved as "no ruling": empty pool, or the redraw limit was hit
    pub no_ruling: bool,
    /// verifiers drawn for this round that were replaced as no-shows
    pub replaced: Vec<AccountId>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Payout {
    pub account: AccountId,
    pub amount: u128,
    pub kind: PayoutKind,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Burn {
    pub account: AccountId,
    pub amount: u128,
    pub kind: BurnKind,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Job {
    pub poster: AccountId,
    pub title: String,
    pub repo: String,
    pub commit: String,
    pub path: String,
    pub steps: Vec<Step>,
    pub slots: u8,
    pub bond: u128,
    pub bounty: u128,
    pub claim_ms: u64,
    pub run_ms: u64,
    pub reveal_ms: u64,
    pub window_ms: u64,
    pub posted_at: u64,
    pub claim_until: u64,
    pub commit_until: u64,
    pub reveal_until: u64,
    pub status: JobStatus,
    pub claims: Vec<Claim>,
    pub rounds: Vec<Round>,
    pub challenge_until: Option<u64>,
    pub reported_at: Option<u64>,
    pub final_verdicts: Option<Vec<Verdict>>,
    pub finalized_at: Option<u64>,
    pub payouts: Vec<Payout>,
    pub burns: Vec<Burn>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub claims: u32,
    pub reports: u32,
    pub paid_jobs: u32,
    pub slashes: u32,
    pub no_shows: u32,
    pub rulings: u32,
    pub overruled: u32,
    /// lifetime credits from bounties, verifier fees and challenge awards
    pub earned: u128,
    pub burned: u128,
}

/// An account's money inside the contract. The four buckets are disjoint:
/// total = free + locked + worker_bond + verifier_bond.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Account {
    pub free: u128,
    /// per-job claim bonds and challenge bonds
    pub locked: u128,
    pub role: Option<Role>,
    pub label: String,
    pub model: String,
    pub worker_bond: u128,
    pub verifier_bond: u128,
    /// claims on jobs that are not settled yet (blocks `leave_worker`)
    pub active_claims: u32,
    /// jobs where this verifier was drawn and that are not settled yet (blocks `leave_verifier`)
    pub active_audits: u32,
    pub stats: Stats,
}

// ---------- views ----------

#[near(serializers = [json])]
pub struct ClaimView {
    pub worker: AccountId,
    pub claimed_at: u64,
    pub committed: bool,
    pub hash: Option<String>,
    pub revealed: bool,
    pub verdicts: Option<Vec<Verdict>>,
    pub transcript_hash: Option<String>,
    pub transcript_uri: Option<String>,
    pub revealed_at: Option<u64>,
    pub status: ClaimStatus,
    pub earned: U128,
}

#[near(serializers = [json])]
pub struct RoundView {
    pub round: u8,
    pub reason: Reason,
    pub verifier: Option<AccountId>,
    pub attempt: u8,
    pub drawn_at: u64,
    pub deadline: u64,
    pub ruling: Option<Vec<Verdict>>,
    pub transcript_hash: Option<String>,
    pub transcript_uri: Option<String>,
    pub ruled_at: Option<u64>,
    pub challenger: Option<AccountId>,
    /// "pending" (waiting for the drawn verifier), "ruled" or "no_ruling"
    pub outcome: String,
    pub replaced: Vec<AccountId>,
}

#[near(serializers = [json])]
pub struct PayoutView {
    pub account: AccountId,
    pub amount: U128,
    pub kind: PayoutKind,
}

#[near(serializers = [json])]
pub struct BurnView {
    pub account: AccountId,
    pub amount: U128,
    pub kind: BurnKind,
}

#[near(serializers = [json])]
pub struct JobView {
    pub id: u64,
    pub poster: AccountId,
    pub title: String,
    pub repo: String,
    pub commit: String,
    pub path: String,
    pub steps: Vec<Step>,
    pub slots: u8,
    pub bond: U128,
    pub bounty: U128,
    pub claim_ms: u64,
    pub run_ms: u64,
    pub reveal_ms: u64,
    pub window_ms: u64,
    pub posted_at: u64,
    pub claim_until: u64,
    pub commit_until: u64,
    pub reveal_until: u64,
    /// the stored state (Open, Reported, Auditing, Finalized, Expired)
    pub status: JobStatus,
    /// the current phase from state + time: Open, Committing, Revealing, Reported, Auditing,
    /// Finalized or Expired
    pub phase: String,
    /// `reveal` is accepted right now
    pub reveal_open: bool,
    /// a time-based transition is pending: `advance` would change the job now
    pub advance_due: bool,
    /// `finalize` would succeed now
    pub finalize_ready: bool,
    pub claims: Vec<ClaimView>,
    pub rounds: Vec<RoundView>,
    pub challenge_until: Option<u64>,
    pub reported_at: Option<u64>,
    pub final_verdicts: Option<Vec<Verdict>>,
    pub finalized_at: Option<u64>,
    pub payouts: Vec<PayoutView>,
    pub burns: Vec<BurnView>,
}

#[near(serializers = [json])]
pub struct JobSummary {
    pub id: u64,
    pub poster: AccountId,
    pub title: String,
    pub repo: String,
    pub commit: String,
    pub path: String,
    pub status: JobStatus,
    pub phase: String,
    pub bounty: U128,
    pub slots: u8,
    pub claims_count: u8,
    pub steps_count: u8,
    pub final_verdicts: Option<Vec<Verdict>>,
    pub slashed_count: u8,
    pub posted_at: u64,
}

#[near(serializers = [json])]
pub struct StatsView {
    pub claims: u32,
    pub reports: u32,
    pub paid_jobs: u32,
    pub slashes: u32,
    pub no_shows: u32,
    pub rulings: u32,
    pub overruled: u32,
    pub earned: U128,
    pub burned: U128,
}

#[near(serializers = [json])]
pub struct AccountView {
    pub account_id: AccountId,
    pub free: U128,
    /// per-job claim bonds and challenge bonds (the standing bonds are listed separately)
    pub locked: U128,
    pub role: Option<Role>,
    pub label: String,
    pub model: String,
    pub worker_bond: U128,
    pub verifier_bond: U128,
    pub active_claims: u32,
    pub active_audits: u32,
    pub stats: StatsView,
}

#[near(serializers = [json])]
pub struct MemberView {
    pub account_id: AccountId,
    pub label: String,
    pub model: String,
    pub stats: StatsView,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    config: Config,
    job_count: u64,
    total_burned: u128,
    jobs: LookupMap<u64, Job>,
    accounts: LookupMap<AccountId, Account>,
    /// registered workers, sorted by account id
    workers: Lazy<Vec<AccountId>>,
    /// the verifier pool (bonded verifiers), sorted by account id
    verifiers: Lazy<Vec<AccountId>>,
}

// ---------- pure helpers (also used by the unit tests) ----------

pub fn validate_config(c: &Config) {
    require!(c.audit_bps as u128 <= BPS && c.audit_fee_bps as u128 <= BPS, "config: bps must be <= 10000");
    require!((1..=20).contains(&c.max_steps), "config: max_steps must be 1..=20");
    require!((1..=8).contains(&c.max_slots), "config: max_slots must be 1..=8");
    require!(c.min_phase_ms <= c.max_phase_ms, "config: min_phase_ms must be <= max_phase_ms");
}

fn chars_within(s: &str, min: usize, max: usize) -> bool {
    let n = s.chars().count();
    n >= min && n <= max
}

fn is_lower_hex(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_hex(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn to_hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

pub fn verdict_letter(v: Verdict) -> &'static str {
    match v {
        Verdict::Pass => "P",
        Verdict::Fail => "F",
        Verdict::Unverifiable => "U",
    }
}

pub fn verdicts_csv(v: &[Verdict]) -> String {
    v.iter().map(|x| verdict_letter(*x)).collect::<Vec<_>>().join(",")
}

/// The exact string a worker hashes into its commit (plain ASCII, so any sha256 tool can check it).
pub fn report_preimage(contract: &str, job_id: u64, worker: &str, verdicts: &[Verdict], transcript_hash: &str, salt: &str) -> String {
    format!("{REPORT_TAG}|{contract}|{job_id}|{worker}|{}|{transcript_hash}|{salt}", verdicts_csv(verdicts))
}

/// sha256 of the report preimage, lowercase hex: the value `commit` expects.
pub fn report_hash(contract: &str, job_id: u64, worker: &str, verdicts: &[Verdict], transcript_hash: &str, salt: &str) -> String {
    to_hex(&env::sha256_array(report_preimage(contract, job_id, worker, verdicts, transcript_hash, salt).as_bytes()))
}

/// Pass vs Fail (either way) on any step. `Unverifiable` never contradicts anything.
pub fn contradicts(a: &[Verdict], b: &[Verdict]) -> bool {
    a.iter().zip(b).any(|(x, y)| matches!((x, y), (Verdict::Pass, Verdict::Fail) | (Verdict::Fail, Verdict::Pass)))
}

/// Step-wise unanimous verdict of the reports, `Unverifiable` where they differ.
pub fn unanimous(reports: &[&[Verdict]]) -> Vec<Verdict> {
    let steps = reports.first().map(|r| r.len()).unwrap_or(0);
    (0..steps).map(|s| if reports.iter().all(|r| r[s] == reports[0][s]) { reports[0][s] } else { Verdict::Unverifiable }).collect()
}

/// `u16_from(sha256(random_seed || job_id || "sample")) % 10000`, where job_id is 8 bytes big
/// endian and u16_from reads the first 2 bytes of the digest big endian.
pub fn sample_roll(seed: &[u8], job_id: u64) -> u16 {
    let mut buf = Vec::with_capacity(seed.len() + 14);
    buf.extend_from_slice(seed);
    buf.extend_from_slice(&job_id.to_be_bytes());
    buf.extend_from_slice(b"sample");
    let h = env::sha256_array(&buf);
    u16::from_be_bytes([h[0], h[1]]) % 10_000
}

/// `u64_from(sha256(random_seed || job_id || round || attempt)) % len`: job_id is 8 bytes big
/// endian, round and attempt are one byte each, u64_from reads the first 8 digest bytes big endian.
pub fn draw_index(seed: &[u8], job_id: u64, round: u8, attempt: u8, len: usize) -> usize {
    let mut buf = Vec::with_capacity(seed.len() + 10);
    buf.extend_from_slice(seed);
    buf.extend_from_slice(&job_id.to_be_bytes());
    buf.push(round);
    buf.push(attempt);
    let h = env::sha256_array(&buf);
    let mut x = [0u8; 8];
    x.copy_from_slice(&h[..8]);
    (u64::from_be_bytes(x) % len as u64) as usize
}

/// The eligible pool for a draw, sorted by account id: bonded verifiers that are not the poster,
/// not a claimant of the job, not already drawn on the job, and not the challenger of the round.
pub fn eligible_verifiers(
    pool: &[AccountId],
    poster: &AccountId,
    claimants: &[AccountId],
    drawn: &[AccountId],
    challenger: Option<&AccountId>,
) -> Vec<AccountId> {
    let mut out: Vec<AccountId> =
        pool.iter().filter(|v| *v != poster && !claimants.contains(v) && !drawn.contains(v) && challenger != Some(*v)).cloned().collect();
    out.sort();
    out
}

/// Split `pool` over the steps (`pool / steps` each, the last step takes the remainder). A step's
/// share goes in equal parts to the non-slashed reports whose verdict on that step equals the final
/// verdict. Returns each report's total and what goes back to the poster (steps nobody matched,
/// plus the rounding dust of the equal splits).
pub fn split_bounty(pool: u128, final_verdicts: &[Verdict], reports: &[(&[Verdict], bool)]) -> (Vec<u128>, u128) {
    let mut shares = vec![0u128; reports.len()];
    let steps = final_verdicts.len() as u128;
    if steps == 0 {
        return (shares, pool);
    }
    let base = pool / steps;
    let mut back = 0u128;
    for (s, fv) in final_verdicts.iter().enumerate() {
        let step_share = if s as u128 == steps - 1 { pool - base * (steps - 1) } else { base };
        let winners: Vec<usize> = reports.iter().enumerate().filter(|(_, (v, slashed))| !slashed && v[s] == *fv).map(|(i, _)| i).collect();
        if winners.is_empty() {
            back += step_share;
            continue;
        }
        let each = step_share / winners.len() as u128;
        for &w in &winners {
            shares[w] += each;
        }
        back += step_share - each * winners.len() as u128;
    }
    (shares, back)
}

fn emit(event: &str, data: Value) {
    let ev = json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{ev}"));
}

fn pool_insert(pool: &mut Lazy<Vec<AccountId>>, who: &AccountId) {
    let v = pool.get_mut();
    if let Err(i) = v.binary_search(who) {
        v.insert(i, who.clone());
    }
}

fn pool_remove(pool: &mut Lazy<Vec<AccountId>>, who: &AccountId) {
    if pool.get().binary_search(who).is_ok() {
        let v = pool.get_mut();
        if let Ok(i) = v.binary_search(who) {
            v.remove(i);
        }
    }
}

impl Job {
    fn claim_index(&self, who: &AccountId) -> Option<usize> {
        self.claims.iter().position(|c| &c.worker == who)
    }

    fn claim_phase_over(&self, now: u64) -> bool {
        self.claims.len() >= self.slots as usize || now >= self.claim_until
    }

    /// Reveals are accepted from `commit_until`, or earlier once the claim phase is over and every
    /// claimant has committed (nobody is left who could copy a revealed report). They stop at
    /// `reveal_until`.
    fn reveal_open(&self, now: u64) -> bool {
        self.status == JobStatus::Open
            && now < self.reveal_until
            && (now >= self.commit_until || (self.claim_phase_over(now) && self.claims.iter().all(|c| c.hash.is_some())))
    }

    /// Every verifier ever drawn on this job (current ones and replaced no-shows).
    fn drawn_verifiers(&self) -> Vec<AccountId> {
        self.rounds.iter().flat_map(|r| r.verifier.iter().chain(r.replaced.iter())).cloned().collect()
    }

    /// Reported and settled in time: unaudited past the window, round 1 ruled past the window,
    /// round 2 ruled (final at once), or the last round resolved as "no ruling".
    fn finalize_ready(&self, now: u64) -> bool {
        if self.status != JobStatus::Reported {
            return false;
        }
        match self.rounds.last() {
            None => self.challenge_until.is_some_and(|t| now >= t),
            Some(r) if r.no_ruling => true,
            Some(r) if r.ruling.is_some() => r.round >= 2 || self.challenge_until.is_some_and(|t| now >= t),
            Some(_) => false,
        }
    }

    fn reports(&self) -> Vec<(usize, Vec<Verdict>)> {
        self.claims.iter().enumerate().filter_map(|(i, c)| c.verdicts.clone().map(|v| (i, v))).collect()
    }
}

// ---------- the contract ----------

#[near]
impl Contract {
    /// One-time setup by the contract account itself. The config can never change afterwards.
    #[init]
    #[private]
    pub fn new(config: Config) -> Self {
        validate_config(&config);
        Self {
            config,
            job_count: 0,
            total_burned: 0,
            jobs: LookupMap::new(Key::Jobs),
            accounts: LookupMap::new(Key::Accounts),
            workers: Lazy::new(Key::Workers, Vec::new()),
            verifiers: Lazy::new(Key::Verifiers, Vec::new()),
        }
    }

    // ---------- money ----------

    /// Credit the attached deposit to `account_id` (default: the caller) as free balance. Anyone may
    /// fund anyone; the storage of a new account record is paid out of the deposit itself.
    #[payable]
    pub fn deposit(&mut self, account_id: Option<AccountId>) -> U128 {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "deposit: attach the amount to deposit");
        let to = account_id.unwrap_or_else(env::predecessor_account_id);
        let before = env::storage_usage();
        self.with_acct(&to, |a| a.free += amount);
        self.charge_storage(&to, before);
        U128(self.acct(&to).free)
    }

    /// Send `amount` (default: all) of the caller's free balance to the caller. Locked funds and
    /// standing bonds never withdraw. A failed transfer is credited back.
    pub fn withdraw(&mut self, amount: Option<U128>) -> Promise {
        let me = env::predecessor_account_id();
        let mut a = self.acct(&me);
        let amt = amount.map(|x| x.0).unwrap_or(a.free);
        require!(amt > 0, "withdraw: nothing to withdraw");
        require!(amt <= a.free, format!("withdraw: only free balance can be withdrawn (free {}, requested {amt})", a.free));
        a.free -= amt;
        self.accounts.insert(me.clone(), a);
        Promise::new(me.clone())
            .transfer(NearToken::from_yoctonear(amt))
            .then(Self::ext(env::current_account_id()).with_static_gas(WITHDRAW_CALLBACK_GAS).on_withdraw(me, U128(amt)))
    }

    #[private]
    pub fn on_withdraw(&mut self, account_id: AccountId, amount: U128, #[callback_result] r: Result<(), PromiseError>) -> bool {
        if r.is_err() {
            self.with_acct(&account_id, |a| a.free += amount.0);
            return false;
        }
        true
    }

    // ---------- roles ----------

    /// Lock `min_worker_bond` from free as the standing worker bond and join the worker list.
    #[payable]
    pub fn register_worker(&mut self, label: String, model: String) {
        self.register(Role::Worker, label, model);
    }

    /// Return the standing worker bond to free. Only without active claims.
    pub fn leave_worker(&mut self) {
        let me = env::predecessor_account_id();
        let mut a = self.acct(&me);
        require!(a.role == Some(Role::Worker), "not a worker");
        require!(a.active_claims == 0, format!("worker has {} active claims", a.active_claims));
        a.free += a.worker_bond;
        a.worker_bond = 0;
        a.role = None;
        self.accounts.insert(me.clone(), a);
        pool_remove(&mut self.workers, &me);
    }

    /// Lock `verifier_bond` from free and join the verifier pool.
    #[payable]
    pub fn register_verifier(&mut self, label: String, model: String) {
        self.register(Role::Verifier, label, model);
    }

    /// Leave the pool and unlock the bond. Not while drawn on a job that is not settled yet (a
    /// ruling can still be overruled until the job is finalized).
    pub fn leave_verifier(&mut self) {
        let me = env::predecessor_account_id();
        let mut a = self.acct(&me);
        require!(a.role == Some(Role::Verifier), "not a verifier");
        require!(a.active_audits == 0, "verifier is drawn on an open audit");
        a.free += a.verifier_bond;
        a.verifier_bond = 0;
        a.role = None;
        self.accounts.insert(me.clone(), a);
        pool_remove(&mut self.verifiers, &me);
    }

    // ---------- jobs ----------

    /// Post a job: escrow `bounty` from the caller's free balance (after crediting the attached
    /// deposit) and fix the deadlines. Returns the new job id.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn post_job(
        &mut self,
        title: String,
        repo: String,
        commit: String,
        path: String,
        steps: Vec<Step>,
        slots: u8,
        bond: U128,
        bounty: U128,
        claim_ms: u64,
        run_ms: u64,
        reveal_ms: u64,
        window_ms: u64,
    ) -> u64 {
        let me = env::predecessor_account_id();
        let before = env::storage_usage();
        self.credit_deposit(&me);
        let c = self.config.clone();
        require!(chars_within(&title, 0, MAX_TITLE), "title: at most 80 chars");
        require!(
            repo.starts_with("https://") && chars_within(&repo, 0, MAX_REPO),
            "repo: must start with https:// and be at most 200 chars"
        );
        require!((7..=40).contains(&commit.len()) && is_lower_hex(&commit), "commit: must be 7 to 40 lowercase hex chars");
        require!(
            chars_within(&path, 0, MAX_PATH) && !path.contains("..") && !path.starts_with('/') && !path.contains('\\'),
            "path: must be a relative subdirectory of at most 100 chars without \"..\""
        );
        require!(!steps.is_empty() && steps.len() <= c.max_steps as usize, format!("steps: need 1 to {} steps", c.max_steps));
        for s in &steps {
            require!(
                chars_within(&s.act, 1, MAX_STEP_TEXT) && chars_within(&s.see, 1, MAX_STEP_TEXT),
                "steps: every do and see must be 1 to 400 chars"
            );
        }
        require!(slots >= 1 && slots <= c.max_slots, format!("slots: must be 1 to {}", c.max_slots));
        require!(bond.0 >= 1, "bond: must be at least 1 yocto");
        for (name, ms) in [("claim_ms", claim_ms), ("run_ms", run_ms), ("reveal_ms", reveal_ms), ("window_ms", window_ms)] {
            require!(
                ms >= c.min_phase_ms && ms <= c.max_phase_ms,
                format!("{name}: must be within [{}, {}] ms", c.min_phase_ms, c.max_phase_ms)
            );
        }
        let mut a = self.acct(&me);
        require!(a.free >= bounty.0, format!("bounty: need {} yocto free, have {}", bounty.0, a.free));
        a.free -= bounty.0;
        self.accounts.insert(me.clone(), a);

        let now = env::block_timestamp_ms();
        let id = self.job_count;
        self.job_count += 1;
        let step_count = steps.len();
        let commit_until = now + claim_ms + run_ms;
        self.jobs.insert(
            id,
            Job {
                poster: me.clone(),
                title,
                repo,
                commit,
                path,
                steps,
                slots,
                bond: bond.0,
                bounty: bounty.0,
                claim_ms,
                run_ms,
                reveal_ms,
                window_ms,
                posted_at: now,
                claim_until: now + claim_ms,
                commit_until,
                reveal_until: commit_until + reveal_ms,
                status: JobStatus::Open,
                claims: Vec::new(),
                rounds: Vec::new(),
                challenge_until: None,
                reported_at: None,
                final_verdicts: None,
                finalized_at: None,
                payouts: Vec::new(),
                burns: Vec::new(),
            },
        );
        emit("job_posted", json!({ "job_id": id, "poster": me, "bounty": bounty, "slots": slots, "steps": step_count }));
        self.charge_storage(&me, before);
        id
    }

    /// Take a slot: lock the job's bond from free. Registered workers only, never the poster.
    #[payable]
    pub fn claim(&mut self, job_id: u64) {
        let me = env::predecessor_account_id();
        let before = env::storage_usage();
        self.credit_deposit(&me);
        let now = env::block_timestamp_ms();
        let mut job = self.job(job_id);
        require!(job.poster != me, "poster cannot claim its own job");
        let mut a = self.acct(&me);
        require!(a.role == Some(Role::Worker), "not a worker");
        require!(job.claim_index(&me).is_none(), "already claimed this job");
        require!(job.status == JobStatus::Open && now < job.claim_until, "claim phase closed");
        require!(job.claims.len() < job.slots as usize, "all slots are taken");
        require!(a.free >= job.bond, format!("bond: need {} yocto free, have {}", job.bond, a.free));
        a.free -= job.bond;
        a.locked += job.bond;
        a.active_claims += 1;
        a.stats.claims += 1;
        self.accounts.insert(me.clone(), a);
        job.claims.push(Claim {
            worker: me.clone(),
            claimed_at: now,
            hash: None,
            verdicts: None,
            transcript_hash: None,
            transcript_uri: None,
            revealed_at: None,
            status: ClaimStatus::Claimed,
            earned: 0,
        });
        self.jobs.insert(job_id, job);
        emit("job_claimed", json!({ "job_id": job_id, "worker": me }));
        self.charge_storage(&me, before);
    }

    /// Commit `hash = sha256(report_preimage)` (64 lowercase hex). Claimants only, once, before
    /// `commit_until`.
    pub fn commit(&mut self, job_id: u64, hash: String) {
        let me = env::predecessor_account_id();
        let before = env::storage_usage();
        let now = env::block_timestamp_ms();
        let mut job = self.job(job_id);
        let i = job.claim_index(&me).unwrap_or_else(|| env::panic_str("not a claimant of this job"));
        require!(job.status == JobStatus::Open && now < job.commit_until, "commit window closed");
        require!(job.claims[i].hash.is_none(), "already committed");
        require!(hash.len() == 64 && is_lower_hex(&hash), "hash: must be 64 lowercase hex chars");
        job.claims[i].hash = Some(hash);
        job.claims[i].status = ClaimStatus::Committed;
        self.jobs.insert(job_id, job);
        emit("report_committed", json!({ "job_id": job_id, "worker": me }));
        self.charge_storage(&me, before);
    }

    /// Reveal the committed report. The contract recomputes the hash; when every claimant has
    /// revealed, the job is Reported at once (and maybe audited).
    pub fn reveal(&mut self, job_id: u64, verdicts: Vec<Verdict>, transcript_hash: String, transcript_uri: String, salt: String) {
        let me = env::predecessor_account_id();
        let before = env::storage_usage();
        let now = env::block_timestamp_ms();
        let mut job = self.job(job_id);
        let i = job.claim_index(&me).unwrap_or_else(|| env::panic_str("not a claimant of this job"));
        require!(job.claims[i].hash.is_some(), "no commit to reveal");
        require!(job.claims[i].verdicts.is_none(), "already revealed");
        require!(job.status == JobStatus::Open && now < job.reveal_until, "reveal window closed");
        require!(job.reveal_open(now), "reveal phase not open yet");
        require!(verdicts.len() == job.steps.len(), format!("wrong number of verdicts: need {}, got {}", job.steps.len(), verdicts.len()));
        require!(transcript_hash.len() == 64 && is_hex(&transcript_hash), "transcript_hash: must be 64 hex chars");
        require!(chars_within(&transcript_uri, 0, MAX_URI), "transcript_uri: at most 200 chars");
        require!((16..=64).contains(&salt.len()) && is_hex(&salt), "salt: must be 16 to 64 hex chars");
        let digest = report_hash(env::current_account_id().as_str(), job_id, me.as_str(), &verdicts, &transcript_hash, &salt);
        require!(job.claims[i].hash.as_deref() == Some(digest.as_str()), "reveal does not match commit");
        let csv = verdicts_csv(&verdicts);
        let c = &mut job.claims[i];
        c.verdicts = Some(verdicts);
        c.transcript_hash = Some(transcript_hash);
        c.transcript_uri = Some(transcript_uri);
        c.revealed_at = Some(now);
        c.status = ClaimStatus::Revealed;
        self.with_acct(&me, |a| a.stats.reports += 1);
        emit("report_revealed", json!({ "job_id": job_id, "worker": me, "verdicts": csv }));
        if job.claims.iter().all(|c| c.verdicts.is_some()) {
            self.report(&mut job, job_id, now);
        }
        self.jobs.insert(job_id, job);
        self.charge_storage(&me, before);
    }

    /// The drawn verifier of the open round records its ruling before the round's deadline.
    pub fn verify(&mut self, job_id: u64, verdicts: Vec<Verdict>, transcript_hash: String, transcript_uri: String) {
        let me = env::predecessor_account_id();
        let before = env::storage_usage();
        let now = env::block_timestamp_ms();
        let mut job = self.job(job_id);
        require!(job.poster != me, "poster cannot verify its own job");
        require!(job.claim_index(&me).is_none(), "a claimant cannot verify its own job");
        require!(job.status == JobStatus::Auditing, "no open audit on this job");
        let r = job.rounds.last().unwrap_or_else(|| env::panic_str("no open audit on this job"));
        require!(r.verifier.as_ref() == Some(&me), "not the drawn verifier");
        require!(now < r.deadline, "audit deadline passed");
        // a verifier that lost its bond elsewhere has nothing at stake here: `advance` replaces it
        require!(self.acct(&me).role == Some(Role::Verifier), "verifier is no longer bonded");
        require!(verdicts.len() == job.steps.len(), format!("wrong number of verdicts: need {}, got {}", job.steps.len(), verdicts.len()));
        require!(transcript_hash.len() == 64 && is_hex(&transcript_hash), "transcript_hash: must be 64 hex chars");
        require!(chars_within(&transcript_uri, 0, MAX_URI), "transcript_uri: at most 200 chars");
        let csv = verdicts_csv(&verdicts);
        let window_ms = job.window_ms;
        let r = job.rounds.last_mut().unwrap_or_else(|| env::abort());
        let round = r.round;
        r.ruling = Some(verdicts);
        r.transcript_hash = Some(transcript_hash);
        r.transcript_uri = Some(transcript_uri);
        r.ruled_at = Some(now);
        job.status = JobStatus::Reported;
        // a round-1 ruling can be appealed within the window; a round-2 ruling is final at once
        job.challenge_until = Some(if round == 1 { now + window_ms } else { now });
        self.with_acct(&me, |a| a.stats.rulings += 1);
        self.jobs.insert(job_id, job);
        emit("audit_ruled", json!({ "job_id": job_id, "round": round, "verifier": me, "verdicts": csv }));
        self.charge_storage(&me, before);
    }

    /// Dispute an unaudited job (opens round 1) or appeal a round-1 ruling (opens round 2, final).
    /// The poster or a claimant with a revealed report, within the challenge window; locks
    /// `challenge_bond` from free.
    #[payable]
    pub fn challenge(&mut self, job_id: u64) {
        let me = env::predecessor_account_id();
        let before = env::storage_usage();
        self.credit_deposit(&me);
        let now = env::block_timestamp_ms();
        let mut job = self.job(job_id);
        require!(!matches!(job.status, JobStatus::Finalized | JobStatus::Expired), "job is closed");
        require!(job.status != JobStatus::Open, "job not reported yet");
        let reporter = job.claims.iter().any(|c| c.worker == me && c.verdicts.is_some());
        require!(job.poster == me || reporter, "only the poster or a claimant with a revealed report can challenge");
        if job.status == JobStatus::Auditing {
            let challenged = job.rounds.last().is_some_and(|r| r.challenger.is_some());
            require!(!challenged, "already challenged this round");
            env::panic_str("nothing to challenge");
        }
        let round_one_ruled = job.rounds.first().is_some_and(|r| r.ruling.is_some());
        require!(job.rounds.is_empty() || (job.rounds.len() == 1 && round_one_ruled), "nothing to challenge");
        require!(job.challenge_until.is_some_and(|t| now < t), "challenge window closed");
        let bond = self.config.challenge_bond.0;
        let mut a = self.acct(&me);
        require!(a.free >= bond, format!("challenge bond: need {bond} yocto free, have {}", a.free));
        a.free -= bond;
        a.locked += bond;
        self.accounts.insert(me.clone(), a);
        emit("challenged", json!({ "job_id": job_id, "challenger": me, "round": job.rounds.len() + 1 }));
        self.open_round(&mut job, job_id, Reason::Challenge, Some(me.clone()), now);
        self.jobs.insert(job_id, job);
        self.charge_storage(&me, before);
    }

    /// Anyone moves the time-based transitions: expire a job nobody claimed, mark no-show workers
    /// after the reveal window, or replace a drawn verifier that missed its deadline.
    pub fn advance(&mut self, job_id: u64) {
        let me = env::predecessor_account_id();
        let before = env::storage_usage();
        let now = env::block_timestamp_ms();
        let mut job = self.job(job_id);
        match job.status {
            JobStatus::Open if job.claims.is_empty() && now >= job.claim_until => self.expire(&mut job, job_id),
            JobStatus::Open if now >= job.reveal_until => {
                let bond = job.bond;
                for i in 0..job.claims.len() {
                    if job.claims[i].verdicts.is_some() {
                        continue;
                    }
                    let w = job.claims[i].worker.clone();
                    job.claims[i].status = ClaimStatus::NoShow;
                    self.with_acct(&w, |a| {
                        a.locked -= bond;
                        a.active_claims = a.active_claims.saturating_sub(1);
                        a.stats.no_shows += 1;
                        a.stats.burned += bond;
                    });
                    self.add_burn(&mut job, &w, bond, BurnKind::NoShow);
                    emit("no_show", json!({ "job_id": job_id, "account": w, "role": "worker", "burned": U128(bond) }));
                }
                if job.claims.iter().any(|c| c.verdicts.is_some()) {
                    self.report(&mut job, job_id, now);
                } else {
                    self.expire(&mut job, job_id);
                }
            }
            JobStatus::Auditing => self.replace_verifier(&mut job, job_id, now),
            _ => env::panic_str("nothing to advance"),
        }
        self.jobs.insert(job_id, job);
        self.charge_storage(&me, before);
    }

    /// Anyone settles a Reported job once it is settled in time.
    pub fn finalize(&mut self, job_id: u64) {
        let me = env::predecessor_account_id();
        let before = env::storage_usage();
        let now = env::block_timestamp_ms();
        let mut job = self.job(job_id);
        match job.status {
            JobStatus::Finalized => env::panic_str("already finalized"),
            JobStatus::Expired => env::panic_str("job expired"),
            JobStatus::Open => env::panic_str("job not reported yet"),
            JobStatus::Auditing => env::panic_str("audit in progress"),
            JobStatus::Reported => {}
        }
        require!(job.finalize_ready(now), "challenge window still open");
        self.settle(&mut job, job_id, now);
        self.jobs.insert(job_id, job);
        self.charge_storage(&me, before);
    }

    // ---------- views ----------

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn job_count(&self) -> u64 {
        self.job_count
    }

    pub fn get_job(&self, job_id: u64) -> Option<JobView> {
        self.jobs.get(&job_id).map(|j| self.job_view(job_id, j, env::block_timestamp_ms()))
    }

    /// Newest first. `from_index` skips that many of the newest jobs; `limit` defaults to 20 (max 100).
    pub fn list_jobs(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<JobSummary> {
        let now = env::block_timestamp_ms();
        let skip = from_index.unwrap_or(0).min(self.job_count) as usize;
        let take = limit.unwrap_or(LIST_DEFAULT).min(LIST_MAX) as usize;
        (0..self.job_count)
            .rev()
            .skip(skip)
            .take(take)
            .filter_map(|id| self.jobs.get(&id).map(|j| (id, j)))
            .map(|(id, j)| JobSummary {
                id,
                poster: j.poster.clone(),
                title: j.title.clone(),
                repo: j.repo.clone(),
                commit: j.commit.clone(),
                path: j.path.clone(),
                status: j.status,
                phase: self.phase(j, now).to_string(),
                bounty: U128(j.bounty),
                slots: j.slots,
                claims_count: j.claims.len() as u8,
                steps_count: j.steps.len() as u8,
                final_verdicts: j.final_verdicts.clone(),
                slashed_count: j.claims.iter().filter(|c| c.status == ClaimStatus::Slashed).count() as u8,
                posted_at: j.posted_at,
            })
            .collect()
    }

    pub fn get_account(&self, account_id: AccountId) -> AccountView {
        let a = self.acct(&account_id);
        AccountView {
            account_id,
            free: U128(a.free),
            locked: U128(a.locked),
            role: a.role,
            label: a.label.clone(),
            model: a.model.clone(),
            worker_bond: U128(a.worker_bond),
            verifier_bond: U128(a.verifier_bond),
            active_claims: a.active_claims,
            active_audits: a.active_audits,
            stats: stats_view(&a.stats),
        }
    }

    pub fn list_workers(&self) -> Vec<MemberView> {
        self.members(self.workers.get())
    }

    pub fn list_verifiers(&self) -> Vec<MemberView> {
        self.members(self.verifiers.get())
    }

    pub fn total_burned(&self) -> U128 {
        U128(self.total_burned)
    }

    pub fn block_time_ms(&self) -> u64 {
        env::block_timestamp_ms()
    }
}

fn stats_view(s: &Stats) -> StatsView {
    StatsView {
        claims: s.claims,
        reports: s.reports,
        paid_jobs: s.paid_jobs,
        slashes: s.slashes,
        no_shows: s.no_shows,
        rulings: s.rulings,
        overruled: s.overruled,
        earned: U128(s.earned),
        burned: U128(s.burned),
    }
}

// ---------- internals ----------

impl Contract {
    fn job(&self, id: u64) -> Job {
        self.jobs.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such job"))
    }

    fn acct(&self, id: &AccountId) -> Account {
        self.accounts.get(id).cloned().unwrap_or_default()
    }

    /// Load, modify and store one account record.
    fn with_acct<R>(&mut self, id: &AccountId, f: impl FnOnce(&mut Account) -> R) -> R {
        let mut a = self.acct(id);
        let r = f(&mut a);
        self.accounts.insert(id.clone(), a);
        r
    }

    fn credit_deposit(&mut self, me: &AccountId) {
        let d = env::attached_deposit().as_yoctonear();
        if d > 0 {
            self.with_acct(me, |a| a.free += d);
        }
    }

    /// Charge `payer` for the bytes this call added (NEAR storage staking). The root state has a
    /// fixed size after `new`, so flushing the collections makes `storage_usage` complete.
    fn charge_storage(&mut self, payer: &AccountId, before: u64) {
        self.jobs.flush();
        self.accounts.flush();
        self.workers.flush();
        self.verifiers.flush();
        let after = env::storage_usage();
        if after > before {
            let cost = (after - before) as u128 * env::storage_byte_cost().as_yoctonear();
            let mut a = self.acct(payer);
            require!(a.free >= cost, format!("storage: need {cost} yocto free"));
            a.free -= cost;
            self.accounts.insert(payer.clone(), a);
            self.accounts.flush();
        }
    }

    fn register(&mut self, role: Role, label: String, model: String) {
        let me = env::predecessor_account_id();
        let before = env::storage_usage();
        self.credit_deposit(&me);
        require!(chars_within(&label, 0, MAX_LABEL), "label: at most 32 chars");
        require!(chars_within(&model, 0, MAX_MODEL), "model: at most 64 chars");
        let mut a = self.acct(&me);
        match a.role {
            Some(Role::Worker) => env::panic_str("already registered as a worker"),
            Some(Role::Verifier) => env::panic_str("already registered as a verifier"),
            None => {}
        }
        let (bond, what) = match role {
            Role::Worker => (self.config.min_worker_bond.0, "worker bond"),
            Role::Verifier => (self.config.verifier_bond.0, "verifier bond"),
        };
        let pool = match role {
            Role::Worker => &mut self.workers,
            Role::Verifier => &mut self.verifiers,
        };
        require!(pool.get().len() < MAX_POOL, "pool full");
        require!(a.free >= bond, format!("{what}: need {bond} yocto free, have {}", a.free));
        pool_insert(pool, &me);
        a.free -= bond;
        match role {
            Role::Worker => a.worker_bond = bond,
            Role::Verifier => a.verifier_bond = bond,
        }
        a.role = Some(role);
        a.label = label;
        a.model = model;
        self.accounts.insert(me.clone(), a);
        self.charge_storage(&me, before);
    }

    fn add_burn(&mut self, job: &mut Job, who: &AccountId, amount: u128, kind: BurnKind) {
        if amount == 0 {
            return;
        }
        self.total_burned += amount;
        job.burns.push(Burn { account: who.clone(), amount, kind });
    }

    /// Credit `amount` to `to`'s free balance and record it on the job (merged per account + kind).
    fn pay(&mut self, job: &mut Job, to: &AccountId, amount: u128, kind: PayoutKind) {
        if amount == 0 {
            return;
        }
        let earning = matches!(kind, PayoutKind::Bounty | PayoutKind::Fee | PayoutKind::ChallengeAward);
        self.with_acct(to, |a| {
            a.free += amount;
            if earning {
                a.stats.earned += amount;
            }
        });
        match job.payouts.iter_mut().find(|p| &p.account == to && p.kind == kind) {
            Some(p) => p.amount += amount,
            None => job.payouts.push(Payout { account: to.clone(), amount, kind }),
        }
    }

    fn take_locked(&mut self, who: &AccountId, amount: u128) {
        self.with_acct(who, |a| a.locked -= amount);
    }

    /// Burn a verifier's standing bond and drop it from the pool (no-show or overruled).
    fn eject_verifier(&mut self, job: &mut Job, v: &AccountId, kind: BurnKind) -> u128 {
        let amount = self.with_acct(v, |a| {
            let amount = a.verifier_bond;
            a.verifier_bond = 0;
            if a.role == Some(Role::Verifier) {
                a.role = None;
            }
            a.stats.burned += amount;
            amount
        });
        pool_remove(&mut self.verifiers, v);
        self.add_burn(job, v, amount, kind);
        amount
    }

    fn expire(&mut self, job: &mut Job, job_id: u64) {
        job.status = JobStatus::Expired;
        let poster = job.poster.clone();
        let refund = job.bounty;
        self.pay(job, &poster, refund, PayoutKind::Refund);
        emit("job_expired", json!({ "job_id": job_id, "poster": poster, "refund": U128(refund) }));
    }

    /// The job becomes Reported: audit on disagreement, else maybe a random sample audit, else the
    /// challenge window opens.
    fn report(&mut self, job: &mut Job, job_id: u64, now: u64) {
        job.status = JobStatus::Reported;
        job.reported_at = Some(now);
        let reports: Vec<&Vec<Verdict>> = job.claims.iter().filter_map(|c| c.verdicts.as_ref()).collect();
        let disagree = reports.windows(2).any(|w| w[0] != w[1]);
        emit("job_reported", json!({ "job_id": job_id, "poster": job.poster, "reports": reports.len(), "disagreement": disagree }));
        if disagree {
            self.open_round(job, job_id, Reason::Disagreement, None, now);
        } else if sample_roll(&env::random_seed_array(), job_id) < self.config.audit_bps {
            self.open_round(job, job_id, Reason::Sample, None, now);
        } else {
            job.challenge_until = Some(now + job.window_ms);
        }
    }

    fn open_round(&mut self, job: &mut Job, job_id: u64, reason: Reason, challenger: Option<AccountId>, now: u64) {
        let round = job.rounds.len() as u8 + 1;
        job.rounds.push(Round {
            round,
            reason,
            verifier: None,
            attempt: 0,
            drawn_at: now,
            deadline: now,
            ruling: None,
            transcript_hash: None,
            transcript_uri: None,
            ruled_at: None,
            challenger,
            no_ruling: false,
            replaced: Vec::new(),
        });
        self.draw(job, job_id, now);
    }

    /// Draw the verifier for the last round's current attempt. An empty eligible pool resolves the
    /// round as "no ruling".
    fn draw(&mut self, job: &mut Job, job_id: u64, now: u64) {
        let claimants: Vec<AccountId> = job.claims.iter().map(|c| c.worker.clone()).collect();
        let drawn = job.drawn_verifiers();
        let last = job.rounds.last().unwrap_or_else(|| env::abort());
        let eligible = eligible_verifiers(self.verifiers.get(), &job.poster, &claimants, &drawn, last.challenger.as_ref());
        let pick = (!eligible.is_empty())
            .then(|| eligible[draw_index(&env::random_seed_array(), job_id, last.round, last.attempt, eligible.len())].clone());
        let deadline = now + job.run_ms + job.reveal_ms;
        let r = job.rounds.last_mut().unwrap_or_else(|| env::abort());
        r.drawn_at = now;
        match &pick {
            Some(v) => {
                r.verifier = Some(v.clone());
                r.deadline = deadline;
            }
            None => {
                r.verifier = None;
                r.deadline = now;
                r.no_ruling = true;
            }
        }
        let (round, reason, attempt) = (r.round, r.reason, r.attempt);
        match pick {
            Some(v) => {
                job.status = JobStatus::Auditing;
                self.with_acct(&v, |a| a.active_audits += 1);
                emit(
                    "audit_opened",
                    json!({ "job_id": job_id, "round": round, "reason": reason, "attempt": attempt, "verifier": v, "deadline": deadline }),
                );
            }
            None => {
                job.status = JobStatus::Reported;
                emit(
                    "audit_opened",
                    json!({ "job_id": job_id, "round": round, "reason": reason, "attempt": attempt, "verifier": null, "no_ruling": true }),
                );
            }
        }
    }

    /// The drawn verifier missed its deadline (or lost its bond elsewhere): burn its bond, drop it
    /// from the pool and redraw, at most `MAX_REDRAWS` times per round.
    fn replace_verifier(&mut self, job: &mut Job, job_id: u64, now: u64) {
        let r = job.rounds.last().unwrap_or_else(|| env::panic_str("nothing to advance"));
        let v = r.verifier.clone().unwrap_or_else(|| env::panic_str("nothing to advance"));
        let late = now >= r.deadline;
        let bonded = self.acct(&v).role == Some(Role::Verifier);
        require!(late || !bonded, "nothing to advance");
        let burned = if bonded { self.eject_verifier(job, &v, BurnKind::NoShow) } else { 0 };
        self.with_acct(&v, |a| {
            a.active_audits = a.active_audits.saturating_sub(1);
            if late {
                a.stats.no_shows += 1;
            }
        });
        emit("no_show", json!({ "job_id": job_id, "account": v, "role": "verifier", "burned": U128(burned) }));
        let r = job.rounds.last_mut().unwrap_or_else(|| env::abort());
        r.replaced.push(v);
        r.verifier = None;
        if r.attempt < MAX_REDRAWS {
            r.attempt += 1;
            self.draw(job, job_id, now);
        } else {
            r.no_ruling = true;
            let round = r.round;
            job.status = JobStatus::Reported;
            emit("audit_ruled", json!({ "job_id": job_id, "round": round, "verifier": null, "verdicts": null, "no_ruling": true }));
        }
    }

    /// Settlement (SPEC "Finalize"): workers, verifier fee, challenge bonds, bounty split.
    fn settle(&mut self, job: &mut Job, job_id: u64, now: u64) {
        let reports = job.reports();
        let report_slices: Vec<&[Verdict]> = reports.iter().map(|(_, v)| v.as_slice()).collect();
        let final_v: Vec<Verdict> = job.rounds.iter().rev().find_map(|r| r.ruling.clone()).unwrap_or_else(|| unanimous(&report_slices));
        let bond = job.bond;

        // 1. workers: a report contradicting the final verdicts is slashed, every other gets its bond back
        let mut slashed = Vec::with_capacity(reports.len());
        for (i, v) in &reports {
            let worker = job.claims[*i].worker.clone();
            let lie = contradicts(v, &final_v);
            self.take_locked(&worker, bond);
            self.with_acct(&worker, |a| {
                a.active_claims = a.active_claims.saturating_sub(1);
                if lie {
                    a.stats.slashes += 1;
                    a.stats.burned += bond;
                }
            });
            if lie {
                job.claims[*i].status = ClaimStatus::Slashed;
                self.add_burn(job, &worker, bond, BurnKind::Slash);
                emit("worker_slashed", json!({ "job_id": job_id, "worker": worker, "burned": U128(bond) }));
            } else {
                job.claims[*i].status = ClaimStatus::Paid;
                self.pay(job, &worker, bond, PayoutKind::BondReturn);
            }
            slashed.push(lie);
        }

        // 2. verifier fee: to the round-1 verifier, or to the round-2 verifier when round 2
        // contradicts round 1 (the round-1 verifier is overruled: bond burned, out of the pool)
        let r1 = job.rounds.first().cloned();
        let r2 = job.rounds.get(1).cloned();
        let r1_ruling = r1.as_ref().and_then(|r| r.ruling.clone());
        let r2_ruling = r2.as_ref().and_then(|r| r.ruling.clone());
        let overruled = matches!((&r1_ruling, &r2_ruling), (Some(a), Some(b)) if contradicts(a, b));
        let v1 = r1.as_ref().and_then(|r| r.verifier.clone());
        let v2 = r2.as_ref().and_then(|r| r.verifier.clone());
        let mut fee_paid = 0u128;
        if let (Some(_), Some(v1)) = (&r1_ruling, &v1) {
            let fee = job.bounty * self.config.audit_fee_bps as u128 / BPS;
            let to = if overruled {
                let burned = self.eject_verifier(job, v1, BurnKind::Overruled);
                self.with_acct(v1, |a| a.stats.overruled += 1);
                emit("verifier_overruled", json!({ "job_id": job_id, "verifier": v1, "burned": U128(burned), "by": v2 }));
                v2.clone().unwrap_or_else(|| env::abort())
            } else {
                v1.clone()
            };
            if fee > 0 {
                self.pay(job, &to, fee, PayoutKind::Fee);
                self.with_acct(&to, |a| a.stats.paid_jobs += 1);
            }
            fee_paid = fee;
        }
        // the verifiers that ruled are released from this job
        for v in job.rounds.iter().filter(|r| r.ruling.is_some()).filter_map(|r| r.verifier.clone()).collect::<Vec<_>>() {
            self.with_acct(&v, |a| a.active_audits = a.active_audits.saturating_sub(1));
        }

        // 3. challenge bonds
        let cb = self.config.challenge_bond.0;
        if let Some(c) = r1.as_ref().and_then(|r| r.challenger.clone()) {
            // a dispute is right when the round-1 ruling contradicts at least one report; when round 1
            // was overruled the dispute is judged by the final (round-2) ruling, and a lost bond goes
            // to the round-2 verifier, never to the overruled one
            let award_to = match &r1_ruling {
                None => None,
                Some(_) if overruled => (!report_slices.iter().any(|v| contradicts(v, &final_v))).then(|| v2.clone()).flatten(),
                Some(rv) => (!report_slices.iter().any(|v| contradicts(v, rv))).then(|| v1.clone()).flatten(),
            };
            self.take_locked(&c, cb);
            match award_to {
                Some(v) => self.pay(job, &v, cb, PayoutKind::ChallengeAward),
                None => self.pay(job, &c, cb, PayoutKind::ChallengeReturn),
            }
        }
        if let Some(c) = r2.as_ref().and_then(|r| r.challenger.clone()) {
            // an appeal is right when round 2 overrules round 1; a lost bond goes to the round-2 verifier
            let award_to = if r2_ruling.is_none() || overruled { None } else { v2.clone() };
            self.take_locked(&c, cb);
            match award_to {
                Some(v) => self.pay(job, &v, cb, PayoutKind::ChallengeAward),
                None => self.pay(job, &c, cb, PayoutKind::ChallengeReturn),
            }
        }

        // 4. bounty: split step by step among the matching, non-slashed reports
        let entries: Vec<(&[Verdict], bool)> = report_slices.iter().zip(&slashed).map(|(v, s)| (*v, *s)).collect();
        let (shares, back) = split_bounty(job.bounty - fee_paid, &final_v, &entries);
        for ((i, _), share) in reports.iter().zip(shares) {
            if share == 0 {
                continue;
            }
            let worker = job.claims[*i].worker.clone();
            job.claims[*i].earned = share;
            self.pay(job, &worker, share, PayoutKind::Bounty);
            self.with_acct(&worker, |a| a.stats.paid_jobs += 1);
        }
        let poster = job.poster.clone();
        self.pay(job, &poster, back, PayoutKind::Refund);

        // 5. close
        let slashed_count = slashed.iter().filter(|s| **s).count();
        emit(
            "job_finalized",
            json!({ "job_id": job_id, "poster": poster, "final_verdicts": verdicts_csv(&final_v), "slashed": slashed_count, "fee": U128(fee_paid), "refund": U128(back) }),
        );
        job.final_verdicts = Some(final_v);
        job.finalized_at = Some(now);
        job.status = JobStatus::Finalized;
    }

    /// The phase a caller should act on now, from the stored state plus the clock.
    fn phase(&self, j: &Job, now: u64) -> &'static str {
        match j.status {
            JobStatus::Finalized => "Finalized",
            JobStatus::Expired => "Expired",
            JobStatus::Auditing => "Auditing",
            JobStatus::Reported => "Reported",
            JobStatus::Open => {
                if j.claims.is_empty() && now >= j.claim_until {
                    "Expired"
                } else if now >= j.reveal_until {
                    if j.claims.iter().any(|c| c.verdicts.is_some()) { "Reported" } else { "Expired" }
                } else if j.reveal_open(now) {
                    "Revealing"
                } else if j.claim_phase_over(now) {
                    "Committing"
                } else {
                    "Open"
                }
            }
        }
    }

    fn advance_due(&self, j: &Job, now: u64) -> bool {
        match j.status {
            JobStatus::Open => (j.claims.is_empty() && now >= j.claim_until) || now >= j.reveal_until,
            JobStatus::Auditing => j
                .rounds
                .last()
                .and_then(|r| r.verifier.as_ref().map(|v| (r, v)))
                .is_some_and(|(r, v)| now >= r.deadline || self.acct(v).role != Some(Role::Verifier)),
            _ => false,
        }
    }

    fn job_view(&self, id: u64, j: &Job, now: u64) -> JobView {
        JobView {
            id,
            poster: j.poster.clone(),
            title: j.title.clone(),
            repo: j.repo.clone(),
            commit: j.commit.clone(),
            path: j.path.clone(),
            steps: j.steps.clone(),
            slots: j.slots,
            bond: U128(j.bond),
            bounty: U128(j.bounty),
            claim_ms: j.claim_ms,
            run_ms: j.run_ms,
            reveal_ms: j.reveal_ms,
            window_ms: j.window_ms,
            posted_at: j.posted_at,
            claim_until: j.claim_until,
            commit_until: j.commit_until,
            reveal_until: j.reveal_until,
            status: j.status,
            phase: self.phase(j, now).to_string(),
            reveal_open: j.reveal_open(now),
            advance_due: self.advance_due(j, now),
            finalize_ready: j.finalize_ready(now),
            claims: j
                .claims
                .iter()
                .map(|c| ClaimView {
                    worker: c.worker.clone(),
                    claimed_at: c.claimed_at,
                    committed: c.hash.is_some(),
                    hash: c.hash.clone(),
                    revealed: c.verdicts.is_some(),
                    verdicts: c.verdicts.clone(),
                    transcript_hash: c.transcript_hash.clone(),
                    transcript_uri: c.transcript_uri.clone(),
                    revealed_at: c.revealed_at,
                    status: c.status,
                    earned: U128(c.earned),
                })
                .collect(),
            rounds: j
                .rounds
                .iter()
                .map(|r| RoundView {
                    round: r.round,
                    reason: r.reason,
                    verifier: r.verifier.clone(),
                    attempt: r.attempt,
                    drawn_at: r.drawn_at,
                    deadline: r.deadline,
                    ruling: r.ruling.clone(),
                    transcript_hash: r.transcript_hash.clone(),
                    transcript_uri: r.transcript_uri.clone(),
                    ruled_at: r.ruled_at,
                    challenger: r.challenger.clone(),
                    outcome: if r.ruling.is_some() {
                        "ruled"
                    } else if r.no_ruling {
                        "no_ruling"
                    } else {
                        "pending"
                    }
                    .to_string(),
                    replaced: r.replaced.clone(),
                })
                .collect(),
            challenge_until: j.challenge_until,
            reported_at: j.reported_at,
            final_verdicts: j.final_verdicts.clone(),
            finalized_at: j.finalized_at,
            payouts: j.payouts.iter().map(|p| PayoutView { account: p.account.clone(), amount: U128(p.amount), kind: p.kind }).collect(),
            burns: j.burns.iter().map(|b| BurnView { account: b.account.clone(), amount: U128(b.amount), kind: b.kind }).collect(),
        }
    }

    fn members(&self, ids: &[AccountId]) -> Vec<MemberView> {
        ids.iter()
            .map(|id| {
                let a = self.acct(id);
                MemberView { account_id: id.clone(), label: a.label.clone(), model: a.model.clone(), stats: stats_view(&a.stats) }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests;
