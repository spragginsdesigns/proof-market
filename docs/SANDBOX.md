# The job sandbox

Every job runs in a fresh Docker container that is thrown away afterward. The host that runs the
market is a normal server with its own secrets; the sandbox exists so that an untrusted job repo
can read and reach nothing of it.

## What a job gets

- **One fresh container per job**, from `proof-market-runner:1` (built from `sandbox/runner/Dockerfile`:
  Ubuntu 24.04 with Node 22, Rust 1.99 + wasm target, `cargo-near`, the `near` CLI, Python 3, git;
  every download pinned and checksum-verified at build time).
- **A non-root user** (`uid 10001`), `--cap-drop ALL`, `--security-opt no-new-privileges`, a
  **read-only root filesystem**, and writable `tmpfs` only for `/work`, `/tmp` and `$HOME`, each
  owned by the job user and capped in size.
- **Resource limits**: memory, swap=memory (no swap), CPUs, a PID limit, a per-command wall-clock
  cap and a whole-job wall-clock cap (`sandbox/run.mjs` `LIMITS`).
- **The only mount is the job's own empty `/work`**. No host path is mounted into the job. No host
  environment variable and no credential is passed in; the only env set is the proxy variables, a
  `NO_PROXY` list, and two build hints.

## The network

The job sits on an **internal** Docker network (`docker network create --internal`): it has no
route to the host and no route to the internet. Its only way out is an **egress proxy**
(`sandbox/egress/proxy.mjs`) that runs in its own hardened container and:

- forwards only to an **allowlist of hostnames** (source hosts, package registries, Rust and Node
  toolchains, NEAR RPC: see `ALLOW` in `proxy.mjs`), on ports 80 and 443 only;
- **resolves each hostname itself (IPv4)** and refuses any address that is private, loopback,
  link-local, carrier-grade NAT, or belongs to the host (the host's own IPs are passed in and
  blocked), so a hostname that resolves to an internal address is rejected (no DNS rebinding);
- **connects to the exact address it checked**, never to a name the client controls;
- logs every decision as one JSON line.

A job that wants to reach the open internet, the host, or a non-allowlisted host is refused.

## Fixture delivery

Demo fixtures are served from a small git-over-HTTP **origin container** (`sandbox/origin.mjs`) on
the same internal network, so a job clones a real `http://.../name.git` URL with no host mount. The
origin is infrastructure (our code, our fixtures), not the job.

## What the sandbox does and does not decide

The sandbox **runs commands and records their output** into a transcript, then hashes the whole
transcript with SHA-256. It does **not** decide Pass or Fail. Reading the transcript and judging
each "see Y" is the worker agent's job (`agents/worker.mjs`), and the hash of the transcript is what
the worker commits on chain, so the verdict is always tied to an exact, reproducible run.

## Proof it holds

`sandbox/fixtures/escape/` is a hostile repo that tries to read `~/.near-credentials`, `/home`,
`/etc/shadow`, SSH keys, read secrets from its environment, connect to the host and its services
(the Docker gateway, cloud metadata), reach the internet directly, and reach a non-allowlisted host
through the proxy. The test `sandbox/escape.test.mjs` runs it through the real container path and
asserts every attempt prints `BLOCKED`, the job runs as the non-root user, and the root filesystem
is read-only.

```
PM_SANDBOX_IT=1 node --test sandbox/escape.test.mjs
```

`sandbox/fixtures.test.mjs` additionally proves the honest fixture's steps produce their stated
output, the broken fixture's do not, the transcript hash is reproducible from its content, and a
real GitHub repo clones through the egress proxy. `sandbox/egress/allowlist.test.mjs` unit-tests the
address and hostname rules with no Docker.
