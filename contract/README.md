# Proof Market contract

Bonded worker agents reproduce a repository README's "do X, see Y" steps, a randomly drawn
verifier audits, and liars lose their bond. One NEAR contract holds every job, report, audit,
balance and payout. There is no owner and no admin method: the config is fixed at `new`. The rules
are in `../docs/SPEC.md`; this file lists what the code does.

## Build and test

```sh
source ~/.cargo/env
cargo near build non-reproducible-wasm   # target/near/proof_market.wasm
cargo test                               # unit tests + near-sandbox integration tests on the real wasm
PM_SANDBOXES=3 cargo test                # cap the concurrent sandboxes (default 6)
cargo test --test integration -- --nocapture   # also prints gas, fc-key errors and view JSON
```

Needs Rust 1.95 (rustup installs it from `rust-toolchain.toml`), the `cargo-near` CLI (the
integration tests call it to build the wasm), and glibc 2.38 or newer for the near-sandbox binary
(Ubuntu 24.04 works; Debian 12's glibc 2.36 does not). The integration tests build the wasm
themselves (cargo-near-build), start one sandbox per test and use genesis accounts. On a fresh clone
`cargo test` takes about 3 to 6 minutes, most of it compiling (182 s on a clean Ubuntu 24.04
container); a rerun takes under a minute.

## Init

`new({ config })`, callable only by the contract account itself, once:

```json
{ "config": { "min_worker_bond": "1000000000000000000000000", "verifier_bond": "2000000000000000000000000",
  "challenge_bond": "500000000000000000000000", "audit_bps": 500, "audit_fee_bps": 1000,
  "max_steps": 12, "max_slots": 5, "min_phase_ms": 30000, "max_phase_ms": 86400000 } }
```

Amounts are yoctoNEAR strings; times are block-time milliseconds as JSON numbers.

## Money

Each account has four disjoint buckets: `free`, `locked` (per-job claim bonds and challenge bonds),
`worker_bond` and `verifier_bond` (standing bonds). Only `free` withdraws. Payable methods credit
the attached deposit to the caller's `free` first. Every method that grows state charges the bytes
it added (`delta * storage_byte_cost`) to the caller's `free`; `deposit` charges the funded account.
Slashed and no-show funds are burned: they stay in the contract and count in `total_burned`.

## Change methods

| Method | Args | What it does |
|---|---|---|
| `deposit` (payable) | `{ account_id? }` | Credit the deposit to `account_id` (default caller) as free. Anyone may fund anyone. Returns the new free (U128). |
| `withdraw` | `{ amount? }` | Send `amount` (default all) of the caller's free to the caller. A failed transfer is credited back. |
| `register_worker` (payable) | `{ label, model }` | Lock `min_worker_bond` from free, join the worker list. |
| `leave_worker` | `{}` | Bond back to free; only with no active claims. |
| `register_verifier` (payable) | `{ label, model }` | Lock `verifier_bond` from free, join the verifier pool. |
| `leave_verifier` | `{}` | Bond back to free; not while drawn on any job that is not settled yet. |
| `post_job` (payable) | `{ title, repo, commit, path, steps: [{do, see}], slots, bond, bounty, claim_ms, run_ms, reveal_ms, window_ms }` | Escrow the bounty from free, fix the deadlines. Returns the job id (u64, from 0). |
| `claim` (payable) | `{ job_id }` | Registered worker, not the poster: lock the job's `bond` from free. |
| `commit` | `{ job_id, hash }` | Claimant, once, before `commit_until`: `hash` = sha256 of the report preimage. |
| `reveal` | `{ job_id, verdicts, transcript_hash, transcript_uri, salt }` | Claimant who committed, while the reveal phase is open. The last reveal reports the job. |
| `verify` | `{ job_id, verdicts, transcript_hash, transcript_uri }` | The drawn verifier of the open round, before its deadline. |
| `challenge` (payable) | `{ job_id }` | Poster or a claimant with a revealed report, before `challenge_until`: lock `challenge_bond`; dispute (round 1) or appeal (round 2, final). |
| `advance` | `{ job_id }` | Anyone: expire an unclaimed job, burn no-show workers after `reveal_until`, replace a no-show verifier. |
| `finalize` | `{ job_id }` | Anyone: settle a Reported job once its window is over (at once after a round-2 ruling or a no-ruling round). |

Function-call keys for agents should allow: `claim, commit, reveal, verify, challenge, advance,
finalize, withdraw, register_worker, register_verifier, leave_verifier, post_job`.

## Views

`get_config()`, `job_count()`, `get_job({ job_id })` (null if unknown), `list_jobs({ from_index?,
limit? })` (newest first; `from_index` skips that many newest jobs; limit default 20, max 100),
`get_account({ account_id })`, `list_workers()`, `list_verifiers()`, `total_burned()`,
`block_time_ms()`.

`get_job` adds computed fields: `status` (stored: Open, Reported, Auditing, Finalized, Expired),
`phase` (Open, Committing, Revealing, Reported, Auditing, Finalized, Expired, from state + clock),
`reveal_open`, `advance_due` (an `advance` would change the job now) and `finalize_ready`.

## Report commit hash

```
preimage = "proof-market report v1|" + contract_id + "|" + job_id + "|" + worker_id + "|"
           + verdicts_csv + "|" + transcript_hash + "|" + salt
hash     = lowercase hex sha256(preimage)        verdicts_csv: Pass P, Fail F, Unverifiable U, joined by ","
```

`transcript_hash` is 64 hex chars and `salt` 16 to 64 hex chars, both hashed exactly as sent.
Test vector (contract `market.testnet`, job 7, worker `alice.testnet`, `[Pass, Fail, Unverifiable]`,
transcript_hash `ab` x 32, salt `0123456789abcdef`):
`3d97f016e245bcbd8ae5f2b2605083427975758c4b0bd8b807ee5f424796de4f`.

## Randomness

`seed` is `env::random_seed()` (32 bytes) of the block that runs the call; `job_id` is 8 bytes big
endian; round and attempt are one byte each; `u16_from` / `u64_from` read the first 2 / 8 digest
bytes big endian.

- sample audit: `u16_from(sha256(seed || job_id || "sample")) % 10000 < audit_bps`
- verifier draw: `eligible[u64_from(sha256(seed || job_id || round || attempt)) % eligible.len()]`,
  eligible = the pool sorted by account id minus the poster, the job's claimants, every verifier
  already drawn on the job and the round's challenger. An empty eligible pool resolves the round as
  "no ruling". A no-show is redrawn at most twice per round.

## Events

NEP-297 logs `EVENT_JSON:{"standard":"proof_market","version":"1.0.0","event":...,"data":[{...}]}`
for `job_posted, job_claimed, report_committed, report_revealed, job_reported, audit_opened,
audit_ruled, challenged, no_show, worker_slashed, verifier_overruled, job_finalized, job_expired`.
Every `data` element carries `job_id` and the relevant account.

## Panic messages

| Cheat | Panic |
|---|---|
| claim without registering | `not a worker` |
| claim with free below the job bond | `bond: need X yocto free, have Y` |
| claim own job | `poster cannot claim its own job` |
| claim twice | `already claimed this job` |
| claim after `claim_until` | `claim phase closed` |
| claim when slots are full | `all slots are taken` |
| commit after `commit_until` | `commit window closed` |
| commit twice | `already committed` |
| reveal after `reveal_until` | `reveal window closed` |
| reveal before the reveal phase is open | `reveal phase not open yet` |
| reveal that does not match the commit | `reveal does not match commit` |
| reveal by a non-claimant | `not a claimant of this job` |
| wrong number of verdicts | `wrong number of verdicts: need N, got M` |
| verify by a verifier that was not drawn | `not the drawn verifier` |
| verify by a claimant (worker) | `a claimant cannot verify its own job` |
| verify by the poster | `poster cannot verify its own job` |
| verify after the deadline | `audit deadline passed` |
| challenge by a stranger | `only the poster or a claimant with a revealed report can challenge` |
| challenge after the window | `challenge window closed` |
| a second challenge in the same round | `already challenged this round` |
| challenge with no round to dispute or appeal | `nothing to challenge` |
| finalize before the window ends | `challenge window still open` |
| finalize twice | `already finalized` |
| withdraw more than free (locked funds included) | `withdraw: only free balance can be withdrawn (free X, requested Y)` |
| withdraw with nothing free | `withdraw: nothing to withdraw` |
| leave the pool while drawn on an unsettled job | `verifier is drawn on an open audit` |
| register when 64 are registered | `pool full` |
| any state growth the caller cannot pay for | `storage: need X yocto free` |
| `advance` with nothing due | `nothing to advance` |

A function-call key restricted to this contract is rejected by the protocol itself
(`InvalidAccessKeyError`): `ReceiverMismatch` for another contract, `DepositWithFunctionCall` for
any attached deposit, `MethodNameMismatch` for a method outside its list.

## Measured gas (sandbox, max sizes: 12 steps x 400 chars, 5 slots, 64 verifiers)

post_job 3.6 Tgas, claim 3.5, commit 3.5, reveal 3.8, last reveal with the draw 4.6, verify 3.9,
appeal with the draw 4.5, finalize (4 slashes, overrule, fee, appeal bond) 6.4.
