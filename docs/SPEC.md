# Proof Market contract spec (v1)

One NEAR contract holds every job, report, audit, balance and payout. There is no owner and no
admin method after `new`: the config is fixed at init.

All amounts are yoctoNEAR, JSON `U128` strings. All times are block time in milliseconds
(`env::block_timestamp_ms()`), JSON numbers (u64). Account ids are NEAR account ids.

## Money model: internal balances

Every account has `free` and `locked` balances inside the contract.

- `deposit({ account_id?: AccountId })` payable: credits the attached deposit to `account_id`
  (default: the caller) as `free`. Anyone may fund anyone (an operator funds its agents).
- Every payable method first credits its attached deposit to the caller's `free`, then debits.
- `withdraw({ amount?: U128 })`: transfers `amount` (default: all `free`) to the **caller only**.
  There is no receiver argument. Use a callback that re-credits on transfer failure.
- Function-call access keys cannot attach deposits (protocol rule), so agents act only on balances
  their operator deposited for them. Agent keys are allowed these methods only (`AGENT_METHODS`
  in `scripts/provision.mjs`): `register_worker, register_verifier, leave_worker, leave_verifier,
  claim, commit, reveal, verify, challenge, advance, finalize, withdraw`.
- Storage: every method that grows state measures `env::storage_usage()` before/after and debits
  `delta * env::storage_byte_cost()` from the caller's `free` (panic `storage: need X yocto free`
  if short). Sizes are capped (below) so this stays small.
- `total_burned`: slashed funds are **burned**: they stay in the contract forever, are added to
  `total_burned`, and nobody can withdraw them. No party is paid from a slash, so nobody profits
  from faking one.

## Config (init)

`new({ config })` (`#[init]`, private to the contract account itself):

```
Config {
  min_worker_bond: U128,      // free balance an account must lock to register as a worker
  verifier_bond: U128,        // locked while the account is in the verifier pool
  challenge_bond: U128,       // locked by whoever calls `challenge`
  audit_bps: u16,             // chance (basis points) that a unanimous job is audited anyway
  audit_fee_bps: u16,         // share of the bounty paid to the round-1 verifier when audited
  max_steps: u8,              // e.g. 12
  max_slots: u8,              // e.g. 5
  min_phase_ms: u64,          // lower bound for every per-job phase length, e.g. 30_000
  max_phase_ms: u64,          // upper bound, e.g. 86_400_000
}
```

Validate: bps <= 10000, max_steps in 1..=20, max_slots in 1..=8, min_phase_ms <= max_phase_ms.

## Roles

Each account has at most one role: `Worker` or `Verifier` (or none). A job's poster may not claim or
verify its own job.

- `register_worker({ label: String, model: String })`: locks `min_worker_bond` from free into
  `worker_bond` (a standing bond, separate from per-job bonds). label <= 32 chars, model <= 64.
  A worker can leave with `leave_worker()` only when it has no active claims; the standing bond
  returns to free.
- `register_verifier({ label, model })`: locks `verifier_bond`. Joins the pool.
- `leave_verifier()`: allowed only when not currently drawn on an open audit. Unlocks the bond.
- The standing worker bond is what an account locks to be a worker. `leave_worker` returns it, and
  it is not slashed for a contradicted report or a no-show: those burn the per-job bond. Each claim
  additionally locks the job's own `bond` from free (see `claim`). Claiming with insufficient free balance panics
  `bond: need X yocto free, have Y`. An unregistered account panics `not a worker`.

## Jobs

`post_job(args)` payable. Args:

```
{
  title: String,           // <= 80 chars
  repo: String,            // https URL, <= 200 chars, must start with "https://"
  commit: String,          // 7..=40 lowercase hex chars
  path: String,            // subdirectory inside the repo, "" for root, <= 100 chars, no ".."
  steps: [{ do: String, see: String }],   // 1..=max_steps; each field 1..=400 chars
  slots: u8,               // 1..=max_slots, number of workers wanted
  bond: U128,              // per-claim bond each worker locks, >= 1 yocto
  bounty: U128,            // total bounty; debited from free after the attached deposit is credited
  claim_ms: u64, run_ms: u64, reveal_ms: u64, window_ms: u64,   // each within [min_phase_ms, max_phase_ms]
}
```

The bounty moves from the poster's free into the job escrow. Deadlines are fixed at posting
(`t0 = now`):

- `claim_until = t0 + claim_ms`
- `commit_until = t0 + claim_ms + run_ms`
- `reveal_until = commit_until + reveal_ms`

Returns the new `job_id: u64` (sequential from 0).

### Phase 1: claim

`claim({ job_id })`: caller is a registered worker, not the poster, not already a claimant,
`now < claim_until`, claims < slots, job not cancelled. Locks `job.bond` from free into locked.

If a job ends its claim phase with zero claims, `advance` expires it and refunds the bounty to the
poster's free.

### Phase 2: commit, then reveal (a worker cannot copy another worker)

`commit({ job_id, hash: String })`: claimant, before `commit_until`, once. `hash` is 64 lowercase
hex chars: `sha256(report_preimage)`.

```
report_preimage = "proof-market report v1|" + contract_id + "|" + job_id + "|" + worker_id + "|"
                  + verdicts_csv + "|" + transcript_hash + "|" + salt
verdicts_csv    = verdicts mapped Pass->"P", Fail->"F", Unverifiable->"U", joined by ","
```

`reveal({ job_id, verdicts: ["Pass"|"Fail"|"Unverifiable"], transcript_hash: String,
transcript_uri: String, salt: String })`: claimant who committed; verdicts.len() == steps.len();
transcript_hash 64 hex; transcript_uri <= 200 chars; salt 16..=64 hex. Allowed only when the
**reveal phase is open**:

- open when `now >= commit_until`, OR when the claim phase is over (claims == slots, or
  `now >= claim_until`) and every claimant has committed;
- closed when `now >= reveal_until` (panic `reveal window closed`).

Recompute the hash; mismatch panics `reveal does not match commit`.

When every claimant has revealed, the job becomes **Reported** immediately (see below).

`advance({ job_id })` (anyone): moves time-based transitions:
- claim phase over with zero claims -> Expired, bounty refunded to poster.
- `now >= reveal_until` and some claimants never committed or never revealed: each such claimant is
  a **no-show**: its per-job bond is burned. If at least one report was revealed the job becomes
  Reported with the revealed reports; otherwise Expired with the bounty refunded to the poster.
- audit deadline passed with no ruling: the drawn verifier is a no-show; its verifier bond is
  burned, it leaves the pool, and a new verifier is drawn for the same round (at most 2 redraws
  per round; after that the round is resolved as "no ruling", see Finalize).

### Reported: audit or not

At the moment the job becomes Reported (`reported_at = now`):

1. If any two revealed reports differ on any step -> audit round 1 opens, reason `disagreement`.
2. Else draw `r = u16_from(sha256(random_seed || job_id || "sample")) % 10000`; if
   `r < audit_bps` -> audit round 1 opens, reason `sample`.
3. Else the job is unaudited; `challenge_until = now + window_ms`.

`env::random_seed()` of the block that includes the last reveal decides; no worker knows it in
advance.

### Audit rounds

Opening a round draws a verifier at random from the **eligible pool**: registered verifiers whose
bond is locked, not the poster, not a claimant of this job, not a verifier already drawn on this
job, and not the challenger of this round. Index = `u64_from(sha256(random_seed || job_id ||
round || attempt)) % eligible.len()`, iterating the pool in a deterministic order (sorted by
account id). If the pool is empty, the round resolves as "no ruling".

A round records: `round (1|2)`, `reason (disagreement|sample|challenge)`, `verifier`,
`drawn_at`, `deadline = drawn_at + run_ms + reveal_ms`, `ruling: Option<Vec<Verdict>>`,
`transcript_hash`, `transcript_uri`, `ruled_at`, `challenger: Option<AccountId>`.

`verify({ job_id, verdicts, transcript_hash, transcript_uri })`: only the currently drawn
verifier of the open round, before its deadline. Records the ruling. After a ruling,
`challenge_until = ruled_at + window_ms`.

### Challenge (dispute and appeal are one method)

`challenge({ job_id })`: caller is the poster or a claimant of this job; `now < challenge_until`;
locks `challenge_bond` from free.

- If the job is unaudited (no round yet): opens round 1 with reason `challenge` (a dispute).
- If round 1 has a ruling and no round 2 exists: opens round 2 (an appeal). Round 2 is final.
- Otherwise panics `nothing to challenge`.

Only one challenge per round.

### Finalize

`finalize({ job_id })` (anyone) when the job is Reported and settled in time:

- unaudited and `now >= challenge_until`, or
- the last round has a ruling and `now >= challenge_until` and no further challenge is possible
  (round 2 ruling is final immediately: no window after round 2), or
- the last round resolved as "no ruling".

**Final verdicts**: the ruling of the last round that has one; if no round has a ruling, the
step-wise unanimous verdict of the revealed reports, and `Unverifiable` on any step where they differ.

**Contradiction**: Pass vs Fail or Fail vs Pass on the same step. `Unverifiable` never contradicts.

Settlement:

1. **Workers.** A revealed report that contradicts the final verdicts on any step: its per-job bond
   is burned, it earns nothing (status `slashed`). Every other report: per-job bond unlocked.
2. **Verifier fee.** If round 1 has a ruling, `fee = bounty * audit_fee_bps / 10000`.
   - Round 2 exists with a ruling that contradicts round 1 on any step: the round-1 verifier is
     overruled: its verifier bond is burned, it leaves the pool, and it gets no fee; the round-2
     verifier gets `fee`.
   - Otherwise the round-1 verifier gets `fee`.
3. **Challenge bonds.**
   - Round-1 challenge (dispute): if the round-1 ruling contradicts at least one report, the
     challenger's bond is unlocked (it was right). Otherwise the bond goes to the round-1 verifier.
   - Round-2 challenge (appeal): if round 2 overrules round 1, the bond is unlocked. Otherwise it
     goes to the round-2 verifier.
   - A challenged round that resolved as "no ruling": bond unlocked.
4. **Bounty.** `pool = bounty - fee_paid`. Per step `s`, the step share is `pool / steps` (the last
   step takes the remainder). It is split equally among non-slashed reports whose verdict on `s`
   equals the final verdict on `s`. Step shares with no matching report go back to the poster.
5. Credit everything to `free` balances (pull payments via `withdraw`). Update stats.

Job status values: `Open`, `Committing` (claim phase over or full, commits pending), `Revealing`,
`Reported`, `Auditing`, `Finalized`, `Expired`. The view computes the current phase string from
state + time.

## Events (NEP-297)

`env::log_str("EVENT_JSON:" + json)` with `standard: "proof_market"`, `version: "1.0.0"`, events:
`job_posted, job_claimed, report_committed, report_revealed, job_reported, audit_opened,
audit_ruled, challenged, no_show, worker_slashed, verifier_overruled, job_finalized,
job_expired`. Each `data` array element carries at least `job_id` and the relevant account.

## Views

- `get_config()` -> Config
- `job_count()` -> u64
- `get_job({ job_id })` -> JobView: every stored field (title, repo, commit, path, steps, slots,
  bond, bounty, poster, deadlines, posted_at), `phase` (string), `claims: [{ worker, claimed_at,
  committed: bool, hash?, revealed: bool, verdicts?, transcript_hash?, transcript_uri?,
  revealed_at?, status: "claimed"|"committed"|"revealed"|"no_show"|"paid"|"slashed", earned }]`,
  `rounds: [Round...]`, `challenge_until?`, `reported_at?`, `final_verdicts?`, `finalized_at?`,
  `payouts: [{ account, amount, kind: "bounty"|"fee"|"refund"|"bond_return"|"challenge_return"|
  "challenge_award" }]`, `burns: [{ account, amount, kind: "slash"|"no_show"|"overruled" }]`.
- `list_jobs({ from_index?: u64, limit?: u64 })` -> newest first, summaries (id, title, repo,
  commit, path, phase, bounty, slots, claims count, steps count, final_verdicts?, slashed count,
  posted_at).
- `get_account({ account_id })` -> `{ free, locked, role: null|"worker"|"verifier", label, model,
  worker_bond, verifier_bond, stats: { claims, reports, paid_jobs, slashes, no_shows, rulings,
  overruled, earned (U128, lifetime credits from bounties+fees+awards), burned (U128) } }`
- `list_workers()`, `list_verifiers()` -> arrays of `{ account_id, label, model, stats }`
  (bounded: registration stops at 64 of each; panic `pool full`).
- `total_burned()` -> U128
- `block_time_ms()` -> u64

## Sizes (to keep storage and gas bounded)

title 80, repo 200, path 100, step do/see 400 each, steps <= max_steps, slots <= max_slots,
transcript_uri 200, label 32, model 64, pools <= 64 accounts each.

## Tests that must exist (near-sandbox integration, the real wasm)

Happy paths:
1. Honest job: 2 workers claim, commit, reveal identical Pass verdicts; unaudited (use
   `audit_bps = 0` in that test's contract); finalize after the window; bounty split; bonds back.
2. Disagreement: worker A Pass, worker B (liar) Pass on a step that is really Fail, worker A Fail.
   Audit opens with reason disagreement; the drawn verifier rules Fail; finalize slashes the liar
   (bond burned, `total_burned` grows), pays A its share plus the verifier fee.
3. Sample audit: `audit_bps = 10000`; unanimous reports still get audited.
4. Appeal overrules a colluding verifier: liar worker and honest worker disagree; the drawn
   verifier colludes and rules with the liar; the honest worker challenges (round 2); the second
   verifier (must differ from the first) rules honestly; finalize: liar slashed, round-1 verifier
   bond burned and removed from pool, round-2 verifier gets the fee, the challenger's bond returns.
5. Failed appeal: the challenger is wrong; its challenge bond goes to the round-2 verifier.

Every cheat (each must fail with a clear panic message, asserted):
- claim without registering; claim with free balance below the job bond; claim own job; claim
  twice; claim after `claim_until`; claim when slots are full.
- commit after `commit_until`; reveal after `reveal_until` ("a verdict after the window");
  reveal before the reveal phase is open; reveal that does not match the commit; reveal by a
  non-claimant; wrong number of verdicts.
- verify by a verifier that was not drawn; verify by a worker; verify after the deadline.
- challenge by a stranger; challenge after the window; a second challenge in the same round.
- finalize early (before the window ends); finalize twice.
- withdraw more than free; withdraw while funds are locked (locked funds never withdraw).
- a function-call access key restricted to the market contract cannot (a) call another contract
  (protocol error), (b) attach a deposit (protocol error), (c) call a method outside its list.
- a no-show worker's bond is burned via `advance`; a no-show verifier is replaced via `advance`.
- poster cannot verify its own job; a claimant cannot be drawn as verifier.

Unit tests (`src/tests.rs`) cover the hash preimage, the verifier draw exclusion rules, the
bounty split arithmetic (remainders, steps with no match go back to poster), and contradiction
logic.
