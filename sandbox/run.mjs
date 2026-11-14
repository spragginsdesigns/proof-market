// Run one job in a fresh, locked-down Docker container and return a structured transcript.
//
// Threat model: this host runs production. A job repo is untrusted. The container therefore gets:
//   - its own empty working directory as the ONLY mount (the cloned repo), nothing from the host;
//   - no host environment and no credentials (Docker passes none unless asked; we ask for none);
//   - an internal Docker network with no route to the host or the internet, so its only way out is
//     the egress proxy, which forwards to allowlisted public hosts only (see egress/proxy.mjs);
//   - --cap-drop ALL, --security-opt no-new-privileges, a read-only root fs, a non-root user,
//     a private tmpfs for /tmp and $HOME, and memory, CPU, PID and wall-time limits.
//
// Nothing here uses sudo or touches any container, image or network it did not create.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const execFileP = promisify(execFile);
const RUNNER_IMAGE = process.env.PM_RUNNER_IMAGE || 'proof-market-runner:1';
const EGRESS_IMAGE = process.env.PM_EGRESS_IMAGE || 'proof-market-runner:1';
const EGRESS_SRC = new URL('./egress/proxy.mjs', import.meta.url).pathname;

export const LIMITS = {
  memory: process.env.PM_MEM || '2g',
  cpus: process.env.PM_CPUS || '2',
  pids: Number(process.env.PM_PIDS || 512),
  stepWallMs: Number(process.env.PM_STEP_WALL_MS || 5 * 60 * 1000),
  jobWallMs: Number(process.env.PM_JOB_WALL_MS || 20 * 60 * 1000),
  logCap: Number(process.env.PM_LOG_CAP || 200 * 1024), // bytes of stdout+stderr kept per step
};

async function docker(args, opts = {}) {
  return execFileP('docker', args, { maxBuffer: 64 * 1024 * 1024, ...opts });
}

function clamp(s, cap) {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= cap) return s;
  return b.subarray(0, cap).toString('utf8') + `\n...[truncated, ${b.length - cap} more bytes]`;
}

// Run a command inside the container as the job user, with a wall-clock cap. Never a shell on the
// host: args are passed straight to docker exec.
function execInContainer(name, argv, { cwd = '/work/repo', timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn('docker', ['exec', '-w', cwd, name, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      // Kill the process tree inside the container, never on the host.
      docker(['exec', name, 'bash', '-lc', 'kill -9 -1 2>/dev/null || true']).catch(() => {});
      p.kill('SIGKILL');
    }, timeoutMs);
    p.stdout.on('data', (d) => { if (out.length < LIMITS.logCap * 2) out += d; });
    p.stderr.on('data', (d) => { if (err.length < LIMITS.logCap * 2) err += d; });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        argv, exit_code: killed ? null : code, timed_out: killed,
        duration_ms: Date.now() - started,
        stdout: clamp(out, LIMITS.logCap), stderr: clamp(err, LIMITS.logCap),
      });
    });
    p.on('error', (e) => { clearTimeout(timer); resolve({ argv, exit_code: null, error: e.message, duration_ms: Date.now() - started, stdout: '', stderr: '' }); });
  });
}

// The canonical projection of a transcript: the job identity and, per step, the commands with
// their exit code and output. It leaves out timestamps, durations and the clone source, so the
// hash names what was run and what it printed, not when or from where. Two runs of the same
// commands hash the same only when their output is identical; output that carries timings, such as
// a test runner's duration line, differs from run to run. This exact value is what a worker
// commits on chain.
export function canonicalTranscript(transcript) {
  return {
    v: 1,
    job: { repo: transcript.job.repo, commit: transcript.job.commit, path: transcript.job.path || '' },
    clone_ok: transcript.clone?.exit_code === 0,
    aborted: transcript.aborted || null,
    steps: (transcript.steps || []).map((s) => ({
      index: s.index,
      do: s.do,
      see: s.see,
      commands: (s.commands || []).map((c) => ({
        argv: c.argv,
        exit_code: c.exit_code ?? null,
        timed_out: !!c.timed_out,
        stdout: c.stdout || '',
        stderr: c.stderr || '',
      })),
    })),
  };
}

export function transcriptHash(transcript) {
  return createHash('sha256').update(JSON.stringify(canonicalTranscript(transcript))).digest('hex');
}

// Start the egress proxy container on a fresh internal network, returns { net, proxy, cleanup }.
async function startEgress(tag, hostIps) {
  const net = `pm-net-${tag}`;
  const proxy = `pm-egress-${tag}`;
  // Internal network: no gateway to the host, no route to the internet. Docker 28 "isolated" needs
  // --internal; --internal alone already removes the default route and external connectivity.
  await docker(['network', 'create', '--internal', '--label', 'proof-market=1', net]);
  // A second, egress-only network the proxy also attaches to, so the proxy (and only the proxy)
  // reaches the internet while the job network stays internal.
  const extNet = `pm-ext-${tag}`;
  await docker(['network', 'create', '--label', 'proof-market=1', extNet]);
  // Proxy runs the vendored proxy.mjs (mounted read-only). It is NOT the job: it holds no repo and
  // runs our own code only.
  await docker([
    'run', '-d', '--name', proxy, '--label', 'proof-market=1',
    '--network', extNet, '--read-only', '--tmpfs', '/tmp',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', `${EGRESS_SRC}:/opt/proxy.mjs:ro`,
    '-e', `HOST_IPS=${hostIps.join(',')}`, '-e', 'PORT=3128',
    '--entrypoint', 'node', RUNNER_IMAGE, '/opt/proxy.mjs',
  ]);
  await docker(['network', 'connect', net, proxy]);
  const removeNet = async (n) => {
    // Remove the network; if an endpoint still blocks it, disconnect every attached container (all
    // ours, labelled proof-market) and retry once.
    const r = await docker(['network', 'rm', n]).catch((e) => e);
    if (!(r instanceof Error)) return;
    const insp = await docker(['network', 'inspect', '-f', '{{range $k,$v := .Containers}}{{$k}} {{end}}', n]).catch(() => ({ stdout: '' }));
    for (const id of insp.stdout.trim().split(/\s+/).filter(Boolean)) {
      await docker(['network', 'disconnect', '-f', n, id]).catch(() => {});
    }
    await docker(['network', 'rm', n]).catch(() => {});
  };
  const cleanup = async () => {
    await docker(['rm', '-f', proxy]).catch(() => {});
    await removeNet(net);
    await removeNet(extNet);
  };
  return { net, proxy, cleanup };
}

// Host IPs the proxy must refuse (so a job cannot reach back to the host through the proxy).
async function hostIps() {
  try {
    const { stdout } = await execFileP('bash', ['-lc', "ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1"]);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return ['127.0.0.1'];
  }
}

/**
 * Run a job end to end.
 * job = { repo, commit, path, steps: [{do, see}] }
 * plan = { steps: [{ setup?: string[][], run: string[][], check: {...} }] }  // produced by the worker agent
 * The sandbox executes the plan's commands; deciding Pass/Fail from the output is the agent's job
 * (runJob returns the raw transcript; the caller's model reads it). This keeps the sandbox dumb and
 * auditable: it runs commands and records output, it does not judge.
 */
export async function runJob(job, plan, { tag = randomUUID().slice(0, 8), onEvent = () => {}, noProxyHosts = [], beforeRun = null, afterRun = null, cloneUrl = null } = {}) {
  const name = `pm-job-${tag}`;
  // The canonical repo (job.repo) is what the hash and chain record; cloneUrl is where this run
  // actually fetches from (the public repo, or the local origin for a pre-public demo). They point
  // at the same content at the same commit.
  const fetchUrl = cloneUrl || job.repo;
  const hips = await hostIps();
  const egress = await startEgress(tag, hips);
  // A caller may attach its own containers (for example a local git origin that serves fixture
  // repos) to the job's internal network before the job starts. Hosts in noProxyHosts are reached
  // directly over the internal network instead of through the egress proxy.
  if (beforeRun) await beforeRun(egress.net);
  const noProxy = ['localhost', '127.0.0.1', ...noProxyHosts].join(',');
  const t0 = Date.now();
  const transcript = { job: { repo: job.repo, commit: job.commit, path: job.path || '' }, cloned_from: fetchUrl, started_at: new Date().toISOString(), steps: [] };
  let started = false;
  try {
    onEvent({ kind: 'container_start', tag });
    // The job container: internal network only (its route out is the proxy), hardened, non-root.
    await docker([
      'run', '-d', '--name', name, '--label', 'proof-market=1',
      '--network', egress.net,
      // Writable scratch owned by the job user; the root filesystem stays read-only.
      '--read-only',
      '--tmpfs', '/tmp:size=512m,exec,uid=10001,gid=10001,mode=0700',
      '--tmpfs', '/home/runner:size=256m,exec,uid=10001,gid=10001,mode=0700',
      '--tmpfs', '/work:size=2g,exec,uid=10001,gid=10001,mode=0700',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', LIMITS.memory, '--memory-swap', LIMITS.memory, '--cpus', LIMITS.cpus, '--pids-limit', String(LIMITS.pids),
      '--user', '10001:10001',
      '-e', `HTTP_PROXY=http://${egress.proxy}:3128`, '-e', `HTTPS_PROXY=http://${egress.proxy}:3128`,
      '-e', `http_proxy=http://${egress.proxy}:3128`, '-e', `https_proxy=http://${egress.proxy}:3128`,
      '-e', `NO_PROXY=${noProxy}`, '-e', `no_proxy=${noProxy}`,
      '-e', 'CARGO_HTTP_CHECK_REVOKE=false', '-e', 'GIT_TERMINAL_PROMPT=0',
      RUNNER_IMAGE, 'sleep', String(Math.ceil(LIMITS.jobWallMs / 1000) + 60),
    ]);
    started = true;

    // Clone the repo at the pinned commit through the proxy, into /work/repo. Shallow, then checkout.
    const cloneCmd = [
      'bash', '-c',
      `set -e; git clone --filter=blob:none "${fetchUrl}" /work/repo && cd /work/repo && git checkout --detach "${job.commit}"`,
    ];
    const clone = await execInContainer(name, cloneCmd, { cwd: '/work', timeoutMs: LIMITS.stepWallMs });
    transcript.clone = clone;
    onEvent({ kind: 'cloned', ok: clone.exit_code === 0 });
    if (clone.exit_code !== 0) {
      transcript.aborted = 'clone failed';
      transcript.finished_at = new Date().toISOString();
      transcript.duration_ms = Date.now() - t0;
      transcript.hash = transcriptHash(transcript);
      return transcript;
    }
    const repoCwd = job.path ? `/work/repo/${job.path.replace(/^\/+/, '')}` : '/work/repo';

    for (let i = 0; i < plan.steps.length; i++) {
      const pstep = plan.steps[i];
      const rec = { index: i, do: job.steps[i]?.do, see: job.steps[i]?.see, commands: [] };
      const budgetUntil = t0 + LIMITS.jobWallMs;
      for (const argv of [...(pstep.setup || []), ...(pstep.run || [])]) {
        if (Date.now() > budgetUntil) { rec.commands.push({ argv, skipped: 'job wall-time exceeded' }); continue; }
        const r = await execInContainer(name, argv, { cwd: repoCwd, timeoutMs: LIMITS.stepWallMs });
        rec.commands.push(r);
        onEvent({ kind: 'command', step: i, exit: r.exit_code, timed_out: r.timed_out });
      }
      transcript.steps.push(rec);
    }
  } finally {
    if (started) await docker(['rm', '-f', name]).catch(() => {});
    // Tear down any caller-attached containers (for example the fixture origin) BEFORE removing the
    // network, otherwise the still-attached endpoint blocks network removal and leaks it.
    if (afterRun) await afterRun().catch(() => {});
    await egress.cleanup();
  }
  transcript.finished_at = new Date().toISOString();
  transcript.duration_ms = Date.now() - t0;
  transcript.hash = transcriptHash(transcript);
  return transcript;
}
