# What is in this directory

The record of the runs on `pmarket.testnet`. Nothing here is needed to use the market; it is here so
that each statement in the main README can be checked.

| File | Written by | What it holds |
|---|---|---|
| `e2e-results.json` | `scripts/e2e.mjs` | Jobs #0 to #2: every transaction hash, the outcome of each job, model usage |
| `self-check-results.json` | `scripts/e2e.mjs --self` | Job #4, the market checking this repo's own README steps |
| `dispute-results.json` | `scripts/e2e.mjs --dispute` | Jobs #5 and #6: what each party reported, each round, which accounts were scripted, the network fee of every transaction, model usage |
| `adversarial-results.json` | `scripts/adversarial.mjs` | The ten attacks sent to testnet: the panic or error each one got |
| `job-trees.json` | written by hand from `git rev-parse <commit>:<path>` | The git tree id of the fixture directory each fixture job ran |
| `transcripts/job-<id>-<account>.json` | `agents/worker.mjs` | One file per worker and verifier per job |

## Transcript files

What an account signs on chain is `transcriptHash` of the file (`sandbox/run.mjs`). That hash covers
only these fields:

- `job`: the repo URL, commit and path;
- whether the clone succeeded, and `aborted` if the run stopped early;
- `steps`: for each step its `do` and `see` text, and for each command its `argv`, `exit_code`,
  `timed_out`, `stdout` and `stderr`.

The files keep more, and none of it is covered by the hash:

- `plan`: the commands the model chose for each step;
- `verdicts` and `reasons`: what the model concluded from the output, and `model`, the model name;
- `started_at`, `finished_at` and each `duration_ms`;
- `clone` and `cloned_from`: where the job fetched the repo from. Every recorded job fetched a
  mirror of this repo's commits served inside the sandbox network (`sandbox/origin.mjs`), because
  the repository was private when the jobs ran.

In four files the `verdicts` field is not what the account signed, because those accounts were
scripted to report something else: `job-2-w3` (the model concluded Pass, Pass; the account signed
Fail, Fail), and `job-5-w3`, `job-6-w3` and `job-6-v3` (the model concluded Pass, Fail, Pass; the
account signed Pass, Pass, Pass). The signed verdicts are on chain (`get_job`) and in
`web/public/data/snapshot.json`.

The older logs (`e2e-results.json`, `self-check-results.json`) carry a `job` id only on each
`post` transaction; `dispute-results.json` carries it on every transaction.

Two runs of the same commands hash the same only when their output is identical. The hash has no
job id and no account in it, so the same record can be signed in more than one job: jobs #0 and #2
ran the same fixture at the same commit and share one hash. `node --test`
prints a duration, so in jobs #5 and #6 each party's hash differs even though the commands, exit
codes and results agree.
