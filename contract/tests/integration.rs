// Integration tests on local near-sandbox nodes: the real wasm, real accounts, real transactions.
// Each test starts its own sandbox (at most PM_SANDBOXES at once, default 6). Every happy path and
// every cheat from docs/SPEC.md "Tests that must exist" is here, and each cheat asserts its panic
// text (or, for function-call keys, the protocol error variant).
// `Env::ok` asserts success itself, so its returned outcome may be dropped.
#![allow(unused_must_use)]
use futures::future::join_all;
use near_api::types::AccessKeyPermission;
use near_api::types::transaction::actions::FunctionCallPermission;
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::{AccountId, NearGas, NearToken, NetworkConfig, Signer};
use near_sandbox::{GenesisAccount, SandboxConfig};
use near_sdk::serde::de::DeserializeOwned;
use near_sdk::serde_json::{self, Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::{Semaphore, SemaphorePermit};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const WORKER_BOND: u128 = NEAR;
const VERIFIER_BOND: u128 = 2 * NEAR;
const CHALLENGE_BOND: u128 = NEAR / 2;
const FEE_BPS: u128 = 1000;
const TX_HASH: &str = "5f2b9c0e7d1a4b3c8e6f0a9d2c4b6e8f1a3c5e7b9d0f2a4c6e8b0d2f4a6c8e0a";
const SALT: &str = "00112233445566778899aabbccddeeff";
const PASS: &str = "Pass";
const FAIL: &str = "Fail";

// ---------- harness ----------

fn sandboxes() -> &'static Semaphore {
    static S: OnceLock<Semaphore> = OnceLock::new();
    S.get_or_init(|| Semaphore::new(std::env::var("PM_SANDBOXES").ok().and_then(|v| v.parse().ok()).unwrap_or(6)))
}

/// The contract wasm, built once per test process with cargo-near (same as `cargo near build`).
fn wasm() -> Vec<u8> {
    static WASM: OnceLock<Vec<u8>> = OnceLock::new();
    WASM.get_or_init(|| std::fs::read(cargo_near_build::build_with_cli(Default::default()).expect("wasm build")).expect("read wasm"))
        .clone()
}

fn id(name: &str) -> AccountId {
    format!("{name}.sandbox").parse().unwrap()
}

fn config(audit_bps: u16) -> Value {
    json!({
        "min_worker_bond": WORKER_BOND.to_string(),
        "verifier_bond": VERIFIER_BOND.to_string(),
        "challenge_bond": CHALLENGE_BOND.to_string(),
        "audit_bps": audit_bps,
        "audit_fee_bps": FEE_BPS,
        "max_steps": 12,
        "max_slots": 5,
        "min_phase_ms": 1000,
        "max_phase_ms": 600_000,
    })
}

fn u(v: &Value) -> u128 {
    v.as_str().unwrap_or_else(|| panic!("expected a U128 string, got {v}")).parse().unwrap()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The commit hash, computed independently of the contract (sha2 here, env::sha256 there).
fn report_hash(market: &AccountId, job_id: u64, worker: &AccountId, verdicts: &[&str]) -> String {
    let csv = verdicts.iter().map(|v| &v[..1]).collect::<Vec<_>>().join(",");
    let pre = format!("proof-market report v1|{market}|{job_id}|{worker}|{csv}|{TX_HASH}|{SALT}");
    hex(&Sha256::digest(pre.as_bytes()))
}

fn reveal_args(job_id: u64, verdicts: &[&str]) -> Value {
    json!({ "job_id": job_id, "verdicts": verdicts, "transcript_hash": TX_HASH, "transcript_uri": format!("https://transcripts.example/{job_id}"), "salt": SALT })
}

fn verify_args(job_id: u64, verdicts: &[&str]) -> Value {
    json!({ "job_id": job_id, "verdicts": verdicts, "transcript_hash": TX_HASH, "transcript_uri": "https://transcripts.example/audit" })
}

fn steps(n: usize) -> Value {
    json!((0..n).map(|i| json!({ "do": format!("run step {i}"), "see": format!("output {i}") })).collect::<Vec<_>>())
}

fn job_args(title: &str, steps: Value, slots: u8, bond: u128, bounty: u128, phases: [u64; 4]) -> Value {
    json!({
        "title": title, "repo": "https://github.com/example/demo", "commit": "0123abcd", "path": "",
        "steps": steps, "slots": slots, "bond": bond.to_string(), "bounty": bounty.to_string(),
        "claim_ms": phases[0], "run_ms": phases[1], "reveal_ms": phases[2], "window_ms": phases[3],
    })
}

/// The claim of `worker` inside a get_job view.
fn claim_of<'a>(job: &'a Value, worker: &AccountId) -> &'a Value {
    job["claims"].as_array().unwrap().iter().find(|c| c["worker"] == json!(worker)).unwrap_or_else(|| panic!("no claim of {worker}"))
}

fn has_payout(job: &Value, account: &AccountId, kind: &str, amount: u128) -> bool {
    job["payouts"].as_array().unwrap().iter().any(|p| p["account"] == json!(account) && p["kind"] == kind && u(&p["amount"]) == amount)
}

fn has_burn(job: &Value, account: &AccountId, kind: &str, amount: u128) -> bool {
    job["burns"].as_array().unwrap().iter().any(|b| b["account"] == json!(account) && b["kind"] == kind && u(&b["amount"]) == amount)
}

struct Env {
    sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    market: AccountId,
    _permit: SemaphorePermit<'static>,
}

impl Env {
    /// Start a sandbox whose genesis holds `market` plus `names` (10 000 NEAR each, one shared key)
    /// and deploy the market with `audit_bps`.
    async fn start(audit_bps: u16, names: &[&str]) -> Env {
        let permit = sandboxes().acquire().await.unwrap();
        let code = tokio::task::spawn_blocking(wasm).await.unwrap();
        let mut all = vec!["market".to_string(), "other".to_string()];
        all.extend(names.iter().map(|s| s.to_string()));
        let cfg = SandboxConfig {
            additional_accounts: all.iter().map(|n| GenesisAccount::default_with_name(format!("{n}.sandbox").parse().unwrap())).collect(),
            ..Default::default()
        };
        let sandbox = near_sandbox::Sandbox::start_sandbox_with_config(cfg).await.expect("sandbox");
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse().unwrap());
        let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse().unwrap()).unwrap();
        let env = Env { sandbox, net, signer, market: id("market"), _permit: permit };
        env.deploy(&env.market, code, audit_bps).await;
        env
    }

    async fn deploy(&self, at: &AccountId, code: Vec<u8>, audit_bps: u16) {
        near_api::Contract::deploy(at.clone())
            .use_code(code)
            .with_init_call("new", json!({ "config": config(audit_bps) }))
            .unwrap()
            .with_signer(self.signer.clone())
            .send_to(&self.net)
            .await
            .unwrap()
            .assert_success();
    }

    async fn call(&self, who: &AccountId, method: &str, args: Value, deposit: u128) -> ExecutionFinalResult {
        near_api::Contract(self.market.clone())
            .call_function(method, args)
            .transaction()
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(NearGas::from_tgas(300))
            .with_signer(who.clone(), self.signer.clone())
            .send_to(&self.net)
            .await
            .unwrap()
            .into_full()
            .unwrap()
    }

    /// A call that must succeed.
    async fn ok(&self, who: &AccountId, method: &str, args: Value, deposit: u128) -> ExecutionFinalResult {
        let r = self.call(who, method, args, deposit).await;
        if let Err(e) = r.clone().into_result() {
            panic!("{method} by {who} should succeed: {e}");
        }
        r
    }

    /// A call that must fail with a panic message containing `expected`.
    async fn fails(&self, who: &AccountId, method: &str, args: Value, deposit: u128, expected: &str) {
        match self.call(who, method, args, deposit).await.into_result() {
            Ok(_) => panic!("{method} by {who} should fail with {expected:?}, but it succeeded"),
            Err(e) => {
                let text = e.to_string();
                assert!(text.contains(expected), "{method} by {who}: expected a panic containing {expected:?}, got {text}");
            }
        }
    }

    async fn view<T: DeserializeOwned + Send + Sync>(&self, method: &str, args: Value) -> T {
        near_api::Contract(self.market.clone()).call_function(method, args).read_only().fetch_from(&self.net).await.unwrap().data
    }

    async fn job(&self, job_id: u64) -> Value {
        self.view("get_job", json!({ "job_id": job_id })).await
    }

    async fn account(&self, who: &AccountId) -> Value {
        self.view("get_account", json!({ "account_id": who })).await
    }

    async fn free(&self, who: &AccountId) -> u128 {
        u(&self.account(who).await["free"])
    }

    async fn locked(&self, who: &AccountId) -> u128 {
        u(&self.account(who).await["locked"])
    }

    async fn burned(&self) -> u128 {
        u(&self.view::<Value>("total_burned", json!({})).await)
    }

    async fn native(&self, who: &AccountId) -> u128 {
        near_api::Tokens::account(who.clone()).near_balance().fetch_from(&self.net).await.unwrap().total.as_yoctonear()
    }

    async fn now(&self) -> u64 {
        self.view("block_time_ms", json!({})).await
    }

    /// Advance the chain clock to at least `t` (fast-forwarding blocks for long gaps).
    async fn wait_until(&self, t: u64) {
        loop {
            let now = self.now().await;
            if now >= t {
                return;
            }
            let gap = t - now;
            if gap > 2500 {
                self.sandbox.fast_forward((gap / 500).max(1)).await.unwrap();
            } else {
                tokio::time::sleep(Duration::from_millis(gap + 100)).await;
            }
        }
    }

    /// Register workers concurrently; `register_worker` is payable, so the deposit rides along.
    async fn workers(&self, ws: &[&AccountId]) {
        join_all(
            ws.iter().map(|w| self.ok(w, "register_worker", json!({ "label": format!("{w} agent"), "model": "test-model-1" }), 10 * NEAR)),
        )
        .await;
    }

    async fn verifiers(&self, vs: &[&AccountId]) {
        join_all(
            vs.iter()
                .map(|v| self.ok(v, "register_verifier", json!({ "label": format!("{v} auditor"), "model": "test-model-2" }), 5 * NEAR)),
        )
        .await;
    }

    async fn post(&self, poster: &AccountId, args: Value) -> u64 {
        let bounty = u(&args["bounty"]);
        self.ok(poster, "post_job", args, bounty + NEAR).await.json::<u64>().unwrap()
    }

    async fn claim_all(&self, job_id: u64, ws: &[&AccountId]) {
        join_all(ws.iter().map(|w| self.ok(w, "claim", json!({ "job_id": job_id }), 0))).await;
    }

    async fn commit_all(&self, job_id: u64, reports: &[(&AccountId, &[&str])]) {
        join_all(
            reports
                .iter()
                .map(|(w, v)| self.ok(w, "commit", json!({ "job_id": job_id, "hash": report_hash(&self.market, job_id, w, v) }), 0)),
        )
        .await;
    }

    async fn reveal_all(&self, job_id: u64, reports: &[(&AccountId, &[&str])]) {
        join_all(reports.iter().map(|(w, v)| self.ok(w, "reveal", reveal_args(job_id, v), 0))).await;
    }

    /// The verifier currently drawn on the job's last round.
    async fn drawn(&self, job_id: u64) -> AccountId {
        let j = self.job(job_id).await;
        let r = j["rounds"].as_array().unwrap().last().unwrap().clone();
        r["verifier"].as_str().unwrap_or_else(|| panic!("no verifier drawn: {r}")).parse().unwrap()
    }

    async fn in_pool(&self, who: &AccountId) -> bool {
        self.view::<Vec<Value>>("list_verifiers", json!({})).await.iter().any(|m| m["account_id"] == json!(who))
    }
}

fn logs_have(r: &ExecutionFinalResult, event: &str) -> bool {
    r.logs().iter().any(|l| {
        l.starts_with("EVENT_JSON:{") && l.contains("\"standard\":\"proof_market\"") && l.contains(&format!("\"event\":\"{event}\""))
    })
}

// ---------- happy paths ----------

/// SPEC happy path 1, plus: finalize early, finalize twice, challenge after the window, withdraw.
#[tokio::test]
async fn happy_1_honest_job_unaudited() {
    let e = Env::start(0, &["poster", "w1", "w2", "keeper"]).await;
    let (poster, w1, w2, keeper) = (id("poster"), id("w1"), id("w2"), id("keeper"));
    e.workers(&[&w1, &w2]).await;
    e.ok(&keeper, "deposit", json!({}), NEAR).await;
    let job = e.post(&poster, job_args("honest", steps(3), 2, NEAR, 6 * NEAR, [20_000, 20_000, 20_000, 5_000])).await;
    assert_eq!(job, 0);
    assert_eq!(e.job(job).await["phase"], "Open");

    e.claim_all(job, &[&w1, &w2]).await;
    assert_eq!(e.job(job).await["phase"], "Committing", "full: claim phase over, commits pending");
    assert_eq!(e.locked(&w1).await, NEAR, "the job bond is locked");
    let pass3: &[&str] = &[PASS, PASS, PASS];
    e.commit_all(job, &[(&w1, pass3), (&w2, pass3)]).await;
    let j = e.job(job).await;
    assert_eq!(j["phase"], "Revealing", "full and all committed: the reveal phase opens early");
    assert_eq!(j["reveal_open"], true);
    e.reveal_all(job, &[(&w1, pass3), (&w2, pass3)]).await;
    let j = e.job(job).await;
    assert_eq!(j["phase"], "Reported");
    assert_eq!(j["rounds"], json!([]), "audit_bps = 0 and unanimous: unaudited");
    let until = j["challenge_until"].as_u64().unwrap();
    assert_eq!(until, j["reported_at"].as_u64().unwrap() + 5_000);

    // cheat: finalize before the window ends
    e.fails(&keeper, "finalize", json!({ "job_id": job }), 0, "challenge window still open").await;
    e.wait_until(until).await;
    // cheat: challenge after the window
    e.fails(&poster, "challenge", json!({ "job_id": job }), 0, "challenge window closed").await;

    let (f1, f2) = (e.free(&w1).await, e.free(&w2).await);
    let r = e.ok(&keeper, "finalize", json!({ "job_id": job }), 0).await;
    assert!(logs_have(&r, "job_finalized"));
    let j = e.job(job).await;
    assert_eq!(j["phase"], "Finalized");
    assert_eq!(j["final_verdicts"], json!([PASS, PASS, PASS]));
    // 6 NEAR over 3 steps = 2 NEAR a step, split by the two matching reports
    for w in [&w1, &w2] {
        let c = claim_of(&j, w);
        assert_eq!(c["status"], "paid");
        assert_eq!(u(&c["earned"]), 3 * NEAR);
        assert!(has_payout(&j, w, "bounty", 3 * NEAR));
        assert!(has_payout(&j, w, "bond_return", NEAR));
        assert_eq!(e.locked(w).await, 0, "the bond is back");
    }
    assert_eq!(e.free(&w1).await, f1 + NEAR + 3 * NEAR);
    assert_eq!(e.free(&w2).await, f2 + NEAR + 3 * NEAR);
    assert_eq!(e.burned().await, 0);
    assert_eq!(e.account(&w1).await["stats"]["paid_jobs"], 1);

    // cheat: finalize twice
    e.fails(&keeper, "finalize", json!({ "job_id": job }), 0, "already finalized").await;

    // the worker pulls its free balance out for real
    let n0 = e.native(&w1).await;
    let f = e.free(&w1).await;
    e.ok(&w1, "withdraw", json!({}), 0).await;
    assert_eq!(e.free(&w1).await, 0);
    let n1 = e.native(&w1).await;
    assert!(n1 > n0 + f - NEAR / 100, "withdraw pays the free balance out: {n0} -> {n1}, free was {f}");

    let list: Vec<Value> = e.view("list_jobs", json!({})).await;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["phase"], "Finalized");
    assert_eq!(list[0]["claims_count"], 2);
}

/// SPEC happy path 2, plus: verify by a verifier that was not drawn, by a worker, by the poster.
#[tokio::test]
async fn happy_2_disagreement_audit_slashes_the_liar() {
    let e = Env::start(0, &["poster", "honest", "liar", "v1", "v2", "v3", "keeper"]).await;
    let (poster, honest, liar, keeper) = (id("poster"), id("honest"), id("liar"), id("keeper"));
    let vs = [id("v1"), id("v2"), id("v3")];
    e.workers(&[&honest, &liar]).await;
    // the poster is a registered verifier too: it must never verify its own job
    e.verifiers(&[&vs[0], &vs[1], &vs[2], &poster]).await;
    e.ok(&keeper, "deposit", json!({}), NEAR).await;
    let job = e.post(&poster, job_args("disagree", steps(2), 2, NEAR, 10 * NEAR, [20_000, 20_000, 20_000, 5_000])).await;
    e.claim_all(job, &[&honest, &liar]).await;
    // step 1 really fails: the honest worker says so, the liar claims Pass
    let truth: &[&str] = &[PASS, FAIL];
    let lie: &[&str] = &[PASS, PASS];
    e.commit_all(job, &[(&honest, truth), (&liar, lie)]).await;
    e.reveal_all(job, &[(&honest, truth), (&liar, lie)]).await;
    let j = e.job(job).await;
    assert_eq!(j["phase"], "Auditing");
    assert_eq!(j["rounds"][0]["reason"], "disagreement");
    assert_eq!(j["rounds"][0]["outcome"], "pending");
    let v = e.drawn(job).await;
    assert!(vs.contains(&v), "drawn from the pool, never the poster: {v}");

    let other = vs.iter().find(|x| **x != v).unwrap();
    e.fails(other, "verify", verify_args(job, truth), 0, "not the drawn verifier").await;
    e.fails(&honest, "verify", verify_args(job, truth), 0, "a claimant cannot verify its own job").await;
    e.fails(&poster, "verify", verify_args(job, truth), 0, "poster cannot verify its own job").await;
    e.fails(&v, "verify", verify_args(job, &[PASS]), 0, "wrong number of verdicts").await;
    let r = e.ok(&v, "verify", verify_args(job, truth), 0).await;
    assert!(logs_have(&r, "audit_ruled"));
    let j = e.job(job).await;
    assert_eq!(j["rounds"][0]["ruling"], json!(truth));
    e.fails(&keeper, "finalize", json!({ "job_id": job }), 0, "challenge window still open").await;
    e.wait_until(j["challenge_until"].as_u64().unwrap()).await;

    let burned0 = e.burned().await;
    let (fh, fv) = (e.free(&honest).await, e.free(&v).await);
    let r = e.ok(&keeper, "finalize", json!({ "job_id": job }), 0).await;
    assert!(logs_have(&r, "worker_slashed"));
    let j = e.job(job).await;
    assert_eq!(j["final_verdicts"], json!(truth));
    assert_eq!(claim_of(&j, &liar)["status"], "slashed");
    assert_eq!(claim_of(&j, &honest)["status"], "paid");
    assert!(has_burn(&j, &liar, "slash", NEAR));
    assert_eq!(e.burned().await, burned0 + NEAR, "the liar's bond is burned");
    let fee = 10 * NEAR * FEE_BPS / 10_000;
    assert!(has_payout(&j, &v, "fee", fee));
    assert_eq!(e.free(&v).await, fv + fee);
    // the honest worker matched both steps alone: the whole pool, plus its bond
    assert_eq!(u(&claim_of(&j, &honest)["earned"]), 10 * NEAR - fee);
    assert_eq!(e.free(&honest).await, fh + NEAR + 10 * NEAR - fee);
    let la = e.account(&liar).await;
    assert_eq!(u(&la["locked"]), 0);
    assert_eq!(la["stats"]["slashes"], 1);
    assert_eq!(u(&la["stats"]["burned"]), NEAR);
    assert_eq!(e.account(&v).await["stats"]["rulings"], 1);
}

/// SPEC happy path 3, plus: verify after the deadline, a no-show verifier replaced via `advance`.
#[tokio::test]
async fn happy_3_sample_audit_and_no_show_verifier() {
    let e = Env::start(10_000, &["poster", "w1", "v1", "v2", "v3", "keeper"]).await;
    let (poster, w1, keeper) = (id("poster"), id("w1"), id("keeper"));
    let vs = [id("v1"), id("v2"), id("v3")];
    e.workers(&[&w1]).await;
    e.verifiers(&[&vs[0], &vs[1], &vs[2]]).await;
    e.ok(&keeper, "deposit", json!({}), NEAR).await;
    // the verifier deadline is run_ms + reveal_ms = 6 s after each draw
    let job = e.post(&poster, job_args("sample", steps(1), 1, NEAR, 4 * NEAR, [20_000, 3_000, 3_000, 3_000])).await;
    e.claim_all(job, &[&w1]).await;
    e.commit_all(job, &[(&w1, &[PASS])]).await;
    e.reveal_all(job, &[(&w1, &[PASS])]).await;
    let j = e.job(job).await;
    assert_eq!(j["phase"], "Auditing", "audit_bps = 10000: a unanimous job is audited anyway");
    assert_eq!(j["rounds"][0]["reason"], "sample");
    let a = e.drawn(job).await;
    let deadline = j["rounds"][0]["deadline"].as_u64().unwrap();
    assert_eq!(deadline, j["rounds"][0]["drawn_at"].as_u64().unwrap() + 6_000);
    e.fails(&keeper, "advance", json!({ "job_id": job }), 0, "nothing to advance").await;

    e.wait_until(deadline).await;
    assert_eq!(e.job(job).await["advance_due"], true);
    e.fails(&a, "verify", verify_args(job, &[PASS]), 0, "audit deadline passed").await;
    let burned0 = e.burned().await;
    let r = e.ok(&keeper, "advance", json!({ "job_id": job }), 0).await;
    assert!(logs_have(&r, "no_show"));
    let j = e.job(job).await;
    let b = e.drawn(job).await;
    assert_ne!(a, b, "a new verifier is drawn for the same round");
    assert_eq!(j["rounds"][0]["attempt"], 1);
    assert_eq!(j["rounds"][0]["replaced"], json!([a]));
    assert!(has_burn(&j, &a, "no_show", VERIFIER_BOND));
    assert_eq!(e.burned().await, burned0 + VERIFIER_BOND);
    let aa = e.account(&a).await;
    assert_eq!(aa["role"], Value::Null, "the no-show leaves the pool");
    assert_eq!(u(&aa["verifier_bond"]), 0);
    assert_eq!(aa["stats"]["no_shows"], 1);
    assert!(!e.in_pool(&a).await);

    e.ok(&b, "verify", verify_args(job, &[PASS]), 0).await;
    e.wait_until(e.job(job).await["challenge_until"].as_u64().unwrap()).await;
    let fb = e.free(&b).await;
    e.ok(&keeper, "finalize", json!({ "job_id": job }), 0).await;
    let j = e.job(job).await;
    let fee = 4 * NEAR * FEE_BPS / 10_000;
    assert_eq!(e.free(&b).await, fb + fee, "the replacement that ruled gets the fee");
    assert_eq!(u(&claim_of(&j, &w1)["earned"]), 4 * NEAR - fee);
}

/// SPEC happy path 4, plus: challenge by a stranger, a second challenge in the same round, and a
/// colluding verifier cannot leave the pool before the appeal is settled.
#[tokio::test]
async fn happy_4_appeal_overrules_a_colluding_verifier() {
    let e = Env::start(0, &["poster", "honest", "liar", "v1", "v2", "v3", "stranger", "keeper"]).await;
    let (poster, honest, liar, stranger, keeper) = (id("poster"), id("honest"), id("liar"), id("stranger"), id("keeper"));
    let vs = [id("v1"), id("v2"), id("v3")];
    e.workers(&[&honest, &liar]).await;
    e.verifiers(&[&vs[0], &vs[1], &vs[2]]).await;
    e.ok(&keeper, "deposit", json!({}), NEAR).await;
    e.ok(&stranger, "deposit", json!({}), NEAR).await;
    let job = e.post(&poster, job_args("appeal", steps(2), 2, NEAR, 10 * NEAR, [20_000, 20_000, 20_000, 20_000])).await;
    e.claim_all(job, &[&honest, &liar]).await;
    let truth: &[&str] = &[PASS, FAIL];
    let lie: &[&str] = &[PASS, PASS];
    e.commit_all(job, &[(&honest, truth), (&liar, lie)]).await;
    e.reveal_all(job, &[(&honest, truth), (&liar, lie)]).await;
    let v1 = e.drawn(job).await;
    // the drawn verifier colludes with the liar
    e.ok(&v1, "verify", verify_args(job, lie), 0).await;
    e.fails(&v1, "leave_verifier", json!({}), 0, "verifier is drawn on an open audit").await;

    e.fails(&stranger, "challenge", json!({ "job_id": job }), 0, "only the poster or a claimant with a revealed report can challenge")
        .await;
    let r = e.ok(&honest, "challenge", json!({ "job_id": job }), 0).await;
    assert!(logs_have(&r, "challenged") && logs_have(&r, "audit_opened"));
    assert_eq!(e.locked(&honest).await, NEAR + CHALLENGE_BOND);
    let v2 = e.drawn(job).await;
    assert_ne!(v1, v2, "the round-2 verifier differs from the first");
    let j = e.job(job).await;
    assert_eq!(j["rounds"][1]["round"], 2);
    assert_eq!(j["rounds"][1]["reason"], "challenge");
    assert_eq!(j["rounds"][1]["challenger"], json!(honest));
    e.fails(&liar, "challenge", json!({ "job_id": job }), 0, "already challenged this round").await;
    e.fails(&poster, "challenge", json!({ "job_id": job }), 0, "already challenged this round").await;

    e.ok(&v2, "verify", verify_args(job, truth), 0).await;
    assert_eq!(e.job(job).await["finalize_ready"], true, "a round-2 ruling is final at once");
    let burned0 = e.burned().await;
    let (fh, f2) = (e.free(&honest).await, e.free(&v2).await);
    let r = e.ok(&keeper, "finalize", json!({ "job_id": job }), 0).await;
    assert!(logs_have(&r, "verifier_overruled") && logs_have(&r, "worker_slashed"));
    let j = e.job(job).await;
    assert_eq!(j["final_verdicts"], json!(truth));
    assert_eq!(claim_of(&j, &liar)["status"], "slashed");
    // the overruled verifier: bond burned, out of the pool, no fee
    assert!(has_burn(&j, &v1, "overruled", VERIFIER_BOND));
    assert!(has_burn(&j, &liar, "slash", NEAR));
    assert_eq!(e.burned().await, burned0 + NEAR + VERIFIER_BOND);
    let a1 = e.account(&v1).await;
    assert_eq!(a1["role"], Value::Null);
    assert_eq!(u(&a1["verifier_bond"]), 0);
    assert_eq!(a1["stats"]["overruled"], 1);
    assert!(!e.in_pool(&v1).await);
    // the round-2 verifier gets the fee, the challenger's bond comes back
    let fee = 10 * NEAR * FEE_BPS / 10_000;
    assert!(has_payout(&j, &v2, "fee", fee));
    assert!(!j["payouts"].as_array().unwrap().iter().any(|p| p["account"] == json!(v1)), "no fee for the overruled verifier");
    assert_eq!(e.free(&v2).await, f2 + fee);
    assert!(has_payout(&j, &honest, "challenge_return", CHALLENGE_BOND));
    assert_eq!(e.locked(&honest).await, 0);
    assert_eq!(e.free(&honest).await, fh + CHALLENGE_BOND + NEAR + 10 * NEAR - fee);

    // the exact view shapes the UI and agents read (printed for the docs)
    println!("GET_JOB_JSON {}", serde_json::to_string_pretty(&j).unwrap());
    let list: Vec<Value> = e.view("list_jobs", json!({ "from_index": 0, "limit": 10 })).await;
    println!("LIST_JOBS_JSON {}", serde_json::to_string_pretty(&list).unwrap());
    println!("GET_ACCOUNT_JSON {}", serde_json::to_string_pretty(&e.account(&honest).await).unwrap());
}

/// SPEC happy path 5: the appeal is wrong, its bond goes to the round-2 verifier.
#[tokio::test]
async fn happy_5_failed_appeal() {
    let e = Env::start(0, &["poster", "honest", "liar", "v1", "v2", "v3", "keeper"]).await;
    let (poster, honest, liar, keeper) = (id("poster"), id("honest"), id("liar"), id("keeper"));
    let vs = [id("v1"), id("v2"), id("v3")];
    e.workers(&[&honest, &liar]).await;
    e.verifiers(&[&vs[0], &vs[1], &vs[2]]).await;
    e.ok(&keeper, "deposit", json!({}), NEAR).await;
    let job = e.post(&poster, job_args("failed appeal", steps(2), 2, NEAR, 10 * NEAR, [20_000, 20_000, 20_000, 20_000])).await;
    e.claim_all(job, &[&honest, &liar]).await;
    let truth: &[&str] = &[PASS, FAIL];
    let lie: &[&str] = &[PASS, PASS];
    e.commit_all(job, &[(&honest, truth), (&liar, lie)]).await;
    e.reveal_all(job, &[(&honest, truth), (&liar, lie)]).await;
    let v1 = e.drawn(job).await;
    e.ok(&v1, "verify", verify_args(job, truth), 0).await;
    // the liar appeals the honest ruling
    e.ok(&liar, "challenge", json!({ "job_id": job }), 0).await;
    let v2 = e.drawn(job).await;
    assert_ne!(v1, v2);
    e.ok(&v2, "verify", verify_args(job, truth), 0).await;
    let (f1, f2) = (e.free(&v1).await, e.free(&v2).await);
    e.ok(&keeper, "finalize", json!({ "job_id": job }), 0).await;
    let j = e.job(job).await;
    assert_eq!(claim_of(&j, &liar)["status"], "slashed");
    assert!(has_payout(&j, &v2, "challenge_award", CHALLENGE_BOND), "the wrong appeal pays its bond to the round-2 verifier");
    let fee = 10 * NEAR * FEE_BPS / 10_000;
    assert!(has_payout(&j, &v1, "fee", fee), "not overruled: the round-1 verifier keeps the fee");
    assert_eq!(e.free(&v2).await, f2 + CHALLENGE_BOND);
    assert_eq!(e.free(&v1).await, f1 + fee);
    assert!(e.in_pool(&v1).await);
    assert_eq!(e.locked(&liar).await, 0, "both the claim bond and the challenge bond left the liar");
    assert_eq!(e.burned().await, NEAR, "only the liar's claim bond is burned; the challenge bond was paid, not burned");
    assert_eq!(u(&e.account(&v2).await["stats"]["earned"]), CHALLENGE_BOND);
}

// ---------- cheats ----------

/// Every claim cheat, plus withdraw more than free and withdraw while funds are locked.
#[tokio::test]
async fn cheats_claim_and_withdraw() {
    let e = Env::start(0, &["poster", "w1", "w2", "w3", "poor", "outsider"]).await;
    let (poster, w1, w2, w3, poor, outsider) = (id("poster"), id("w1"), id("w2"), id("w3"), id("poor"), id("outsider"));
    // the poster is a registered worker too, so "claim own job" is reached by a real worker
    e.workers(&[&w1, &w2, &w3, &poster]).await;
    e.ok(&poor, "register_worker", json!({ "label": "poor", "model": "m" }), WORKER_BOND + NEAR / 2).await;
    // anyone may fund anyone
    let f3 = e.free(&w3).await;
    e.ok(&poster, "deposit", json!({ "account_id": w3 }), NEAR).await;
    assert_eq!(e.free(&w3).await, f3 + NEAR);

    let job = e.post(&poster, job_args("claims", steps(1), 2, 2 * NEAR, NEAR, [30_000, 20_000, 20_000, 5_000])).await;
    e.fails(&outsider, "claim", json!({ "job_id": job }), 0, "not a worker").await;
    let pf = e.free(&poor).await;
    e.fails(&poor, "claim", json!({ "job_id": job }), 0, &format!("bond: need {} yocto free, have {pf}", 2 * NEAR)).await;
    e.fails(&poster, "claim", json!({ "job_id": job }), 0, "poster cannot claim its own job").await;
    e.ok(&w1, "claim", json!({ "job_id": job }), 0).await;
    e.fails(&w1, "claim", json!({ "job_id": job }), 0, "already claimed this job").await;
    e.ok(&w2, "claim", json!({ "job_id": job }), 0).await;
    e.fails(&w3, "claim", json!({ "job_id": job }), 0, "all slots are taken").await;

    let late = e.post(&poster, job_args("late", steps(1), 2, NEAR, NEAR, [1_000, 20_000, 20_000, 5_000])).await;
    e.wait_until(e.job(late).await["claim_until"].as_u64().unwrap()).await;
    e.fails(&w3, "claim", json!({ "job_id": late }), 0, "claim phase closed").await;

    // withdraw: w1 holds a 2 NEAR claim bond and a 1 NEAR worker bond
    let f = e.free(&w1).await;
    assert_eq!(e.locked(&w1).await, 2 * NEAR);
    e.fails(&w1, "withdraw", json!({ "amount": (f + 1).to_string() }), 0, "withdraw: only free balance can be withdrawn").await;
    e.fails(&w1, "withdraw", json!({ "amount": (f + 2 * NEAR).to_string() }), 0, "withdraw: only free balance can be withdrawn").await;
    let n0 = e.native(&w1).await;
    e.ok(&w1, "withdraw", json!({}), 0).await;
    assert!(e.native(&w1).await > n0 + f - NEAR / 100);
    e.fails(&w1, "withdraw", json!({}), 0, "withdraw: nothing to withdraw").await;
    let a = e.account(&w1).await;
    assert_eq!(u(&a["free"]), 0);
    assert_eq!(u(&a["locked"]), 2 * NEAR, "locked funds never withdraw");
    assert_eq!(u(&a["worker_bond"]), WORKER_BOND);
    e.fails(&w1, "leave_worker", json!({}), 0, "worker has 1 active claims").await;
}

/// Every commit and reveal cheat, then both no-shows burn via `advance` and the bounty is refunded.
#[tokio::test]
async fn cheats_commit_and_reveal() {
    let e = Env::start(0, &["poster", "w1", "w2", "stranger", "keeper"]).await;
    let (poster, w1, w2, stranger, keeper) = (id("poster"), id("w1"), id("w2"), id("stranger"), id("keeper"));
    e.workers(&[&w1, &w2]).await;
    e.ok(&keeper, "deposit", json!({}), NEAR).await;
    let job = e.post(&poster, job_args("reveals", steps(2), 2, NEAR, 4 * NEAR, [4_000, 4_000, 8_000, 5_000])).await;
    e.claim_all(job, &[&w1, &w2]).await;
    let truth: &[&str] = &[PASS, FAIL];
    e.commit_all(job, &[(&w1, truth)]).await;
    e.fails(&w1, "commit", json!({ "job_id": job, "hash": report_hash(&e.market, job, &w1, truth) }), 0, "already committed").await;
    // w2 has not committed and commit_until is still ahead: revealing now would let w2 copy
    e.fails(&w1, "reveal", reveal_args(job, truth), 0, "reveal phase not open yet").await;
    e.fails(&stranger, "reveal", reveal_args(job, truth), 0, "not a claimant of this job").await;
    let j = e.job(job).await;
    assert_eq!(j["reveal_open"], false);

    e.wait_until(j["commit_until"].as_u64().unwrap()).await;
    e.fails(&w2, "commit", json!({ "job_id": job, "hash": report_hash(&e.market, job, &w2, truth) }), 0, "commit window closed").await;
    e.fails(&w2, "reveal", reveal_args(job, truth), 0, "no commit to reveal").await;
    e.fails(&w1, "reveal", reveal_args(job, &[PASS]), 0, "wrong number of verdicts: need 2, got 1").await;
    e.fails(&w1, "reveal", reveal_args(job, &[PASS, PASS]), 0, "reveal does not match commit").await;
    let mut other_salt = reveal_args(job, truth);
    other_salt["salt"] = json!("ffeeddccbbaa99887766554433221100");
    e.fails(&w1, "reveal", other_salt, 0, "reveal does not match commit").await;

    // a verdict after the window
    e.wait_until(j["reveal_until"].as_u64().unwrap()).await;
    e.fails(&w1, "reveal", reveal_args(job, truth), 0, "reveal window closed").await;

    // nobody revealed: both are no-shows, the job expires and the poster gets the bounty back
    let fp = e.free(&poster).await;
    let r = e.ok(&keeper, "advance", json!({ "job_id": job }), 0).await;
    assert!(logs_have(&r, "no_show") && logs_have(&r, "job_expired"));
    let j = e.job(job).await;
    assert_eq!(j["phase"], "Expired");
    for w in [&w1, &w2] {
        assert_eq!(claim_of(&j, w)["status"], "no_show");
        assert!(has_burn(&j, w, "no_show", NEAR));
        assert_eq!(e.locked(w).await, 0);
    }
    assert_eq!(e.burned().await, 2 * NEAR);
    assert!(has_payout(&j, &poster, "refund", 4 * NEAR));
    assert_eq!(e.free(&poster).await, fp + 4 * NEAR);
    e.fails(&keeper, "finalize", json!({ "job_id": job }), 0, "job expired").await;
}

/// A no-show worker's bond is burned via `advance` while the job still gets Reported; then the
/// draw exclusions: neither the poster nor a claimant can ever be drawn (both sit in the pool, so
/// the eligible pool is empty and the dispute resolves as "no ruling", whatever the random seed).
#[tokio::test]
async fn no_show_worker_and_draw_exclusions() {
    let e = Env::start(0, &["poster", "w1", "w2", "keeper"]).await;
    let (poster, w1, w2, keeper) = (id("poster"), id("w1"), id("w2"), id("keeper"));
    e.workers(&[&w1, &w2]).await;
    e.verifiers(&[&poster]).await;
    e.ok(&keeper, "deposit", json!({}), NEAR).await;
    let job = e.post(&poster, job_args("no-show", steps(1), 2, NEAR, 4 * NEAR, [3_000, 3_000, 3_000, 30_000])).await;
    e.claim_all(job, &[&w1, &w2]).await;
    e.commit_all(job, &[(&w1, &[PASS])]).await;
    let j = e.job(job).await;
    e.wait_until(j["commit_until"].as_u64().unwrap()).await;
    e.reveal_all(job, &[(&w1, &[PASS])]).await;
    e.fails(&keeper, "advance", json!({ "job_id": job }), 0, "nothing to advance").await;
    e.wait_until(j["reveal_until"].as_u64().unwrap()).await;
    assert_eq!(e.job(job).await["advance_due"], true);

    let burned0 = e.burned().await;
    e.ok(&keeper, "advance", json!({ "job_id": job }), 0).await;
    let j = e.job(job).await;
    assert_eq!(j["phase"], "Reported", "one report was revealed: the job is Reported with it");
    assert_eq!(claim_of(&j, &w2)["status"], "no_show");
    assert!(has_burn(&j, &w2, "no_show", NEAR));
    assert_eq!(e.burned().await, burned0 + NEAR);
    assert_eq!(e.account(&w2).await["stats"]["no_shows"], 1);

    // the no-show (still a claimant of this job) becomes a verifier
    e.fails(&w2, "register_verifier", json!({ "label": "x", "model": "y" }), 0, "already registered as a worker").await;
    e.ok(&w2, "leave_worker", json!({}), 0).await;
    e.verifiers(&[&w2]).await;
    assert!(e.in_pool(&w2).await && e.in_pool(&poster).await);

    e.ok(&poster, "challenge", json!({ "job_id": job }), 0).await;
    let j = e.job(job).await;
    assert_eq!(j["rounds"][0]["reason"], "challenge");
    assert_eq!(j["rounds"][0]["verifier"], Value::Null, "the poster and the claimant are the whole pool and neither is eligible");
    assert_eq!(j["rounds"][0]["outcome"], "no_ruling");
    e.fails(&poster, "verify", verify_args(job, &[PASS]), 0, "poster cannot verify its own job").await;
    e.fails(&w2, "verify", verify_args(job, &[PASS]), 0, "a claimant cannot verify its own job").await;
    e.fails(&w1, "challenge", json!({ "job_id": job }), 0, "nothing to challenge").await;

    // no ruling: finalize at once, the unanimous report stands and the dispute bond comes back
    assert_eq!(j["finalize_ready"], true);
    let fp = e.free(&poster).await;
    e.ok(&keeper, "finalize", json!({ "job_id": job }), 0).await;
    let j = e.job(job).await;
    assert_eq!(j["final_verdicts"], json!([PASS]));
    assert_eq!(u(&claim_of(&j, &w1)["earned"]), 4 * NEAR);
    assert!(has_payout(&j, &poster, "challenge_return", CHALLENGE_BOND));
    assert_eq!(e.free(&poster).await, fp + CHALLENGE_BOND);
}

/// A function-call key restricted to the market and the agent method list: protocol-level limits.
#[tokio::test]
async fn cheats_function_call_key() {
    let e = Env::start(0, &["poster", "operator", "agent"]).await;
    let (poster, operator, agent, other) = (id("poster"), id("operator"), id("agent"), id("other"));
    // a second market instance: a key restricted to the first one must not reach it
    e.deploy(&other, wasm(), 0).await;
    let job = e.post(&poster, job_args("fc key", steps(1), 1, NEAR, NEAR, [60_000, 20_000, 20_000, 5_000])).await;
    // the operator funds its agent; the agent never attaches a deposit itself
    e.ok(&operator, "deposit", json!({ "account_id": agent }), 5 * NEAR).await;

    let methods = [
        "claim",
        "commit",
        "reveal",
        "verify",
        "challenge",
        "advance",
        "finalize",
        "withdraw",
        "register_worker",
        "register_verifier",
        "leave_verifier",
        "post_job",
    ];
    let key = near_api::signer::generate_secret_key().unwrap();
    near_api::Account(agent.clone())
        .add_key(
            AccessKeyPermission::FunctionCall(FunctionCallPermission {
                allowance: Some(NearToken::from_near(1)),
                receiver_id: e.market.to_string(),
                method_names: methods.iter().map(|s| s.to_string()).collect(),
            }),
            key.public_key(),
        )
        .with_signer(e.signer.clone())
        .send_to(&e.net)
        .await
        .unwrap()
        .assert_success();
    let fc = Signer::from_secret_key(key).unwrap();
    let tx = |to: AccountId, method: &'static str, args: Value, deposit: u128| {
        near_api::Contract(to)
            .call_function(method, args)
            .transaction()
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(NearGas::from_tgas(100))
            .with_signer(agent.clone(), fc.clone())
    };
    // near-api collapses an invalid transaction to `InvalidTransaction({})`, so the rejected ones are
    // signed with the function-call key here and broadcast over raw JSON-RPC to read the node's error
    let rejected = |to: AccountId, method: &'static str, args: Value, deposit: u128, variant: &'static str| {
        let signed = tx(to, method, args, deposit);
        let (net, rpc) = (e.net.clone(), e.sandbox.rpc_addr.clone());
        async move {
            let signed = match signed.presign_with(&net).await.unwrap().transaction {
                near_api::advanced::TransactionableOrSigned::Signed((s, _)) => s,
                _ => unreachable!("presigned"),
            };
            let b64 = near_sdk::base64::Engine::encode(
                &near_sdk::base64::engine::general_purpose::STANDARD,
                near_sdk::borsh::to_vec(&signed).unwrap(),
            );
            let body = json!({ "jsonrpc": "2.0", "id": "fc", "method": "broadcast_tx_commit", "params": [b64] }).to_string();
            let resp = raw_rpc(&rpc, &body).await;
            assert!(
                resp.contains("InvalidAccessKeyError") && resp.contains(variant),
                "expected the node to reject with {variant}, got {resp}"
            );
            println!("FC_KEY {variant}: {}", resp.lines().last().unwrap_or_default());
        }
    };

    // (d) allowed methods succeed with only the function-call key
    tx(e.market.clone(), "register_worker", json!({ "label": "agent", "model": "m" }), 0).send_to(&e.net).await.unwrap().assert_success();
    tx(e.market.clone(), "claim", json!({ "job_id": job }), 0).send_to(&e.net).await.unwrap().assert_success();
    assert_eq!(e.job(job).await["claims"][0]["worker"], json!(agent));
    // (a) another contract
    rejected(other.clone(), "advance", json!({ "job_id": 0 }), 0, "ReceiverMismatch").await;
    // (b) an attached deposit, even 1 yocto, even to a payable method
    rejected(e.market.clone(), "claim", json!({ "job_id": job }), 1, "DepositWithFunctionCall").await;
    // (c) a method outside the list
    rejected(e.market.clone(), "deposit", json!({}), 0, "MethodNameMismatch").await;
    rejected(e.market.clone(), "leave_worker", json!({}), 0, "MethodNameMismatch").await;
    // nothing above reached the contract: the agent is still the only claimant, nothing moved
    assert_eq!(e.job(job).await["claims"].as_array().unwrap().len(), 1);
    // withdraw is allowed, and it can only ever pay the agent's own account
    let n0 = e.native(&agent).await;
    let f = e.free(&agent).await;
    tx(e.market.clone(), "withdraw", json!({}), 0).send_to(&e.net).await.unwrap().assert_success();
    assert_eq!(e.free(&agent).await, 0);
    assert!(e.native(&agent).await > n0 + f - NEAR / 100);
}

/// POST a JSON-RPC body to the sandbox and return the raw HTTP response.
async fn raw_rpc(rpc_addr: &str, body: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let host = rpc_addr.trim_start_matches("http://").trim_end_matches('/');
    let mut s = tokio::net::TcpStream::connect(host).await.unwrap();
    let req = format!(
        "POST / HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).await.unwrap();
    String::from_utf8_lossy(&out).into_owned()
}

// ---------- gas at the maximum sizes ----------

/// 12 steps x 400 chars, 5 slots, 64 verifiers in the pool, both audit rounds, an overrule and four
/// slashes in one `finalize`. Prints the gas of every heavy call.
#[tokio::test]
async fn gas_at_max_sizes() {
    let vnames: Vec<String> = (0..64).map(|i| format!("v{i:02}")).collect();
    let mut names: Vec<&str> = vec!["poster", "w1", "w2", "w3", "w4", "w5", "extra", "keeper"];
    names.extend(vnames.iter().map(|s| s.as_str()));
    let e = Env::start(0, &names).await;
    let (poster, keeper) = (id("poster"), id("keeper"));
    let ws: Vec<AccountId> = (1..=5).map(|i| id(&format!("w{i}"))).collect();
    let vs: Vec<AccountId> = vnames.iter().map(|n| id(n)).collect();
    e.verifiers(&vs.iter().collect::<Vec<_>>()).await;
    assert_eq!(e.view::<Vec<Value>>("list_verifiers", json!({})).await.len(), 64);
    e.fails(&id("extra"), "register_verifier", json!({ "label": "x", "model": "y" }), 5 * NEAR, "pool full").await;
    e.workers(&ws.iter().collect::<Vec<_>>()).await;
    e.ok(&keeper, "deposit", json!({}), NEAR).await;

    let big_steps = json!(
        (0..12)
            .map(|i| json!({ "do": format!("{i:02}{}", "d".repeat(398)), "see": format!("{i:02}{}", "s".repeat(398)) }))
            .collect::<Vec<_>>()
    );
    let mut args = job_args(&"t".repeat(80), big_steps, 5, NEAR, 10 * NEAR, [60_000, 60_000, 60_000, 60_000]);
    args["repo"] = json!(format!("https://{}", "r".repeat(192)));
    args["path"] = json!("p".repeat(100));
    args["commit"] = json!("a".repeat(40));
    let r = e.ok(&poster, "post_job", args, 11 * NEAR).await;
    let g_post = r.total_gas_burnt;
    let job: u64 = r.json().unwrap();

    let claims = join_all(ws.iter().map(|w| e.ok(w, "claim", json!({ "job_id": job }), 0))).await;
    let g_claim = claims.iter().map(|r| r.total_gas_burnt).max().unwrap();
    let honest: Vec<&str> = (0..12).map(|i| if i == 11 { FAIL } else { PASS }).collect();
    let lie: Vec<&str> = vec![PASS; 12];
    let reports: Vec<(&AccountId, &[&str])> =
        ws.iter().enumerate().map(|(i, w)| (w, if i == 4 { &honest[..] } else { &lie[..] })).collect();
    let commits =
        join_all(reports.iter().map(|(w, v)| e.ok(w, "commit", json!({ "job_id": job, "hash": report_hash(&e.market, job, w, v) }), 0)))
            .await;
    let g_commit = commits.iter().map(|r| r.total_gas_burnt).max().unwrap();
    let uri_args = |v: &[&str]| {
        let mut a = reveal_args(job, v);
        a["transcript_uri"] = json!("u".repeat(200));
        a
    };
    let first4 = join_all(reports[..4].iter().map(|(w, v)| e.ok(w, "reveal", uri_args(v), 0))).await;
    let g_reveal = first4.iter().map(|r| r.total_gas_burnt).max().unwrap();
    // the last reveal also reports the job and draws a verifier from 64
    let r = e.ok(&ws[4], "reveal", uri_args(&honest), 0).await;
    let g_reveal_last = r.total_gas_burnt;
    let v1 = e.drawn(job).await;
    let mut ruling = verify_args(job, &lie);
    ruling["transcript_uri"] = json!("u".repeat(200));
    let g_verify1 = e.ok(&v1, "verify", ruling, 0).await.total_gas_burnt;
    let g_challenge = e.ok(&ws[4], "challenge", json!({ "job_id": job }), 0).await.total_gas_burnt;
    let v2 = e.drawn(job).await;
    assert_ne!(v1, v2);
    let g_verify2 = e.ok(&v2, "verify", verify_args(job, &honest), 0).await.total_gas_burnt;
    let r = e.ok(&keeper, "finalize", json!({ "job_id": job }), 0).await;
    let g_finalize = r.total_gas_burnt;
    let j = e.job(job).await;
    assert_eq!(j["claims"].as_array().unwrap().iter().filter(|c| c["status"] == "slashed").count(), 4);
    assert!(has_burn(&j, &v1, "overruled", VERIFIER_BOND));
    assert_eq!(u(&claim_of(&j, &ws[4])["earned"]), 9 * NEAR);
    let summary: Vec<Value> = e.view("list_jobs", json!({})).await;
    assert_eq!(summary[0]["slashed_count"], 4);
    assert_eq!(summary[0]["steps_count"], 12);

    let rows = [
        ("post_job (12 steps x 2 x 400 chars)", g_post),
        ("claim (max of 5)", g_claim),
        ("commit (max of 5)", g_commit),
        ("reveal (max of the first 4)", g_reveal),
        ("reveal, last (reports + draw from 64)", g_reveal_last),
        ("verify round 1", g_verify1),
        ("challenge (appeal, draw from 63)", g_challenge),
        ("verify round 2", g_verify2),
        ("finalize (5 reports, 4 slashes, overrule, fee, appeal bond)", g_finalize),
    ];
    for (name, g) in rows {
        println!("GAS {name}: {:.2} Tgas", g.as_gas() as f64 / 1e12);
        assert!(g < NearGas::from_tgas(300), "{name} must stay under 300 Tgas");
    }
    assert!(g_finalize < NearGas::from_tgas(50), "finalize stays far under the limit");
}
