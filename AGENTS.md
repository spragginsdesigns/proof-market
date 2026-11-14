# Working in this repo

Proof Market is a NEAR contract (Rust), Node worker and verifier agents that reproduce a repo's
README steps in a Docker sandbox, and a React web app that shows the market. This guide is for
anyone working in the repo: what to install, the commands in order, what each one prints, where each
feature lives, and the known limits. What the project is and why: [README.md](README.md).

Times below were measured on a fresh clone in clean `node:22` and `ubuntu:24.04` containers.

## Prerequisites

| Tool | Needed for | Install |
|---|---|---|
| Node 22 and npm | everything except the contract | https://nodejs.org (any Node 22 build) |
| Rust 1.95 with the `wasm32-unknown-unknown` target | the contract and its tests | `curl -sSf https://sh.rustup.rs \| sh -s -- -y --profile minimal`, then `source ~/.cargo/env`. `contract/rust-toolchain.toml` pins 1.95.0 and the target; rustup installs them on the first `cargo` command in `contract/` (about 15 s) |
| `cargo-near` 0.23 | the contract integration tests (they build the wasm with it), `npm run build:contract` | the release binary, about 2 s: `curl -fsSLo /tmp/cn.tgz https://github.com/near/cargo-near/releases/download/cargo-near-v0.23.0/cargo-near-x86_64-unknown-linux-gnu.tar.gz && mkdir -p /tmp/cn && tar -xzf /tmp/cn.tgz -C /tmp/cn && install -m 0755 "$(find /tmp/cn -type f -name cargo-near)" ~/.cargo/bin/` |
| glibc 2.38 or newer | the near-sandbox binary the integration tests start | Ubuntu 24.04 or newer. Debian 12 (glibc 2.36, the default `node:22` image) runs the unit tests but not the integration tests |
| A C toolchain | compiling the contract tests' dependencies | on Ubuntu: `apt-get install -y build-essential pkg-config libssl-dev curl git` (about 40 s) |
| Docker | the job sandbox tests and the end-to-end testnet run | https://docs.docker.com/engine/install/ ; then build the runner image (below) |

No key is needed for anything except the end-to-end testnet run.

## Commands, in order

| # | Command | Time | Network | Key | Prints |
|---|---|---|---|---|---|
| 1 | `npm install` | about 10 s | yes | no | the npm summary. Puppeteer's browser download is off (`.puppeteerrc.json`); only `scripts/shots.mjs` needs it, see below |
| 2 | `npm run claims` | about 2 s with Node only | no (the contract tests fetch crates the first time) | no | one `PASS`/`FAIL`/`SKIP` line per README claim, then `17 claims: N PASS, N FAIL, N SKIP`. Exits 1 on any FAIL. SKIP lines name the missing tool. `job-trees` needs a git clone, not a zip download |
| 3 | `npm run claims -- --live` | adds about 10 s | yes | no | nine more lines that read `pmarket.testnet` over public JSON-RPC, then `26 claims: ...`. A live line is `SKIP`, not `FAIL`, when no public RPC answered (they rate-limit bursts); run it again |
| 4 | `npm test` | under 1 s | no | no | `# pass 12` (egress proxy and agent unit tests) |
| 5 | `npm run build` | about 1 s | no | no | Vite's file list and `built in ...ms`; the app is in `dist/` |
| 6 | `npm run demo` | starts at once | no | no | `Proof Market demo on http://127.0.0.1:4155 (snapshot mode; ...)`. Serves `dist/` with the bundled snapshot of the testnet run |
| 7 | `node scripts/sim.mjs` | under 1 s | no | no | the net of a worker that never lies and of one that lies in half its jobs (honest and lying jobs shown apart), lies caught, bonds burned, the simulation's assumptions and what it does not show |
| 8 | `cd contract && cargo test` | 3 to 6 min on a fresh clone, under 1 min after | first run only | no | `test result: ok. 18 passed` (unit) and `test result: ok. 10 passed` (near-sandbox integration) |
| 9 | `docker build -t proof-market-runner:1 sandbox/runner` | about 2 min, 3.8 GB | yes | no | the image id. Ubuntu 24.04 with Node 22, Rust, `cargo-near` and the `near` CLI, all checksum-verified |
| 10 | `PM_SANDBOX_IT=1 node --test sandbox/escape.test.mjs` | about 10 s | no | no | `# pass 1`: the hostile fixture read and reached nothing on the host |
| 11 | `PM_SANDBOX_IT=1 node --test sandbox/fixtures.test.mjs` | about 15 s | yes (one test clones from GitHub) | no | `# pass 3` |

Steps 8 and 10 are also run by `npm run claims` when their tools are present.

### The end-to-end testnet run (needs keys)

Needs Docker, the runner image, `cargo-near`, a model API key and a testnet account from the faucet.
It signs testnet transactions only.

```bash
export PM_MODEL_API_KEY=...            # OpenAI Responses API key (OPENAI_API_KEY also works)
export PM_CONTRACT=yourname.testnet
node scripts/provision.mjs --faucet    # contract account, poster, w1-w3, v1-v3, function-call keys
npm run build:contract                 # contract/target/near/proof_market.wasm
node scripts/deploy.mjs                # deploy and initialize (config in scripts/deploy.mjs)
node scripts/e2e.mjs                   # three jobs: PASS, FAIL, slashed; writes state/e2e-results.json
node scripts/adversarial.mjs           # attack sweep; writes state/adversarial-results.json
node scripts/e2e.mjs --self            # job #4: this repo's own README steps plus a deliberate dispute;
                                       # writes state/self-check-results.json
node scripts/e2e.mjs --dispute         # jobs #5 and #6 on fixtures/misleading: a false approval is
                                       # slashed, then a verifier that sides with it is overruled on
                                       # appeal; writes state/dispute-results.json
node scripts/snapshot.mjs              # refresh web/public/data/snapshot.json from the chain, and
                                       # evidence.json from docs/evidence/transcripts/
```

The recorded results of the live run are in `docs/evidence/`, with every worker's and verifier's
transcript in `docs/evidence/transcripts/`. The three-job run made 14 model calls
for $0.00224, the self-check job 6 calls for $0.00233, and the two dispute jobs 14 calls for
$0.00584, at the list prices in `agents/model.mjs`.

A job on chain cannot be rerun under the same id. Running `--dispute` again posts two new jobs, and
`ensureRegistered` in `scripts/e2e.mjs` puts an overruled verifier back in the pool with a new bond.
After a new run, copy the new run log and transcripts into `docs/evidence/`, refresh the snapshot,
and update the job ids and counts in `scripts/claims.mjs` and the README together.

### Screenshots

`scripts/shots.mjs` drives the built app in Chrome. Install the browser once with
`npx puppeteer browsers install chrome`, run `npm run demo`, then `node scripts/shots.mjs`.

## Where each feature lives

| Feature | Code | Contract method or view | On testnet |
|---|---|---|---|
| Post a job, escrow the bounty | `contract/src/lib.rs` | `post_job` | job #0 `post` tx in the README |
| Claim with a bond | `contract/src/lib.rs`, `scripts/market.mjs` | `claim` | `claim` txs in `docs/evidence/e2e-results.json` |
| Commit, then reveal | `agents/report.mjs` (preimage), `contract/src/lib.rs` (`report_preimage`) | `commit`, `reveal` | `commit` and `reveal` txs in the run log |
| Verifier draw and sample audit | `contract/src/lib.rs` (`draw_index`, `sample_roll`) | drawn inside `reveal`; `verify` | job #2: `v1.pmarket.testnet` |
| Settlement, slash and burn | `contract/src/lib.rs` | `finalize`, `total_burned` | `finalize` txs of jobs #2, #5 and #6; `total_burned` = 0.11 NEAR |
| Dispute and appeal | `contract/src/lib.rs` | `challenge`, `advance` | job #4 (a round-1 dispute that the verifier ruled against); job #6 (an appeal that overruled the round-1 verifier and burned its bond); near-sandbox tests `happy_4_appeal_overrules_a_colluding_verifier`, `happy_5_failed_appeal` |
| A false README step, caught | `fixtures/misleading/` (see its `FIXTURE.md`), `scripts/e2e.mjs --dispute` | `reveal`, `verify`, `finalize` | job #5: `w3` slashed after `v3` ruled Pass, Fail, Pass |
| Per-account record | `contract/src/lib.rs` (`Stats`) | view `get_account` | `w3`: 3 slashes; `v3`: 1 overruled, out of the pool |
| Agent accounts and function-call keys | `scripts/provision.mjs` (`AGENT_METHODS`) | none | `w1`-`w3`, `v1`-`v3` and `poster` under `pmarket.testnet` |
| Worker brain: plan, run, judge | `agents/worker.mjs`, `agents/model.mjs` | none | |
| Job sandbox and egress proxy | `sandbox/run.mjs`, `sandbox/egress/proxy.mjs`, `sandbox/runner/Dockerfile` | none | |
| Web app | `web/src/`; the recorded output shown beside each verdict comes from `web/public/data/evidence.json` | views `list_jobs`, `get_job`, `total_burned` | reads `pmarket.testnet` when built with `VITE_CONTRACT` |
| Hosted demo | `.github/workflows/pages.yml` (manual; builds with `VITE_CONTRACT=pmarket.testnet`, publishes `dist/`) | the same views, called from the visitor's browser | https://spragginsdesigns.github.io/proof-market/ |
| Claims check | `scripts/claims.mjs` | views and `tx` lookups with `--live` | |
| Contract rules | `docs/SPEC.md`, method table in `contract/README.md` | | |

## Known limits

- The verifier is itself an AI that reruns the repo. The market settles on what a rerun observes; an
  ambiguous "see Y" ends Unverifiable.
- The verifier is drawn from the block's `random_seed`, which the block producer knows in advance.
- The live testnet market has `audit_bps` 0, so only disagreements are audited there. Two workers
  who agree on the same lie would not be rerun.
- The contract account and every worker and verifier account hold a full-access key kept by the
  operator. Agents sign only with their function-call keys.
- Job #2's liar is scripted: `w3` runs the repo honestly, then flips its verdicts (`lie: true` in
  `scripts/e2e.mjs`). So are the false approvals in jobs #5 and #6 (`lie: 'approve'`) and the
  round-1 verifier in job #6 (`collude`, whichever verifier the contract drew): each ran the steps
  honestly, then signed Pass on every step. The appeal in job #6 is scripted too (`appealBy`): the
  run script files it with `w2`'s key as soon as the round-1 ruling lands.
- There is no always-on agent. `scripts/e2e.mjs` picks which workers claim a job and when each
  reveals or appeals; the models plan the commands and read their output.
- A caught lie burns the job's own bond, which the poster sets (any amount from 1 yocto). The
  standing bond a worker locks to register is never slashed.
- A transcript's hash covers the commands, exit codes and output. Its `plan`, `verdicts`,
  `reasons`, timings and `cloned_from` fields are not hashed; `docs/evidence/README.md` explains
  each. The recorded jobs cloned a local mirror of this repo, because it was private at the time.
- Three of the eight testnet attack transactions were stopped by an earlier check than the one
  they are named for (the README's "How to break this" names them).
- An appeal is one more rerun and is final. The verifier pool on testnet now holds `v1` and `v2`.
- The commit ids in the README are development commits. A copy of the repo published without its
  history does not contain them; `docs/evidence/job-trees.json` ties each fixture job to a git tree
  id that does not depend on history.
- `scripts/sim.mjs` re-implements the settlement rule under stated assumptions; the contract tests
  are the check of the contract itself. It shows that a lie costs its bond and that lying earns
  less than honesty, not that lying loses money overall: at these bond sizes a worker that lies in
  half its jobs still ends above zero.
- A transcript hash has no job id or account in it, so it does not prove the signer ran anything.
- One operator runs every testnet account.
- On testnet, the two function-call-key attacks left only an RPC failover error, no transaction;
  their protocol error is asserted in the near-sandbox test `cheats_function_call_key`.
- `pmarket.testnet` runs a non-reproducible build of `contract/`; its code hash reproduces only on
  the machine that built it (the build embeds local paths). `cargo near build reproducible-wasm`
  is the reproducible route.
- No NEAR Intents, Chain Signatures or TEE attestation.

## Working rules

- Testnet only. Never commit keys: `state/`, `keys/`, `.env*` and `*.key.json` are gitignored, and
  no script prints a key.
- After a contract change, run `cd contract && cargo test`. After a JS change, run `npm test`.
- If a README claim changes, change its check in `scripts/claims.mjs` and its row in the README's
  claims table in the same commit, then run `npm run claims`.
