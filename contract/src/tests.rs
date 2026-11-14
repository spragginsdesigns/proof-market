// Unit tests: the report hash preimage, the verifier draw exclusion rules, the bounty split
// arithmetic, contradiction logic, and every settlement branch against the contract logic with a
// mocked chain (the near-sandbox integration tests run the same rules on the real wasm).
use super::*;
use Verdict::{Fail as F, Pass as P, Unverifiable as U};
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::testing_env;
use sha2::{Digest, Sha256};

const MS: u64 = 1_000_000; // ns per ms
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MARKET: &str = "market.testnet";
const POSTER: &str = "poster.testnet";
const TX_HASH: &str = "abababababababababababababababababababababababababababababababab";
const SALT: &str = "0123456789abcdef";

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(who: &str, t_ms: u64, deposit: u128, seed: u8) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acct(MARKET))
            .predecessor_account_id(acct(who))
            .signer_account_id(acct(who))
            .block_timestamp(t_ms * MS)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .random_seed([seed; 32])
            .account_balance(NearToken::from_near(100_000))
            .build()
    );
}

fn config(audit_bps: u16) -> Config {
    Config {
        min_worker_bond: U128(NEAR),
        verifier_bond: U128(2 * NEAR),
        challenge_bond: U128(NEAR / 2),
        audit_bps,
        audit_fee_bps: 1000,
        max_steps: 12,
        max_slots: 5,
        min_phase_ms: 1000,
        max_phase_ms: 600_000,
    }
}

fn setup(audit_bps: u16) -> Contract {
    ctx(MARKET, 0, 0, 0);
    Contract::new(config(audit_bps))
}

fn fund(c: &mut Contract, who: &str, near: u128) {
    ctx(who, 0, near * NEAR, 0);
    c.deposit(None);
}

fn worker(c: &mut Contract, who: &str) {
    fund(c, who, 100);
    ctx(who, 0, 0, 0);
    c.register_worker(format!("{who} label"), "model-x".into());
}

fn verifier(c: &mut Contract, who: &str) {
    fund(c, who, 100);
    ctx(who, 0, 0, 0);
    c.register_verifier(format!("{who} label"), "model-v".into());
}

fn steps(n: usize) -> Vec<Step> {
    (0..n).map(|i| Step { act: format!("run step {i}"), see: format!("output {i}") }).collect()
}

/// Post a job at t=0 with claim 10s, run 10s, reveal 10s, window 10s.
fn post(c: &mut Contract, n_steps: usize, slots: u8, bond: u128, bounty: u128) -> u64 {
    fund(c, POSTER, 100);
    ctx(POSTER, 0, 0, 0);
    c.post_job(
        "t".into(),
        "https://github.com/a/b".into(),
        "abcdef1".into(),
        "".into(),
        steps(n_steps),
        slots,
        U128(bond),
        U128(bounty),
        10_000,
        10_000,
        10_000,
        10_000,
    )
}

fn hash_of(job_id: u64, who: &str, v: &[Verdict]) -> String {
    let pre = report_preimage(MARKET, job_id, who, v, TX_HASH, SALT);
    let d: [u8; 32] = Sha256::digest(pre.as_bytes()).into();
    to_hex(&d)
}

fn commit_reveal(c: &mut Contract, job_id: u64, who: &str, v: &[Verdict], t_commit: u64, t_reveal: u64, seed: u8) {
    ctx(who, t_commit, 0, seed);
    c.commit(job_id, hash_of(job_id, who, v));
    ctx(who, t_reveal, 0, seed);
    c.reveal(job_id, v.to_vec(), TX_HASH.into(), format!("ipfs://{who}"), SALT.into());
}

fn free(c: &Contract, who: &str) -> u128 {
    c.get_account(acct(who)).free.0
}
fn locked(c: &Contract, who: &str) -> u128 {
    c.get_account(acct(who)).locked.0
}
fn job(c: &Contract, id: u64) -> JobView {
    c.get_job(id).unwrap()
}

/// Everything an account holds inside the contract.
fn total_of(c: &Contract, who: &str) -> u128 {
    let a = c.get_account(acct(who));
    a.free.0 + a.locked.0 + a.worker_bond.0 + a.verifier_bond.0
}

// ---------- pure helpers ----------

#[test]
fn hash_preimage_matches_an_independent_sha256() {
    let v = [P, F, U];
    let pre = report_preimage("market.testnet", 7, "alice.testnet", &v, TX_HASH, SALT);
    assert_eq!(pre, format!("proof-market report v1|market.testnet|7|alice.testnet|P,F,U|{TX_HASH}|{SALT}"));
    ctx(MARKET, 0, 0, 0);
    let ours = report_hash("market.testnet", 7, "alice.testnet", &v, TX_HASH, SALT);
    // the same vector computed with python hashlib, printed in the README
    assert_eq!(ours, "3d97f016e245bcbd8ae5f2b2605083427975758c4b0bd8b807ee5f424796de4f");
    let d: [u8; 32] = Sha256::digest(pre.as_bytes()).into();
    assert_eq!(ours, to_hex(&d));
    // every input is bound: changing any one changes the hash
    assert_ne!(ours, report_hash("market.testnet", 8, "alice.testnet", &v, TX_HASH, SALT));
    assert_ne!(ours, report_hash("market.testnet", 7, "bob.testnet", &v, TX_HASH, SALT));
    assert_ne!(ours, report_hash("other.testnet", 7, "alice.testnet", &v, TX_HASH, SALT));
    assert_ne!(ours, report_hash("market.testnet", 7, "alice.testnet", &[P, P, U], TX_HASH, SALT));
    assert_ne!(ours, report_hash("market.testnet", 7, "alice.testnet", &v, TX_HASH, "0123456789abcdee"));
    assert_eq!(verdicts_csv(&[P]), "P");
    assert_eq!(verdicts_csv(&[U, U, F, P]), "U,U,F,P");
}

#[test]
fn contradiction_logic() {
    assert!(contradicts(&[P], &[F]));
    assert!(contradicts(&[F], &[P]));
    assert!(!contradicts(&[P], &[P]));
    assert!(!contradicts(&[F], &[F]));
    for x in [P, F, U] {
        assert!(!contradicts(&[U], &[x]), "Unverifiable never contradicts");
        assert!(!contradicts(&[x], &[U]), "Unverifiable never contradicts");
    }
    assert!(contradicts(&[P, U, P], &[P, U, F]), "one contradicting step is enough");
    assert!(!contradicts(&[P, U, F], &[U, P, F]));
    assert_eq!(unanimous(&[&[P, F, U], &[P, F, U]]), vec![P, F, U]);
    assert_eq!(unanimous(&[&[P, F, P], &[P, P, U]]), vec![P, U, U]);
    assert_eq!(unanimous(&[&[F, P]]), vec![F, P]);
}

#[test]
fn bounty_split_arithmetic() {
    // 1000 over 3 steps: 333, 333 and 334 (the last step takes the remainder)
    let a: &[Verdict] = &[P, P, P];
    let b: &[Verdict] = &[P, F, P];
    let (s, back) = split_bounty(1000, &[P, P, P], &[(a, false), (b, false)]);
    // step 0: 333 / 2 = 166 each, dust 1; step 1: a alone 333; step 2: 334 / 2 = 167 each
    assert_eq!(s, vec![166 + 333 + 167, 166 + 167]);
    assert_eq!(back, 1);
    assert_eq!(s.iter().sum::<u128>() + back, 1000);

    // a step nobody matched goes back to the poster
    let (s, back) = split_bounty(900, &[P, F, P], &[(a, false)]);
    assert_eq!(s, vec![600]);
    assert_eq!(back, 300);

    // slashed reports earn nothing even on steps they matched
    let (s, back) = split_bounty(900, &[P, F, P], &[(a, true), (b, false)]);
    assert_eq!(s, vec![0, 900]);
    assert_eq!(back, 0);

    // nobody matches anything: everything back
    let (s, back) = split_bounty(7, &[U, U], &[(&[P, P], false)]);
    assert_eq!(s, vec![0]);
    assert_eq!(back, 7);

    // a pool smaller than the step count: only the last step carries value
    let (s, back) = split_bounty(2, &[P, P, P], &[(a, false)]);
    assert_eq!(s, vec![2]);
    assert_eq!(back, 0);

    // three-way split with dust, totals always conserved
    let (s, back) = split_bounty(10, &[P], &[(&[P], false), (&[P], false), (&[P], false)]);
    assert_eq!(s, vec![3, 3, 3]);
    assert_eq!(back, 1);
    for pool in [0u128, 1, 11, 999_999_999_999_999_999_999_999_999] {
        let (s, back) = split_bounty(pool, &[P, F, U, P], &[(&[P, F, U, F], false), (&[P, P, U, P], false), (&[P, F, U, P], true)]);
        assert_eq!(s.iter().sum::<u128>() + back, pool);
    }
}

#[test]
fn verifier_draw_exclusion_rules() {
    let pool: Vec<AccountId> = ["v3.testnet", "poster.testnet", "w1.testnet", "v1.testnet", "v2.testnet", "old.testnet", "ch.testnet"]
        .iter()
        .map(|s| acct(s))
        .collect();
    let poster = acct("poster.testnet");
    let claimants = vec![acct("w1.testnet"), acct("w2.testnet")];
    let drawn = vec![acct("old.testnet")];
    let ch = acct("ch.testnet");
    let e = eligible_verifiers(&pool, &poster, &claimants, &drawn, Some(&ch));
    // not the poster, not a claimant, not already drawn on this job, not the challenger; sorted
    assert_eq!(e, vec![acct("v1.testnet"), acct("v2.testnet"), acct("v3.testnet")]);
    let e = eligible_verifiers(&pool, &poster, &claimants, &[], None);
    assert_eq!(e.len(), 5);
    assert!(e.windows(2).all(|w| w[0] < w[1]), "deterministic order: sorted by account id");
    assert!(eligible_verifiers(std::slice::from_ref(&poster), &poster, &[], &[], None).is_empty());

    ctx(MARKET, 0, 0, 0);
    let seed = [9u8; 32];
    for len in 1..70 {
        for (round, attempt) in [(1u8, 0u8), (1, 1), (1, 2), (2, 0)] {
            let i = draw_index(&seed, 42, round, attempt, len);
            assert!(i < len);
            assert_eq!(i, draw_index(&seed, 42, round, attempt, len), "same inputs, same draw");
        }
    }
    // the inputs feed the draw: across many seeds round/attempt/job change the index
    let differs = (0..32u8).filter(|s| draw_index(&[*s; 32], 1, 1, 0, 1000) != draw_index(&[*s; 32], 1, 1, 1, 1000)).count();
    assert!(differs > 25);
    let roll = sample_roll(&seed, 3);
    assert!(roll < 10_000);
    assert_eq!(roll, sample_roll(&seed, 3));
}

// ---------- contract logic on a mocked chain ----------

#[test]
#[should_panic(expected = "config: bps must be <= 10000")]
fn config_rejects_bps_over_10000() {
    ctx(MARKET, 0, 0, 0);
    let mut c = config(0);
    c.audit_fee_bps = 10_001;
    Contract::new(c);
}

#[test]
#[should_panic(expected = "config: max_slots must be 1..=8")]
fn config_rejects_slots_over_8() {
    ctx(MARKET, 0, 0, 0);
    let mut c = config(0);
    c.max_slots = 9;
    Contract::new(c);
}

#[test]
#[should_panic(expected = "config: min_phase_ms must be <= max_phase_ms")]
fn config_rejects_inverted_phase_bounds() {
    ctx(MARKET, 0, 0, 0);
    let mut c = config(0);
    c.min_phase_ms = 10;
    c.max_phase_ms = 9;
    Contract::new(c);
}

#[test]
fn post_job_validation() {
    type Case = (&'static str, Box<dyn Fn(&mut Contract)>);
    let cases: Vec<Case> = vec![
        (
            "repo: must start with https://",
            Box::new(|c| {
                c.post_job(
                    "t".into(),
                    "http://x".into(),
                    "abcdef1".into(),
                    "".into(),
                    steps(1),
                    1,
                    U128(1),
                    U128(1),
                    1000,
                    1000,
                    1000,
                    1000,
                );
            }),
        ),
        (
            "commit: must be 7 to 40 lowercase hex chars",
            Box::new(|c| {
                c.post_job(
                    "t".into(),
                    "https://x".into(),
                    "ABCDEF1".into(),
                    "".into(),
                    steps(1),
                    1,
                    U128(1),
                    U128(1),
                    1000,
                    1000,
                    1000,
                    1000,
                );
            }),
        ),
        (
            "path: must be a relative subdirectory",
            Box::new(|c| {
                c.post_job(
                    "t".into(),
                    "https://x".into(),
                    "abcdef1".into(),
                    "a/../b".into(),
                    steps(1),
                    1,
                    U128(1),
                    U128(1),
                    1000,
                    1000,
                    1000,
                    1000,
                );
            }),
        ),
        (
            "steps: need 1 to 12 steps",
            Box::new(|c| {
                c.post_job(
                    "t".into(),
                    "https://x".into(),
                    "abcdef1".into(),
                    "".into(),
                    steps(13),
                    1,
                    U128(1),
                    U128(1),
                    1000,
                    1000,
                    1000,
                    1000,
                );
            }),
        ),
        (
            "slots: must be 1 to 5",
            Box::new(|c| {
                c.post_job(
                    "t".into(),
                    "https://x".into(),
                    "abcdef1".into(),
                    "".into(),
                    steps(1),
                    6,
                    U128(1),
                    U128(1),
                    1000,
                    1000,
                    1000,
                    1000,
                );
            }),
        ),
        (
            "bond: must be at least 1 yocto",
            Box::new(|c| {
                c.post_job(
                    "t".into(),
                    "https://x".into(),
                    "abcdef1".into(),
                    "".into(),
                    steps(1),
                    1,
                    U128(0),
                    U128(1),
                    1000,
                    1000,
                    1000,
                    1000,
                );
            }),
        ),
        (
            "run_ms: must be within [1000, 600000] ms",
            Box::new(|c| {
                c.post_job(
                    "t".into(),
                    "https://x".into(),
                    "abcdef1".into(),
                    "".into(),
                    steps(1),
                    1,
                    U128(1),
                    U128(1),
                    1000,
                    999,
                    1000,
                    1000,
                );
            }),
        ),
        (
            "bounty: need",
            Box::new(|c| {
                c.post_job(
                    "t".into(),
                    "https://x".into(),
                    "abcdef1".into(),
                    "".into(),
                    steps(1),
                    1,
                    U128(1),
                    U128(1_000 * NEAR),
                    1000,
                    1000,
                    1000,
                    1000,
                );
            }),
        ),
        (
            "steps: every do and see must be 1 to 400 chars",
            Box::new(|c| {
                let s = vec![Step { act: "x".repeat(401), see: "y".into() }];
                c.post_job("t".into(), "https://x".into(), "abcdef1".into(), "".into(), s, 1, U128(1), U128(1), 1000, 1000, 1000, 1000);
            }),
        ),
    ];
    for (msg, f) in cases {
        let mut c = setup(0);
        fund(&mut c, POSTER, 10);
        ctx(POSTER, 0, 0, 0);
        let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&mut c))).expect_err(msg);
        let text = err.downcast_ref::<String>().cloned().or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string())).unwrap();
        assert!(text.contains(msg), "expected {msg:?}, got {text:?}");
    }
}

#[test]
fn honest_job_settles_and_conserves_value() {
    let mut c = setup(0);
    worker(&mut c, "a.testnet");
    worker(&mut c, "b.testnet");
    let id = post(&mut c, 3, 2, NEAR, 9 * NEAR);
    assert_eq!(job(&c, id).phase, "Open");
    let start: u128 = ["a.testnet", "b.testnet", POSTER].iter().map(|w| total_of(&c, w)).sum::<u128>() + 9 * NEAR;
    for w in ["a.testnet", "b.testnet"] {
        ctx(w, 100, 0, 0);
        c.claim(id);
    }
    assert_eq!(locked(&c, "a.testnet"), NEAR);
    assert_eq!(job(&c, id).phase, "Committing", "full: claim phase over, commits pending");
    ctx("a.testnet", 200, 0, 0);
    c.commit(id, hash_of(id, "a.testnet", &[P, P, P]));
    ctx("b.testnet", 300, 0, 0);
    c.commit(id, hash_of(id, "b.testnet", &[P, P, P]));
    assert!(job(&c, id).reveal_open, "full and every claimant committed: reveal opens early");
    assert_eq!(job(&c, id).phase, "Revealing");
    ctx("a.testnet", 400, 0, 0);
    c.reveal(id, vec![P, P, P], TX_HASH.into(), "ipfs://a".into(), SALT.into());
    ctx("b.testnet", 500, 0, 0);
    c.reveal(id, vec![P, P, P], TX_HASH.into(), "ipfs://b".into(), SALT.into());
    let j = job(&c, id);
    assert_eq!(j.phase, "Reported");
    assert!(j.rounds.is_empty());
    assert_eq!(j.challenge_until, Some(10_500));
    assert!(!j.finalize_ready);

    // the storage of a finalize is charged to its caller: use a keeper with its own balance
    fund(&mut c, "keeper.testnet", 1);
    let keeper0 = free(&c, "keeper.testnet");
    ctx("keeper.testnet", 10_500, 0, 0);
    c.finalize(id);
    let storage = keeper0 - free(&c, "keeper.testnet");
    let j = job(&c, id);
    assert_eq!(j.phase, "Finalized");
    assert_eq!(j.final_verdicts, Some(vec![P, P, P]));
    assert_eq!(j.claims.iter().map(|x| x.earned.0).collect::<Vec<_>>(), vec![9 * NEAR / 2, 9 * NEAR / 2]);
    assert!(j.claims.iter().all(|x| x.status == ClaimStatus::Paid));
    assert_eq!(locked(&c, "a.testnet"), 0);
    let end: u128 = ["a.testnet", "b.testnet", POSTER].iter().map(|w| total_of(&c, w)).sum();
    // nothing created or lost: the bounty moved from escrow to the workers (minus the storage the
    // claim/commit/reveal calls paid for)
    assert!(end <= start && start - end < NEAR / 10, "start {start} end {end}");
    assert!(storage < NEAR / 100);
    assert_eq!(c.get_account(acct("a.testnet")).stats.paid_jobs, 1);
    assert!(get_logs().iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"job_finalized\"")));
}

#[test]
#[should_panic(expected = "already finalized")]
fn finalize_twice_panics() {
    let mut c = setup(0);
    worker(&mut c, "a.testnet");
    let id = post(&mut c, 1, 1, NEAR, NEAR);
    ctx("a.testnet", 1, 0, 0);
    c.claim(id);
    commit_reveal(&mut c, id, "a.testnet", &[P], 2, 3, 0);
    ctx("a.testnet", 20_000, 0, 0);
    c.finalize(id);
    c.finalize(id);
}

#[test]
fn disagreement_audit_slashes_the_liar_and_pays_the_fee() {
    let mut c = setup(0);
    worker(&mut c, "honest.testnet");
    worker(&mut c, "liar.testnet");
    verifier(&mut c, "v1.testnet");
    verifier(&mut c, "v2.testnet");
    let id = post(&mut c, 2, 2, NEAR, 10 * NEAR);
    for w in ["honest.testnet", "liar.testnet"] {
        ctx(w, 1, 0, 0);
        c.claim(id);
    }
    commit_reveal(&mut c, id, "honest.testnet", &[P, F], 2, 20_000, 5);
    commit_reveal(&mut c, id, "liar.testnet", &[P, P], 3, 20_001, 5);
    let j = job(&c, id);
    assert_eq!(j.status, JobStatus::Auditing);
    assert_eq!(j.rounds[0].reason, Reason::Disagreement);
    let v = j.rounds[0].verifier.clone().unwrap();
    let other = if v.as_str() == "v1.testnet" { "v2.testnet" } else { "v1.testnet" };
    assert_eq!(j.rounds[0].deadline, 20_001 + 20_000);
    let burned0 = c.total_burned().0;
    ctx(v.as_str(), 25_000, 0, 0);
    c.verify(id, vec![P, F], TX_HASH.into(), "ipfs://v".into());
    assert_eq!(job(&c, id).challenge_until, Some(35_000));
    let v_free = free(&c, v.as_str());
    ctx(other, 35_000, 0, 0);
    c.finalize(id);
    let j = job(&c, id);
    assert_eq!(j.final_verdicts, Some(vec![P, F]));
    assert_eq!(j.claims[1].status, ClaimStatus::Slashed);
    assert_eq!(j.claims[0].status, ClaimStatus::Paid);
    assert_eq!(c.total_burned().0, burned0 + NEAR);
    // fee 10% = 1 NEAR to the verifier; pool 9 NEAR over 2 steps, the honest worker matched both
    assert_eq!(free(&c, v.as_str()), v_free + NEAR);
    assert_eq!(j.claims[0].earned.0, 9 * NEAR);
    assert_eq!(j.claims[1].earned.0, 0);
    assert_eq!(c.get_account(acct("liar.testnet")).stats.slashes, 1);
    assert_eq!(c.get_account(acct("liar.testnet")).stats.burned.0, NEAR);
    assert_eq!(c.get_account(v.clone()).active_audits, 0, "released at finalize");
    assert!(j.burns.iter().any(|b| b.kind == BurnKind::Slash && b.account.as_str() == "liar.testnet"));
}

/// Liar and honest worker disagree; the drawn verifier colludes with the liar; the honest worker
/// appeals; the round-2 verifier overrules. Returns (contract, job id, v1, v2).
fn appeal_case(r2_verdicts: Vec<Verdict>) -> (Contract, u64, AccountId, AccountId) {
    let mut c = setup(0);
    worker(&mut c, "honest.testnet");
    worker(&mut c, "liar.testnet");
    for v in ["v1.testnet", "v2.testnet", "v3.testnet"] {
        verifier(&mut c, v);
    }
    let id = post(&mut c, 2, 2, NEAR, 10 * NEAR);
    for w in ["honest.testnet", "liar.testnet"] {
        ctx(w, 1, 0, 0);
        c.claim(id);
    }
    commit_reveal(&mut c, id, "honest.testnet", &[P, F], 2, 20_000, 1);
    commit_reveal(&mut c, id, "liar.testnet", &[P, P], 3, 20_001, 1);
    let v1 = job(&c, id).rounds[0].verifier.clone().unwrap();
    ctx(v1.as_str(), 20_002, 0, 1);
    c.verify(id, vec![P, P], TX_HASH.into(), "ipfs://v1".into());
    // v1 cannot run away from the appeal: it stays engaged until the job is settled
    ctx(v1.as_str(), 20_003, 0, 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.leave_verifier())).is_err());
    ctx("honest.testnet", 20_004, 0, 2);
    c.challenge(id);
    let j = job(&c, id);
    assert_eq!(j.rounds.len(), 2);
    let v2 = j.rounds[1].verifier.clone().unwrap();
    assert_ne!(v1, v2, "the round-2 verifier differs from the first");
    ctx(v2.as_str(), 20_005, 0, 2);
    c.verify(id, r2_verdicts, TX_HASH.into(), "ipfs://v2".into());
    (c, id, v1, v2)
}

#[test]
fn appeal_overrules_a_colluding_verifier() {
    let (mut c, id, v1, v2) = appeal_case(vec![P, F]);
    assert!(job(&c, id).finalize_ready, "round 2 is final at once");
    let honest0 = free(&c, "honest.testnet");
    let v2_free = free(&c, v2.as_str());
    let burned0 = c.total_burned().0;
    fund(&mut c, "keeper.testnet", 1);
    ctx("keeper.testnet", 20_006, 0, 0);
    c.finalize(id);
    let j = job(&c, id);
    assert_eq!(j.final_verdicts, Some(vec![P, F]));
    assert_eq!(j.claims[1].status, ClaimStatus::Slashed);
    // liar's bond and v1's verifier bond burned; v1 out of the pool
    assert_eq!(c.total_burned().0, burned0 + NEAR + 2 * NEAR);
    let a1 = c.get_account(v1.clone());
    assert_eq!(a1.role, None);
    assert_eq!(a1.verifier_bond.0, 0);
    assert_eq!(a1.stats.overruled, 1);
    assert!(!c.list_verifiers().iter().any(|m| m.account_id == v1));
    // v2 gets the fee, the challenger's bond comes back, the honest worker gets the whole pool
    assert_eq!(free(&c, v2.as_str()), v2_free + NEAR);
    assert_eq!(free(&c, "honest.testnet"), honest0 + NEAR / 2 + NEAR + 9 * NEAR);
    assert!(j.payouts.iter().any(|p| p.kind == PayoutKind::ChallengeReturn && p.account.as_str() == "honest.testnet"));
    assert!(j.burns.iter().any(|b| b.kind == BurnKind::Overruled && b.account == v1));
}

#[test]
fn failed_appeal_pays_the_bond_to_the_round_two_verifier() {
    // round 2 agrees with round 1: the appeal was wrong
    let (mut c, id, v1, v2) = appeal_case(vec![P, P]);
    let v1_free = free(&c, v1.as_str());
    let v2_free = free(&c, v2.as_str());
    fund(&mut c, "keeper.testnet", 1);
    ctx("keeper.testnet", 20_006, 0, 0);
    c.finalize(id);
    let j = job(&c, id);
    assert_eq!(j.final_verdicts, Some(vec![P, P]));
    assert_eq!(j.claims[0].status, ClaimStatus::Slashed, "the appellant contradicted the final verdicts");
    assert_eq!(free(&c, v1.as_str()), v1_free + NEAR, "round-1 verifier keeps the fee");
    assert_eq!(free(&c, v2.as_str()), v2_free + NEAR / 2, "round-2 verifier gets the challenge bond");
    assert!(j.payouts.iter().any(|p| p.kind == PayoutKind::ChallengeAward && p.account == v2));
}

#[test]
fn dispute_bond_follows_the_round_one_ruling() {
    // unanimous Pass reports, the poster disputes; the verifier finds a Fail: the dispute was right
    let mut c = setup(0);
    worker(&mut c, "a.testnet");
    verifier(&mut c, "v1.testnet");
    let id = post(&mut c, 1, 1, NEAR, 10 * NEAR);
    ctx("a.testnet", 1, 0, 0);
    c.claim(id);
    commit_reveal(&mut c, id, "a.testnet", &[P], 2, 3, 0);
    let poster0 = free(&c, POSTER);
    ctx(POSTER, 4, 0, 0);
    c.challenge(id);
    let j = job(&c, id);
    assert_eq!(j.rounds[0].reason, Reason::Challenge);
    assert_eq!(j.rounds[0].challenger.as_ref().map(|a| a.as_str()), Some(POSTER));
    ctx("v1.testnet", 5, 0, 0);
    c.verify(id, vec![F], TX_HASH.into(), "".into());
    ctx(POSTER, 6 + 10_000, 0, 0);
    c.finalize(id);
    let j = job(&c, id);
    assert_eq!(j.claims[0].status, ClaimStatus::Slashed);
    // the dispute bond is unlocked; the pool (9 NEAR) had no matching report: back to the poster
    assert!(j.payouts.iter().any(|p| p.kind == PayoutKind::ChallengeReturn));
    assert!(free(&c, POSTER) >= poster0 + 9 * NEAR - NEAR / 100);
}

#[test]
fn no_show_verifier_is_replaced_then_no_ruling() {
    let mut c = setup(10_000);
    worker(&mut c, "a.testnet");
    for v in ["v1.testnet", "v2.testnet", "v3.testnet", "v4.testnet"] {
        verifier(&mut c, v);
    }
    let id = post(&mut c, 1, 1, NEAR, 10 * NEAR);
    ctx("a.testnet", 1, 0, 0);
    c.claim(id);
    commit_reveal(&mut c, id, "a.testnet", &[P], 2, 3, 7);
    let mut t = 3;
    let mut seen = vec![];
    for attempt in 0..=MAX_REDRAWS {
        let j = job(&c, id);
        assert_eq!(j.rounds[0].reason, Reason::Sample, "audit_bps = 10000: unanimous reports are audited");
        assert_eq!(j.rounds[0].attempt, attempt);
        let v = j.rounds[0].verifier.clone().unwrap();
        assert!(!seen.contains(&v), "a replaced verifier is never drawn again on the job");
        seen.push(v.clone());
        t = j.rounds[0].deadline;
        ctx("a.testnet", t - 1, 0, attempt + 10);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.advance(id))).is_err(), "not before the deadline");
        ctx("a.testnet", t, 0, attempt + 10);
        c.advance(id);
        let a = c.get_account(v.clone());
        assert_eq!(a.role, None, "a no-show verifier leaves the pool");
        assert_eq!(a.verifier_bond.0, 0);
        assert_eq!(a.stats.no_shows, 1);
    }
    let j = job(&c, id);
    assert_eq!(j.rounds[0].outcome, "no_ruling");
    assert_eq!(j.rounds[0].replaced.len(), 3);
    assert!(j.finalize_ready, "a no-ruling round can be finalized at once");
    assert_eq!(c.total_burned().0, 3 * 2 * NEAR);
    ctx("a.testnet", t, 0, 0);
    c.finalize(id);
    let j = job(&c, id);
    assert_eq!(j.final_verdicts, Some(vec![P]), "no ruling: the unanimous reports stand");
    assert_eq!(j.claims[0].earned.0, 10 * NEAR, "no fee without a ruling");
}

#[test]
fn no_show_workers_burn_and_an_unrevealed_job_expires() {
    let mut c = setup(0);
    worker(&mut c, "a.testnet");
    worker(&mut c, "b.testnet");
    let id = post(&mut c, 1, 2, NEAR, 4 * NEAR);
    ctx("a.testnet", 1, 0, 0);
    c.claim(id);
    ctx("b.testnet", 1, 0, 0);
    c.claim(id);
    ctx("a.testnet", 2, 0, 0);
    c.commit(id, hash_of(id, "a.testnet", &[P]));
    let poster0 = free(&c, POSTER);
    fund(&mut c, "x.testnet", 1);
    ctx("x.testnet", 29_999, 0, 0);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.advance(id))).is_err());
    ctx("x.testnet", 30_000, 0, 0);
    assert!(job(&c, id).advance_due);
    assert_eq!(job(&c, id).phase, "Expired");
    c.advance(id);
    let j = job(&c, id);
    assert_eq!(j.status, JobStatus::Expired);
    assert!(j.claims.iter().all(|x| x.status == ClaimStatus::NoShow));
    assert_eq!(c.total_burned().0, 2 * NEAR);
    assert_eq!(free(&c, POSTER), poster0 + 4 * NEAR);
    assert_eq!(c.get_account(acct("a.testnet")).active_claims, 0);
    // the worker can leave now: no active claims
    ctx("a.testnet", 30_001, 0, 0);
    c.leave_worker();
    assert_eq!(c.get_account(acct("a.testnet")).role, None);
}

#[test]
fn an_empty_pool_resolves_as_no_ruling() {
    let mut c = setup(0);
    worker(&mut c, "a.testnet");
    worker(&mut c, "b.testnet");
    let id = post(&mut c, 2, 2, NEAR, 10 * NEAR);
    for w in ["a.testnet", "b.testnet"] {
        ctx(w, 1, 0, 0);
        c.claim(id);
    }
    commit_reveal(&mut c, id, "a.testnet", &[P, F], 2, 20_000, 0);
    commit_reveal(&mut c, id, "b.testnet", &[P, P], 3, 20_001, 0);
    let j = job(&c, id);
    assert_eq!(j.rounds[0].outcome, "no_ruling");
    assert!(j.finalize_ready);
    ctx("a.testnet", 20_002, 0, 0);
    c.finalize(id);
    let j = job(&c, id);
    assert_eq!(j.final_verdicts, Some(vec![P, U]));
    assert!(j.claims.iter().all(|x| x.status == ClaimStatus::Paid), "Unverifiable never contradicts");
    // step 0 (5 NEAR) split by both; step 1 final Unverifiable matched nobody: back to the poster
    assert_eq!(j.claims[0].earned.0, 5 * NEAR / 2);
    assert!(j.payouts.iter().any(|p| p.kind == PayoutKind::Refund && p.amount.0 == 5 * NEAR));
}

#[test]
fn withdraw_only_free_balance() {
    let mut c = setup(0);
    worker(&mut c, "a.testnet");
    let f = free(&c, "a.testnet");
    ctx("a.testnet", 1, 0, 0);
    let msg = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.withdraw(Some(U128(f + 1)));
    }))
    .expect_err("more than free");
    assert!(msg.downcast_ref::<String>().unwrap().contains("withdraw: only free balance can be withdrawn"));
    ctx("a.testnet", 1, 0, 0);
    let _ = c.withdraw(None);
    assert_eq!(free(&c, "a.testnet"), 0);
    assert_eq!(c.get_account(acct("a.testnet")).worker_bond.0, NEAR, "the standing bond stays");
}
