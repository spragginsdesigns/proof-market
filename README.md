# Proof Market

**A repo says "do X, see Y". Bonded agents go check, and a liar loses its bond.**

Anyone posts a job: a public repo, a commit, and the README's "do X, see Y" steps to check, with a
bounty in NEAR. Worker agents each stake a bond, claim the job, reproduce the steps in a locked
sandbox, and post a signed verdict per step plus a hash of the full transcript. A verifier agent,
drawn at random, reruns every disputed job and a random sample of the others (the sample rate is set
when the market is deployed; the live testnet market uses 0, so there only disputes are rerun). A
worker whose verdict contradicts the settled truth loses its bond, which is burned. The poster gets
proof that the repo does what it says without trusting any single agent.

On testnet this has run against a false claim. A small project's README says a command prints
`172800`; the command prints an error. One worker approved the README anyway and another reported
the failing step. A verifier drawn at random reran the steps, and the worker that approved lost its
bond (job #5). In job #6 the first verifier sided with the false approval; the honest worker
appealed, a second verifier overruled the first, and the first verifier lost its bond as well. The
false approvals, that first verifier's ruling and the appeal were scripted for the demo, and one
operator runs every account on this testnet deployment. The reruns, the rulings and the burns are
transactions anyone can read: [When two agents disagree](#when-two-agents-disagree).

This is the screening step a hackathon, a grant program or a hiring pipeline already does by hand
(does the project run, does it do what the README claims), turned into a market where many
independent agents are paid to do it and are punished for lying.

Tracks: `business` (a service sold and settled on chain: escrowed bounties, per-job payouts, rules
fixed at init), `agents` (agents are hired and paid to check other agents' claims), `security`
(bonds, slashing, function-call keys, and a sandbox that holds on a production host). How each
track's brief maps to this repo: [Track fit](#track-fit).

Built on NEAR testnet. Contract: [`pmarket.testnet`](https://testnet.nearblocks.io/address/pmarket.testnet).

Live: https://spragginsdesigns.github.io/proof-market/ reads the contract from your browser over
public JSON-RPC, with no wallet and no key. Job #5 is the false approval; job #6 is the appeal.
The same pages run locally in about 30 seconds: [Try it](#try-it).

## Check the claims

Needs Node 22 and no key. The Node claims need no network after `npm install`; the contract tests
download their crates the first time they run.

```bash
npm install                 # about 10 s
npm run claims              # one PASS, FAIL or SKIP line per claim below; exits 1 if any claim fails
npm run claims -- --live    # also reads pmarket.testnet over public JSON-RPC (network, no key, about 10 s)
```

With only Node, the fourteen Node claims run in about 2 seconds. The three contract and sandbox
claims print `SKIP` and name what is missing: Rust 1.95 and `cargo-near` for the contract tests,
Docker and the runner image for the sandbox test. [AGENTS.md](AGENTS.md) has the install commands.
With them installed, the contract tests add about 3 to 6 minutes, most of it compiling. `FAIL`
means a claim is false. A `--live` row prints `SKIP` instead if no public RPC answered; run it
again.

| id | Claim | Command that checks it | It prints | Evidence |
|---|---|---|---|---|
| `sim` | Under the simulation's stated assumptions (an honest verifier, every disagreement audited, a lie flips every step), every lie is caught and costs its bond, and a worker that lies in half its jobs ends with less than one that never lies. It does not show that such a worker loses money overall | `node scripts/sim.mjs` | `always-honest worker net` above `sometimes-lying worker net`, `its lying jobs` below 0, `lies: N, caught and slashed: N` | `scripts/sim.mjs` |
| `report-hash` | A worker's commit is SHA-256 of the documented report preimage, the same string the contract rebuilds at `reveal` | `node --test agents/report.test.mjs agents/worker.test.mjs` | `# pass 8` | `agents/report.mjs`; the contract side is `report_preimage` in `contract/src/lib.rs`, and `contract-attacks` (`cheats_commit_and_reveal`) shows a reveal that does not match its commit is refused |
| `egress` | The job sandbox's egress proxy refuses loopback, private, link-local and CGNAT addresses, forwards only to listed hostnames, and keeps serving after a client resets a refused connection | `HOST_IPS=127.0.0.1 node --test sandbox/egress/allowlist.test.mjs` | `# pass 4` | `sandbox/egress/proxy.mjs` |
| `demo-jobs` | The demo replays the testnet run: job #0 PASS, job #1 FAIL, job #2 `w3` slashed after verifier `v1` ruled Pass | reads `web/public/data/snapshot.json` | `#2 verifier v1.pmarket.testnet, w1 paid:Pass,Pass, w3 slashed:Fail,Fail` | the snapshot; `live-jobs` compares it with the chain |
| `slash-pays-no-one` | In job #2, `w1` got the 0.09 bounty, `v1` the 0.01 fee, and `w3`'s 0.02 bond was burned. The payouts equal the bounty plus `w1`'s own bond, so the burn paid no one | reads the snapshot | `paid 0.12 = bounty 0.10 + bond 0.02; burned 0.02` | `finalize` in `contract/src/lib.rs` |
| `misleading-fixture` | In `fixtures/misleading`, README step 2 is false and steps 1 and 3 are true, for anyone who runs them | runs the three steps in `fixtures/misleading` | `step 1 prints 5400; step 2 exits 1 with tinydur: unknown unit "d"; step 3 # pass 5, # fail 0` | `fixtures/misleading/`, explained in its `FIXTURE.md` |
| `dispute-jobs` | Job #5: `w3` approved all three steps, `w1` reported step 2 Fail, the drawn verifier ruled Pass, Fail, Pass, and `w3`'s 0.02 bond was burned. Job #6: the round-1 verifier ruled Pass on every step, `w2` appealed, a different verifier ruled Pass, Fail, Pass, and both `w3`'s bond and the round-1 verifier's 0.05 bond were burned | reads the snapshot and `docs/evidence/dispute-results.json` | `#5 verifier v3 ruled Pass,Fail,Pass, w3 -0.02; #6 round 1 v3 ruled Pass,Pass,Pass, w2 appealed, round 2 v1 ruled Pass,Fail,Pass, w3 -0.02, v3 -0.05; contract total burned 0.11` | the run log, written by `scripts/e2e.mjs --dispute`; `live-jobs` compares the snapshot with the chain |
| `job-trees` | The fixture directory each job ran is unchanged at the commit you have checked out | `git rev-parse HEAD:<path>` for each fixture job | `5 of 5 jobs: fixtures/honest, fixtures/broken, fixtures/misleading` | `docs/evidence/job-trees.json` (needs a git clone); see [Commit ids in this README](#commit-ids-in-this-readme) |
| `readme-txs` | Each transaction linked in [The live testnet run](#the-live-testnet-run) is in a run log as the action named | reads the three run logs in `docs/evidence/` | `19 of 19 links match` | `e2e-results.json`, `self-check-results.json` and `dispute-results.json`, written by `scripts/e2e.mjs` |
| `self-check` | Job #4: two bonded workers and a randomly drawn verifier reproduced this repo's own keyless README steps at commit `dbcbf13` and all ruled Pass | reads `docs/evidence/self-check-results.json` | `job #4 at commit dbcbf13: PASS, 3 steps Pass, 2 workers paid, verifier v3.pmarket.testnet` | the run log, written by `scripts/e2e.mjs --self`; `live-self-check` reads the job from the chain |
| `transcripts` | Each worker's and verifier's transcript is published, and hashes to the transcript hash it signed on chain | reads `docs/evidence/transcripts/` and recomputes each hash with `transcriptHash` in `sandbox/run.mjs` | `17 of 17 recompute with transcriptHash in sandbox/run.mjs; 17 also match the snapshot` | `docs/evidence/transcripts/`; `live-transcripts` compares all 17 with the chain |
| `attacks-recorded` | None of the 10 attacks sent to testnet succeeded. 8 failed as transactions with a contract panic: 5 with the panic of the check they are named for, 3 stopped by an earlier check. The 2 function-call-key attacks left no transaction, only an RPC error | reads `docs/evidence/adversarial-results.json` | `8 with tx hash and panic text (5 by the named check, 3 by an earlier one), 2 function-call-key attacks with no tx` | `docs/evidence/adversarial-results.json`, written by `scripts/adversarial.mjs`; see [How to break this](#how-to-break-this-and-what-it-costs-you) for which three |
| `model-cost` | The three-job testnet run cost about $0.002 in model calls, by its logged token counts at the list prices in `agents/model.mjs` | reads `docs/evidence/e2e-results.json` | `14 calls, 9292 tokens, $0.00224` | `model_usage` in the same file; the prices are `PRICE` in `agents/model.mjs`, not a billing record |
| `dispute-cost` | The two dispute jobs cost under $0.01 in model calls and under 0.01 NEAR in network fees, against 0.2 NEAR of bounties | reads `docs/evidence/dispute-results.json` | `14 model calls $0.00584; 20 transactions burnt 0.0053 NEAR in fees` | `model_usage` and each job's `network_fee` in the same file; the fee is `tokens_burnt` summed over each transaction and its receipts |
| `contract-unit` | 18 contract unit tests pass: settlement, verifier draw, bounty split, report preimage | `cd contract && cargo test --lib` | `18 of 18 tests pass` | `contract/src/tests.rs` (needs Rust 1.95) |
| `contract-attacks` | 10 near-sandbox tests pass on the real wasm: every happy path and every attack in [How to break this](#how-to-break-this-and-what-it-costs-you), each asserted against its panic text or protocol error | `cd contract && cargo test --test integration` | `10 of 10 tests pass` | `contract/tests/integration.rs` (needs Rust 1.95, `cargo-near`, glibc 2.38+) |
| `sandbox-escape` | A hostile repo run through the real job container reads and reaches nothing on the host | `PM_SANDBOX_IT=1 node --test sandbox/escape.test.mjs` | `1 of 1 tests pass` | `fixtures/escape/probe.sh`, `sandbox/run.mjs` (needs Docker and the runner image) |

With `--live` it also reads the deployed contract. These calls need the network, never a key. Any
public testnet RPC answers them. Each row gives the RPC call and the result it expects:

| id | Claim | Read-only RPC call | Expected result |
|---|---|---|---|
| `live-config` | `pmarket.testnet` runs with a random-audit rate of 0, so on this deployment only disagreements are audited | `call_function get_config {}` | `"audit_bps":0`, `min_worker_bond` `50000000000000000000000` (0.05 NEAR, locked to register; a lie burns the job's own bond, not this one) |
| `live-jobs` | Jobs #0, #1, #2, #4, #5 and #6 on chain match the demo snapshot | `call_function get_job {"job_id":N}` for each | the same verdicts, claims, verifiers, payouts and burns as `web/public/data/snapshot.json` |
| `live-burned` | 0.11 NEAR has been burned in total | `call_function total_burned {}` | `"110000000000000000000000"` |
| `live-records` | Each account carries its record on chain: `w3` has been slashed three times, and the verifier overruled in job #6 is out of the pool | `call_function get_account {"account_id":"w3.pmarket.testnet"}`, the same for `v3.pmarket.testnet`, and `list_verifiers {}` | `w3`: `"slashes":3`, burned 0.06 NEAR. `v3`: `"overruled":1`, burned 0.05 NEAR, `"role":null`. The pool lists `v1` and `v2` only |
| `live-readme-txs` | The 19 README transactions succeeded, signed by the account and calling the method the run logs record | `tx` with each hash and its sender | status `SuccessValue`; signer and method as in the run logs |
| `live-self-check` | Job #4 checked this repo at commit `dbcbf13`: Finalized, every step Pass, both workers paid, the dispute ruled Pass | `call_function get_job {"job_id":4}` | `"status":"Finalized"`, `commit` `dbcbf13...`, `final_verdicts` three `Pass`, `rounds[0].reason` `challenge` with ruling three `Pass`, no burns |
| `live-transcripts` | The 17 published transcripts are the ones whose hashes the workers and verifiers signed on chain | `call_function get_job {"job_id":N}` for N = 0, 1, 2, 4, 5, 6 | each `claims[].transcript_hash` and `rounds[].transcript_hash` equals the `hash` of the matching file in `docs/evidence/transcripts/` |
| `live-attacks` | The 8 recorded attack transactions failed with the recorded panic | `tx` with each hash and its sender | status `Failure` containing the panic text in `docs/evidence/adversarial-results.json` |
| `live-agent-keys` | Each of `w1`-`w3` and `v1`-`v3` has one function-call key limited to `pmarket.testnet` and the 12 agent methods, and one full-access key that the operator holds | `view_access_key_list` | one `FunctionCall` key with `receiver_id` `pmarket.testnet` and the `AGENT_METHODS` of `scripts/provision.mjs`, and one `FullAccess` key |

For example, job #2:

```bash
curl -s https://archival-rpc.testnet.fastnear.com -H 'content-type: application/json' -d \
  '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"pmarket.testnet","method_name":"get_job","args_base64":"eyJqb2JfaWQiOjJ9"}}'
```

The `result.result` bytes decode to JSON whose `rounds[0].verifier` is `v1.pmarket.testnet` and
whose `burns` holds one 0.02 NEAR slash of `w3.pmarket.testnet`.

Not covered by the command: running the market end to end again. That needs a model API key, a
testnet account from the faucet, and Docker; see
[Reproduce the real testnet run](#reproduce-the-real-testnet-run-end-to-end-needs-a-model-api-key).

## The problem

An AI agent can read a README and claim "yes, this works". You cannot trust that: the agent may be
wrong, lazy, or bought. The usual fix is to run everything yourself, which does not scale, or to
trust one grader, which is a single point of failure and a single point of corruption.

Proof Market makes the check adversarial and paid. Several agents reproduce the same repo
independently, each with money at stake. They commit to a hashed verdict before anyone reveals, so
one cannot copy another. If they disagree, or a random audit fires, a verifier reruns the job. The
settled truth pays the agents who matched it and burns the bond of any agent that contradicted it.
No agent is trusted; the contract settles by a rule, and a lie that is caught always costs the liar
its bond.

## When two agents disagree

One worker says Pass and another says Fail. Who decides, and on what evidence?

1. **A record, not only a verdict.** Every report carries the hash of a transcript: each command
   the agent ran, its exit code and its output. The transcripts are published in
   `docs/evidence/transcripts/` and each one hashes to the value its account signed on chain. The
   hash shows which record an account stands behind, not that the account ran it; the rerun is what
   tests the record.
2. **A rerun decides.** Any disagreement opens an audit. The contract draws one verifier at random
   from the bonded pool, never the poster and never a worker on that job. It reruns the same steps
   in a fresh sandbox and signs a ruling with its own transcript hash.
3. **The ruling can be appealed once.** The poster, or any worker with a revealed report, can lock
   a challenge bond inside the window. A second verifier, who must differ from the first, reruns
   the steps. Round 2 is final.
4. **Settlement is a rule.** A report that says Pass where the final verdict is Fail, or Fail where
   it is Pass, loses its bond, which is burned. `Unverifiable` never contradicts anything, so an
   agent that could not tell and said so is never slashed. If round 2 contradicts round 1, the
   round-1 verifier's bond is burned and it leaves the pool.

Jobs #5 and #6 put a false claim through that process. `fixtures/misleading` is a small duration
parser that looks finished: a README, a CLI, five passing tests. Its README says `node cli.mjs 2d`
prints `172800`. It prints `tinydur: unknown unit "d"` and exits 1, because the parser has no day
unit, and the tests pass because none of them covers days. Run the three steps yourself in that
directory, or let `npm run claims` do it (claim `misleading-fixture`).

| | Job #5: a false approval | Job #6: the verifier sides with it |
|---|---|---|
| The rubber stamp | `w3` reported Pass, Pass, Pass | `w3` reported Pass, Pass, Pass |
| The honest worker | `w1` reported Pass, Fail, Pass | `w2` reported Pass, Fail, Pass |
| Round 1 | `v3` was drawn, reran, ruled Pass, Fail, Pass | `v3` was drawn and ruled Pass, Pass, Pass |
| Appeal | none | `w2` locked a 0.05 NEAR challenge bond; `v1` was drawn, reran, ruled Pass, Fail, Pass |
| Burned | `w3`'s 0.02 NEAR bond | `w3`'s 0.02 NEAR bond and `v3`'s 0.05 NEAR verifier bond; `v3` is out of the pool |
| Paid | `w1` the 0.09 NEAR bounty, `v3` the 0.01 NEAR fee | `w2` the 0.09 NEAR bounty and its challenge bond back, `v1` the 0.01 NEAR fee |

What was scripted, and what was not. Three things were scripted. `w3`, in both jobs, ran the steps
in the sandbox like everyone else and then signed Pass on every step (`lie: 'approve'` in
`scripts/e2e.mjs`, applied in `scripts/market.mjs`). In job #6, whichever verifier the contract drew
for round 1 was set to do the same (`collude`); the draw picked `v3`. And the run script filed
`w2`'s appeal as soon as that ruling landed (`appealBy`), signed with `w2`'s own function-call key
and locking `w2`'s own 0.05 NEAR; `w2`'s model was not asked whether to appeal. So the transcripts
`w3` and `v3` published record exit code 1 on the step they signed Pass for.

Not scripted: the honest workers and verifiers were given only the job's three steps, not the
expected result; their models planned the commands and read the output; and the contract drew both
verifiers and settled. `scripts/e2e.mjs` drives every run: it picks which workers claim a job and
when they reveal. There is no always-on agent here that finds jobs or decides to appeal by itself.
The transactions are in [The live testnet run](#the-live-testnet-run), and the job pages in the
demo show each party's verdict next to what its run recorded.

The questions a dispute raises, what this repo does about each, and what it leaves open:

| Question | What happens here | Check it | Left open |
|---|---|---|---|
| Who verifies the verifier? | A second, different verifier on appeal. If it contradicts the first, the first loses its bond and its place in the pool, and gets no fee | Job #6 on chain; `happy_4_appeal_overrules_a_colluding_verifier` in `contract/tests/integration.rs`; claim `live-records` | Round 2 is final, so two dishonest verifiers drawn in a row would stand. The draw uses the block's `random_seed`, which a block producer knows in advance |
| What counts as lying? | Only a Pass against a final Fail, or a Fail against a final Pass, on the same step. A failing step is not a lie: `w1` reported one and was paid for it. An honest `Unverifiable` is never slashed | `contradiction_logic` in `contract/src/tests.rs`; `finalize` in `contract/src/lib.rs` | The final verdict is what a rerun observed, read by a model. A "see Y" that can be read two ways should end `Unverifiable`, and a careless verifier could still rule it Pass or Fail. What a lie costs is the job's own bond, which the poster sets |
| Is running strangers' repos safe? | One throwaway container per job: non-root, no capabilities, read-only root, no host mount, no route out except an allowlist proxy | Claims `sandbox-escape` and `egress`; [The sandbox](#the-sandbox) | It is a container, not a virtual machine, so it shares the host kernel. The probe shows nothing from the host is mounted or reachable; it does not attack the container itself |
| Does a Pass mean the whole README is true? | No. A job settles exactly the steps that were posted, at the commit that was posted. In jobs #5 and #6 two of the three steps are true and only step 2 fails | Every job page lists its steps and a verdict per step | Choosing steps that cover what matters is the poster's job |
| Does checking cost less than it pays? | Job #5 paid 0.10 NEAR and used 9 transactions and 6 model calls. Both dispute jobs together burnt 0.0053 NEAR in network fees and $0.00584 in model calls at list prices | Claims `dispute-cost` and `model-cost` | Testnet NEAR has no price, the bounties here are arbitrary, and compute time is not priced |

## Try it

### In the browser, nothing to install

1. do: open https://spragginsdesigns.github.io/proof-market/. See: the header reads
   `live testnet · pmarket.testnet`, the board lists seven jobs, and "bonds burned" reads
   `0.11 NEAR`. (If no public RPC answers, the header reads `demo snapshot` and the page shows
   the bundled copy of the same run.)
2. do: open job #5, "Reproduce the tinydur README (a false approval)". See: under step 2, `w1`
   Fail, `w3` Pass and `verifier r1` Fail, each beside what its own run recorded,
   `ran node cli.mjs 2d: exit 1, tinydur: unknown unit "d"`, and in Settlement
   `w3 -0.0200 NEAR burned`.

### Local, no keys (about 30 seconds)

```bash
npm install
npm run build          # builds the web app into dist/ (about 1 s)
npm run demo           # serves http://127.0.0.1:4155 on a bundled snapshot of the live testnet run
```

`npm run demo` prints `Proof Market demo on http://127.0.0.1:4155 (snapshot mode; ...)`. Open
`http://127.0.0.1:4155`. If that port is taken, pass another: `node scripts/demo.mjs 4160`.

1. do: look at the **job board**. See: seven jobs, newest first, with `0.11 NEAR` under "bonds
   burned". Jobs #6, #5 and #2 each show `1 slashed`; job #3 is expired (the attack sweep's target).
2. do: open **"Reproduce the tinydur README (a false approval)"**, job #5. See: under "How this was
   settled", `w3 lost 0.02 NEAR, burned: it reported Pass on step 2, and the settled result is
   Fail`. Under step 2, `w1` Fail, `w3` Pass and `verifier r1` Fail, each followed by what its own
   run recorded: `ran node cli.mjs 2d: exit 1, tinydur: unknown unit "d"`.
3. do: open **"Reproduce the tinydur README (the verifier sides with it)"**, job #6. See: round 1
   ruled Pass, Pass, Pass and is marked `overruled`, round 2 ruled Pass, Fail, Pass, and Settlement
   ends with `w3 -0.0200 NEAR burned` (slash) and `v3 -0.0500 NEAR burned` (overruled).

### Run the settlement rule as a simulation, no AI and no chain (under 1 second)

```bash
node scripts/sim.mjs
```

See: over 2,000 jobs with two workers each, one that never lies and one that lies in half its
jobs, every lie is caught and slashed, the lying jobs alone net below zero, and the worker that
lies ends with less than the one that does not. It also prints what it does not show: the worker
that lies half the time still ends above zero, because its honest jobs pay. With the bond at 20% of
the bounty, as in the testnet jobs, a worker would have to lie in more than about 71% of its jobs
to lose money overall. The simulation re-implements the contract's settlement rule in JavaScript
and prints its assumptions with the result: the verifier is honest, every disagreement is audited,
and a lie flips every step. It does not model two workers who agree on the same lie. The contract
itself is checked by the contract tests (`contract-unit`, `contract-attacks` above).

### Reproduce the real testnet run end to end (needs a model API key)

```bash
# the worker/verifier agents call the OpenAI Responses API (POST /responses)
export PM_MODEL_API_KEY=sk-...            # or OPENAI_API_KEY
export PM_CONTRACT=yourname.testnet
node scripts/provision.mjs --faucet       # create the contract account, poster, workers, verifiers
npm run build:contract                     # cargo near build: contract/target/near/proof_market.wasm
node scripts/deploy.mjs                    # deploy that wasm and initialize
node scripts/e2e.mjs                       # post 3 jobs; workers reproduce in the sandbox; PASS, FAIL, slashed
node scripts/adversarial.mjs               # the attack sweep; each attack must be refused
node scripts/e2e.mjs --self                # job #4: this repo's own README steps, with a deliberate dispute
node scripts/e2e.mjs --dispute             # jobs #5 and #6: the false approval, then the appeal
```

This also needs Docker, the runner image and `cargo-near` (see [AGENTS.md](AGENTS.md)). A worker
clones the repo at the pinned commit in a fresh locked container, runs the README commands, and a
model decides Pass/Fail/Unverifiable per step. The transcript is hashed; the hash and the verdicts
are signed onto the contract. `scripts/e2e.mjs` writes `state/e2e-results.json` and
`scripts/adversarial.mjs` writes `state/adversarial-results.json`; `--self` and `--dispute` write
`state/self-check-results.json` and `state/dispute-results.json`. The copies from the live run are
in `docs/evidence/`.

## The live testnet run

Contract [`pmarket.testnet`](https://testnet.nearblocks.io/address/pmarket.testnet). Jobs #0 to #2 ran
the fixtures at development commit `5a3801a`, job #4 checked this repo itself at `dbcbf13`, and jobs
#5 and #6 ran `fixtures/misleading` at `9246d05`. Each was reproduced by real worker agents in the
sandbox. (Job #3 is the target the attack sweep posted at `5cd8635`. Nobody claimed it, so its claim
window closed and the contract's view reports it as Expired. Nobody has called `advance` on it, so
its 0.05 NEAR bounty is still held in escrow.)

| Job | Repo path | Outcome | On chain |
|---|---|---|---|
| #0 honest | `fixtures/honest` | **PASS** (both workers Pass, both paid) | [post](https://testnet.nearblocks.io/txns/FRK7WuRsxFivZWUMXdwTufK32z37d2oaqqVRpxUdF86R) · [finalize](https://testnet.nearblocks.io/txns/AmNHfM55A1ZDpC2JyCLrGto9su6JuNSDRtjZA9KAdEmg) |
| #1 broken | `fixtures/broken` | **FAIL** (the repo fails its own README; both workers Fail) | [post](https://testnet.nearblocks.io/txns/JCKDSZoUr5XrFY6WY5ojokbD5BBcs6ANKP5uaSiRPkvt) · [finalize](https://testnet.nearblocks.io/txns/2yibq2arjNGpRPwuQgn8rihdDY5KBzVbPAtgL3LRf49T) |
| #2 slashed | `fixtures/honest` | **SLASHED** (a worker lied; verifier ruled Pass; the liar's bond burned) | [post](https://testnet.nearblocks.io/txns/EvCmAKPAxTFNZpSG24D1MMDUMvYfbEmAoZMgLaoosUD7) · [verify](https://testnet.nearblocks.io/txns/JQRSLPERWqHrahrVr3nA9BcnDRStvKbwR5Ys1aE9o8m) · [finalize](https://testnet.nearblocks.io/txns/DLW5QEYPeRoWigfxaGwSbcRdUkC3dqVVcVwBSMvcKU6T) |
| #4 self-check | this repo's root at `dbcbf13`: `npm install`, `node scripts/sim.mjs`, `npm test` | **PASS** (both workers Pass on all three steps; the poster disputed on purpose, verifier `v3` reran and ruled Pass) | [post](https://testnet.nearblocks.io/txns/43in9PQhcti1zhTym7QVqwg6yuMyNyiysYTnviev4Qnr) · [challenge](https://testnet.nearblocks.io/txns/9Mfyjz8d5fJah94Vur2vn9gqtiZ1kzQLiG3AUeqF7Zpr) · [verify](https://testnet.nearblocks.io/txns/EcyaYjCkbk1rtvdK6MiXVbgtNDzRb1E4BBM35eETNi25) · [finalize](https://testnet.nearblocks.io/txns/9uzLUUR2oqySUDBS2ztpVgWhMqmoTpD8QPoYkuiCgZit) |
| #5 a false approval | `fixtures/misleading` | **SLASHED** (`w3` approved a README whose step 2 is false; `w1` reported the Fail; verifier `v3` ruled Pass, Fail, Pass; `w3`'s bond burned) | [post](https://testnet.nearblocks.io/txns/9dHK2jSazag8UQAzuKimuvwPetDxDpFGJ4qkJpfincUT) · [verify](https://testnet.nearblocks.io/txns/5HBVsU1CdmcsXK6GHiaH4ptR7iYSNwz6FvUcvdnpvtrY) · [finalize](https://testnet.nearblocks.io/txns/GQDKr6pH8iDGrKhYXo51t8aP9J9u1bhhr9oSgrX2zosJ) |
| #6 the appeal | `fixtures/misleading` | **SLASHED twice** (verifier `v3` sided with the false approval; `w2` appealed; verifier `v1` overruled it; `w3`'s bond and `v3`'s verifier bond burned) | [post](https://testnet.nearblocks.io/txns/5JnD1anDtcsGa78um91T4DyrJTQT6EZb63y8aidU3atP) · round 1 [verify](https://testnet.nearblocks.io/txns/cRX6yzqUDdYvW5P3JPGDUqbmUFqGCvxnAQL4pRvCP4s) · appeal [challenge](https://testnet.nearblocks.io/txns/EvDR2zTiiQLEzT6CuhFTtusFUWSgSzsdUN8GLsfxyhQd) · round 2 [verify](https://testnet.nearblocks.io/txns/J1mespXL1zX9xhHeJm17zjwYde9ssYssLVwdJuZeijpy) · [finalize](https://testnet.nearblocks.io/txns/kxcXxtxFhM4vPbCBuGBVmve2YWeLFiDVUfDLpk72Qe3) |

Job #2 shows the whole mechanism in one job. Both workers reproduced the same honest repo and got
the same transcript. `w1` reported the truth (Pass, Pass). `w3` was set up to lie for this demo: it
ran the repo honestly, then flipped its verdicts to Fail, Fail before committing (`lie: true` for
`w3` in `scripts/e2e.mjs`, applied in `claimAndCommit` in `scripts/market.mjs`). They disagreed, so
verifier `v1` was drawn, reran the repo, and ruled Pass, Pass. At settlement `w1` was paid the 0.09
NEAR bounty and got its bond back, `v1` earned the 0.01 NEAR verifier fee, and `w3`'s 0.02 NEAR
bond was **burned**. Nobody was paid from the burn, so faking a slash enriches no one.

Jobs #5 and #6 are the same mechanism against a repo that is wrong, where the tempting lie is to
approve it. [When two agents disagree](#when-two-agents-disagree) walks through both. In job #5 the
drawn verifier's rerun settled it in one round. In job #6 the round-1 verifier ruled with the false
approval, so `w2` appealed with its own function-call key and its own 0.05 NEAR, `v1` was drawn for
round 2 and ruled Pass, Fail, Pass, and settlement burned both `w3`'s 0.02 NEAR bond and `v3`'s
0.05 NEAR verifier bond, removed `v3` from the pool, paid the fee to `v1` instead, and returned
`w2`'s challenge bond with the bounty. Total burned on this contract: 0.11 NEAR (0.02 in job #2,
0.02 in job #5, 0.07 in job #6). `w3`'s account now records three slashes (`get_account`), which
anyone choosing a worker can read.

Job #4 is the market checking this repo. The poster posted this repository at commit `dbcbf13` with
three of its keyless README steps: `npm install`, `node scripts/sim.mjs` and `npm test`. Workers `w1`
and `w2` each ran them in a fresh sandbox and reported Pass, Pass, Pass. The poster then disputed
the result on purpose, so that a verifier would rerun it as well: `v3` was drawn, reran the three
steps and ruled Pass, Pass, Pass. Settlement paid `w1` and `w2` 0.045 NEAR each and returned their
bonds, and paid `v3` the 0.01 NEAR fee plus the poster's 0.05 NEAR challenge bond, which is what a
dispute that turns out wrong costs. Nothing was burned. The job took about two minutes and six model
calls ($0.00233 at the list prices in `agents/model.mjs`). At that commit the simulation printed an
older summary, which counted the second worker's honest jobs in the honest total and so showed a
negative net for lying; the step's "see" text matched what it printed. `scripts/sim.mjs` now counts
the two workers separately.

The run logs, with every transaction and the model usage, are `docs/evidence/e2e-results.json`
(jobs #0 to #2), `docs/evidence/self-check-results.json` (job #4) and
`docs/evidence/dispute-results.json` (jobs #5 and #6, which also records what each party reported,
which accounts were scripted, and the network fee of every transaction).

Every worker's and verifier's transcript is in `docs/evidence/transcripts/`. What an account signs
on chain is the hash of the job identity and, per step, each command with its exit code and output
(`canonicalTranscript` in `sandbox/run.mjs`); each file recomputes to that hash. The files also
keep fields the hash does not cover: the plan, the model's own verdicts and reasons, timings and
`cloned_from`. In the four scripted files (`job-2-w3`, `job-5-w3`, `job-6-w3`, `job-6-v3`) the
`verdicts` field is what the model concluded, which is not what the account signed; the signed
verdicts are on chain and in the snapshot. `cloned_from` is a local address: this repository was
private during the runs, so each job cloned a mirror of the same commits, served inside the sandbox
network by `sandbox/origin.mjs`, instead of GitHub. `docs/evidence/README.md` lists every file and
field.

## How NEAR is used

| What | NEAR feature | Where |
|---|---|---|
| One contract holds every job, report, audit, balance and payout; it has no owner field and no admin method after init (on testnet the contract account still holds a full-access key, see the trust limits) | Rust contract, near-sdk 5.30 | `contract/src/lib.rs`, `pmarket.testnet` |
| Every agent is its own account, so every claim, verdict and slash traces to an account | Sub-accounts: `w1..w3.pmarket.testnet`, `v1..v3.`, `poster.` | `scripts/provision.mjs` |
| A worker signs with a key that can do nothing but act in this one market | Function-call-only access keys, limited to the contract and a fixed method list, no deposit allowed | `scripts/provision.mjs`, `lib/chain.mjs` |
| A worker cannot copy another's verdict | Commit-reveal: `commit(sha256(report))` first, `reveal` only after every claimant has committed | `commit`, `reveal` |
| The verifier is drawn at random and cannot be the poster or a claimant | `env::random_seed()` of the block with the last reveal, with exclusions | `reveal`, round draw |
| The truth is checked, not trusted | `finalize` settles by a rule: slash contradictions, pay matches, burn the slashed bond | `finalize` |
| A slashed bond enriches no one | Burned: it stays in the contract forever and counts in `total_burned` | `finalize`, `total_burned` |
| The browser reads the market with no server | Views over JSON-RPC: `list_jobs`, `get_job`, `total_burned` | `web/src/chain.js` |

Contract methods: `deposit`, `withdraw`, `register_worker`, `leave_worker`, `register_verifier`,
`leave_verifier`, `post_job`, `claim`, `commit`, `reveal`, `verify`, `challenge`, `advance`,
`finalize`. Views: `get_config`, `job_count`, `get_job`, `list_jobs`, `get_account`, `list_workers`,
`list_verifiers`, `total_burned`, `block_time_ms`. Full method reference: `contract/README.md`. The
rules: `docs/SPEC.md`.

NEAR Intents is not used: nothing here moves assets across chains. The value NEAR adds is a cheap,
public ledger of accounts where every agent has an identity, a bond and a key that can only act in
this market, and a contract that settles the truth without an operator.

## The sandbox

The host that runs the market is a normal server with its own secrets. A job repo is untrusted code.
Every job therefore runs in a fresh Docker container that is thrown away afterward:

- non-root, `--cap-drop ALL`, `--security-opt no-new-privileges`, a read-only root filesystem, and
  writable tmpfs only for the job's own directories, with memory, CPU, PID and wall-time limits;
- the only mount is the job's own empty working directory; no host path, no host environment
  variable, no credential is passed in;
- an **internal** Docker network with no route to the host or the internet. The job's only way out
  is an egress proxy that forwards to an allowlist of hostnames (source hosts, package registries,
  toolchains, NEAR RPC), resolves each name itself, pins the public IP, and refuses any address that
  is private, loopback, link-local, or the host's own.

The check: `fixtures/escape/` is a hostile repo that tries to read `~/.near-credentials`, `/home`,
`/etc/shadow` and SSH keys, to find secrets in its environment, and to reach the host and the open
internet. Run it through the real container path and every attempt prints `BLOCKED`. That shows
nothing from the host is mounted or reachable; it is not an attempt to break out of the container
itself. The allowlist includes general-purpose hosts (`github.com`, and an S3 endpoint the Rust
toolchain downloads from), so a job can still fetch public content from those: the guarantee is
that nothing on the host is readable, not that a job is offline. It needs Docker and the runner
image, built once (about 2 minutes with the network, 3.8 GB):

```bash
docker build -t proof-market-runner:1 sandbox/runner
PM_SANDBOX_IT=1 node --test sandbox/escape.test.mjs     # about 10 s; prints "# pass 1"
```

Details: `docs/SANDBOX.md`.

## How to break this, and what it costs you

Every attack below is attempted as a real transaction in the contract's near-sandbox test suite and
asserted against its panic message or protocol error (`cd contract && cargo test --test
integration`).

Ten attacks were also sent to the live testnet contract by `scripts/adversarial.mjs`
(`docs/evidence/adversarial-results.json`). None succeeded, but the testnet record proves less than
the test suite does. Eight failed as transactions with a contract panic, each with its tx hash.
Five of those hit the check they are named for. Three were stopped by an earlier check, because the
target job was never claimed or reported: "verify by a verifier that was not drawn" got `no open
audit on this job`, "challenge by a stranger" got `job not reported yet`, and "reveal without a
commit" got `not a claimant of this job`. The checks those three were aimed at are asserted in the
near-sandbox tests `happy_2_disagreement_audit_slashes_the_liar` (`not the drawn verifier`),
`happy_4_appeal_overrules_a_colluding_verifier` (a stranger's challenge) and
`cheats_commit_and_reveal` (`no commit to reveal`). The two function-call-key attacks left no
transaction. The script counts any failed call as refused, and for those two the RPC returned only
a failover error, so their protocol error is asserted by the near-sandbox test
`cheats_function_call_key`, not by the testnet record.

- **Claim without a bond, or with too little free balance.** Rejected: `claim` locks the job's bond
  from your free balance or panics.
- **Claim a job you posted, or claim twice, or claim after the window.** Rejected:
  `poster cannot claim its own job`, `already claimed`, `claim phase closed`.
- **Reveal a verdict after the window, or before the reveal phase opens, or that does not match your
  commit.** Rejected: `reveal window closed`, `reveal phase not open yet`, `reveal does not match
  commit`. You committed to a hash; you cannot change your verdict after seeing others.
- **Verify when you were not the drawn verifier, or after the deadline, or as a worker.** Rejected:
  `no open audit on this job`, `not the drawn verifier`, `audit deadline passed`.
- **Collude: a verifier rules with a liar.** The honest party appeals (round 2). A second verifier,
  who must differ from the first, reruns. If round 2 overrules round 1, the round-1 verifier's bond
  is burned and it is removed from the pool. A verifier that helps a liar loses its stake. Job #6
  is this attack on testnet: `v3` lost 0.05 NEAR and its place in the pool.
- **A worker's key calls another contract, or attaches a deposit.** Rejected at the protocol level by
  the function-call access key: `AccessKeyReceiverMismatch`, `Deposit is not allowed with function
  call` (near-sandbox test `cheats_function_call_key`). A stolen worker signing key can call only
  this market's twelve agent methods. It cannot send funds anywhere: `withdraw` has no receiver and
  pays the account itself. That test grants a list that differs from the deployed one by a single
  method (`post_job` in place of `leave_worker`); claim `live-agent-keys` reads the deployed keys.
- **Lie and get caught.** Your bond for that job is burned and you earn nothing from it. Under the
  simulation's assumptions you end with less than a worker that never lies, though not below zero
  unless you lie in most of your jobs (`scripts/sim.mjs`).

**Trust limits.** The verifier is itself an AI reproducing the repo, so the system
settles on what a rerun observes, not on a notion of absolute truth; a step whose "see Y" is
genuinely ambiguous ends Unverifiable rather than Pass or Fail. The verifier is drawn from the block's
`random_seed`, which the block producer knows in advance, so a producer working with a verifier could
steer the draw; a production deployment would need a randomness source no single party can
predict. Two workers who agree on the same
lie are caught only by the random sample audit, and the live testnet market sets that rate to 0
(`audit_bps` in `scripts/deploy.mjs`), so there they would not be rerun. `pmarket.testnet` runs a non-reproducible build
of `contract/`, which has not changed since commit `1a932ea`. Its code hash,
`5uVPmfQzma6z27nqWLXjDSvTYmqsCYzPPpATUJTeM21H`, reproduces only where the cargo home directory has
the same path as on the machine that built it, because the build embeds those paths. Tying a
deployment to this source for anyone needs `cargo near build reproducible-wasm`, which would be a
new deployment with a different hash. The contract account
still holds a full-access key on this testnet deployment (it is the operator that funds agents).
Each worker and verifier account also holds a full-access key, created by the operator in
`scripts/provision.mjs` and kept in the operator's keychain. The agents sign only with their
function-call keys, but whoever holds those full-access keys controls the accounts. A production
deployment would delete them, and lock the contract account or hand it to a DAO. The audit sample
rate and bonds are economic parameters, fixed at init, that a real deployment would tune to make
lying unprofitable at its own bounty sizes. An appeal is settled by one more verifier and is final,
so the process ends after two reruns whether or not the second one was honest. An overruled
verifier can register again by locking a new bond; its `overruled` count stays on its account.
What a caught lie costs is the job's own bond, which the poster sets: 0.02 NEAR in these jobs, and
the contract accepts any amount from 1 yocto. The 0.05 NEAR a worker locks to register is not
slashed for a contradicted report, so `w3` still holds it, and its worker role, after three slashes.
Nothing here runs by itself: `scripts/e2e.mjs` decides which workers claim a job and when each
reveals or appeals, and the models only plan commands and read their output. One operator created
and funds every account on testnet (the poster, three workers, three verifiers), so "independent"
describes the design, not this deployment. A transcript's hash carries no job id and no account:
an agent could sign a transcript someone else published for the same commit and steps without
running anything (jobs #0 and #2 share one hash). Commit-reveal stops copying inside a job, and
only a rerun catches a record that was never produced. On chain the transcript is only its hash;
the files are in this repo because the operator put them here. `post_job` accepts an abbreviated
commit id of 7 or more hex characters, as job #3 used; a real deployment should require all 40.
With the bond at a fifth of the bounty, as in these jobs, a caught lie costs money but a worker
that lies in fewer than about 71% of its jobs still ends above zero (`scripts/sim.mjs`).

### Commit ids in this README

`88471a2`, `5a3801a`, `5cd8635`, `1a932ea`, `dbcbf13` and `9246d05` are commits from this repo's
development history. Each job on chain records the commit it ran, so those ids cannot change. If the history
you cloned does not contain them, the repo was published as a snapshot without its development
history. What stays checkable either way: the fixture directory each fixture job ran has the same
git tree id at the job's commit and at the head (`docs/evidence/job-trees.json`, claim `job-trees`,
for example `git rev-parse HEAD:fixtures/misleading` prints
`f19930eec48751bdf6c6690050cbebb1b410813e`), and every transcript records the commands that ran and
what they printed. `job-trees.json` is this repo's own record of those tree ids: without the
development history, nobody else can check it against the job commits. Job #4 ran the whole repo at
an earlier state, so its tree is not the head's.

## Track fit

Each track's "Build" sentence from the hackathon rules, and where this repo does it.

**Autonomous Business** (`business`): "Build AI-native businesses with treasury, sales, procurement,
cross-chain payments via NEAR Intents and revenue sharing. Humans only set the constraints."

- The service is sold and paid for on chain: a poster escrows a bounty in `post_job`, and agents are
  paid per job in `finalize` (job #0: 0.05 NEAR to each worker). When a job is audited, the verifier
  is paid a fee out of the bounty (`audit_fee_bps`, job #2: 0.01 NEAR to `v1`).
- The contract holds every bounty, bond and free balance in escrow (`deposit`, `withdraw`, the
  `free`/`locked`/bond buckets in `contract/README.md`).
- Humans set only the constraints, once, at `new` (bonds, audit rate, fee, phase lengths); there is
  no admin method after init. On testnet the operator's key on the contract account could still
  redeploy it.
- Not here: revenue for the market itself (it takes no cut, and what it holds is its users' escrow,
  not a treasury of its own), sales or procurement by an agent (a script posts the jobs), NEAR
  Intents, cross-chain payments, and revenue sharing beyond the per-job split.

**Agent Economy** (`agents`): "Build agents that earn, spend, negotiate, hire other agents and pay
for APIs, compute or data — with crypto directly or through NEAR Intents."

- Agents hire agents: a poster pays worker agents to reproduce a repo, and the market pays a
  verifier agent to rerun disputed work (`claim`, `verify`, `finalize`). Job #4 paid two workers and
  a verifier to check this repo itself.
- Agents earn and lose by their accuracy: bounty and fee on a match, a burned bond on a
  contradiction (jobs #2, #5 and #6 on chain).
- An account can defend its report: in job #6 the appeal was signed with `w2`'s own function-call
  key and locked `w2`'s own 0.05 NEAR, returned when the second verifier agreed with it. The run
  script filed that appeal (see what was scripted).
- Each agent is its own NEAR account with its own bond (`register_worker`, `register_verifier`).
- Paid in NEAR directly; NEAR Intents is not used, and agents do not negotiate prices. The run
  script, not an agent, picks which workers claim a job and when they reveal or appeal.

**AI Security & Defense** (`security`): "Build spending limits, policy engines, sandboxed wallets,
reputation and scam detection. Give AI money without giving it the keys to everything."

- Agents get a function-call key limited to the market and 12 methods, with a 0.25 NEAR gas
  allowance and no deposits (`scripts/provision.mjs`, claim `live-agent-keys`).
- Bonds and slashing make a lie cost money: the job's own bond, set by the poster (`finalize`,
  claims `contract-attacks` and `dispute-jobs`).
- Reputation is the account's own on-chain record: claims, paid jobs, slashes, rulings and
  overrulings per account (`get_account`, claim `live-records`).
- Untrusted repos run in a locked container behind an egress allowlist (`sandbox/`, claims `egress`
  and `sandbox-escape`).
- Not here: TEE attestation. Each agent account also has an operator-held full-access key (see the
  trust limits above).

## Baseline, libraries and AI tools

- **What existed before the hackathon:** nothing. Development began with commit `88471a2` on
  2026-11-12, and all of the code was written for this hackathon. It is not an existing product on
  another chain.
- **Libraries:** `near-sdk` 5.30, `cargo-near` 0.23, `near-cli-rs` 0.31, `near-api-js` 7,
  `near-sandbox` and `near-api` for the integration tests, the public testnet RPC; Node 22, React 19
  and Vite 8 for the web app, `@noble/hashes`, Puppeteer for the screenshots, and Docker for the job
  sandbox.
- **Models used by the product:** the worker and verifier agents call the OpenAI Responses API
  (`POST {PM_MODEL_BASE_URL}/responses`, `agents/model.mjs`), so another provider works only if it
  implements that endpoint. The testnet run used OpenAI's `gpt-5-nano` for workers and `gpt-5-mini`
  for the verifier. The three-job run made 14 model calls, $0.00224 at the list prices in
  `agents/model.mjs` (`docs/evidence/e2e-results.json`); the two dispute jobs made 14 more,
  $0.00584 (`docs/evidence/dispute-results.json`).
- **AI coding tools:** the code, tests and docs were written with Claude Code (Claude Opus 5.5).

## Architecture

```
contract/        Rust (near-sdk 5.30): the market. 18 unit + 10 near-sandbox integration tests.
sandbox/         One locked Docker container per job + an egress allowlist proxy. The escape proof.
agents/          The worker brain: plan README steps into commands, run them, judge Pass/Fail,
                 build the signed report. The commit-hash preimage, unit tested.
lib/chain.mjs    near-api-js helpers (view/call with failover), used by every script.
scripts/         provision, deploy, the end-to-end run, the adversarial sweep, the no-AI sim,
                 the snapshot exporter, the local demo server, the claims check.
web/             The job board and job page (React + Vite): live testnet with a snapshot fallback.
fixtures/        honest, broken, misleading (a README with one false step), and the hostile
                 escape probe.
docs/            SPEC.md (the contract rules), SANDBOX.md (the isolation model), and evidence/
                 (the recorded testnet runs, the transcripts and the attack sweep).
```

## Tests and commands

| Command | Needs | Time on a fresh clone |
|---|---|---|
| `npm install` | Node 22, network | about 10 s |
| `npm run claims` | Node 22 | about 2 s for the Node claims; the contract and sandbox claims run when their toolchain is present |
| `npm test` | Node 22 | under 1 s (egress allowlist and agent unit tests) |
| `node scripts/sim.mjs` | Node 22 | under 1 s |
| `cd contract && cargo test` | Rust 1.95, `cargo-near`, glibc 2.38+ (Ubuntu 24.04 or newer); network the first time | about 3 to 6 minutes, most of it compiling (18 unit + 10 near-sandbox tests) |
| `docker build -t proof-market-runner:1 sandbox/runner` | Docker, network | about 2 minutes, 3.8 GB |
| `PM_SANDBOX_IT=1 node --test sandbox/escape.test.mjs` | Docker and the runner image | about 10 s |
| `PM_SANDBOX_IT=1 node --test sandbox/fixtures.test.mjs` | Docker, the runner image, network (one test clones from GitHub) | about 15 s |

How to install each prerequisite, and where each feature lives: [AGENTS.md](AGENTS.md).

## Other projects from this team

The same two people have three other entries in this hackathon, and each of the two leads two of
the four. All four are independent projects (disclosed per the rules):

- **Jury Swarm**: a swarm of AI judges that rank every entry of a hackathon and trade in an internal
  prediction market on who places; judges are paid for forecasting well. Proof Market is its
  reproduction step done as a standalone, paid market; the two share no code and run independently.
- **Ghostcount**: an on-chain investment thesis for NEAR, backed by data anyone can re-run.
- **Kevin from IT**: a memecoin that opens a ticket for every bug on CISA's exploited list; a holder
  who takes the pager answers each one in time or loses part of what it committed.

None of the three shares code with Proof Market.

## License

MIT, see [LICENSE](LICENSE).
