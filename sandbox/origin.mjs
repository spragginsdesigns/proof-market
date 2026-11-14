// A local git origin for the demo fixtures. It builds a bare repo from a working-tree directory and
// serves it over dumb HTTP from a container on the job's internal Docker network, so a job clones a
// real `http://host/name.git` URL with no host mount and no internet. Infrastructure, not the job:
// it holds our own fixtures only and runs our own code.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, cp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);
const RUNNER_IMAGE = process.env.PM_RUNNER_IMAGE || 'proof-market-runner:1';

async function git(cwd, args) { return execFileP('git', args, { cwd }); }

// Build bare repos from { name: worktreeDir } into a temp serving root. Each becomes <name>.git.
export async function buildBareRepos(fixtures) {
  const root = await mkdtemp(join(tmpdir(), 'pm-origin-'));
  for (const [name, src] of Object.entries(fixtures)) {
    const work = join(root, `${name}-work`);
    await cp(src, work, { recursive: true });
    await git(work, ['init', '-q', '-b', 'main']);
    await git(work, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'add', '-A']);
    await git(work, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-q', '-m', 'fixture']);
    const bare = join(root, `${name}.git`);
    await git(root, ['clone', '-q', '--bare', work, bare]);
    await git(bare, ['update-server-info']);
    await rm(work, { recursive: true, force: true });
  }
  // The origin container runs as a non-root user and reads /srv through a read-only mount, so the
  // whole served tree must be world-readable (mkdtemp makes the root mode 700).
  await execFileP('chmod', ['-R', 'a+rX', root]);
  return root;
}

// Return the commit hash HEAD of a served bare repo (so the job can pin it).
export async function headCommit(root, name) {
  const { stdout } = await git(join(root, `${name}.git`), ['rev-parse', 'HEAD']);
  return stdout.trim();
}

// A persistent fixture origin shared across many jobs. It builds the bare repos once and runs a
// single long-lived container on its own network; for each job it connects to that job's internal
// network and disconnects afterward. Clone URL for a fixture: `${base}/<name>.git`.
export async function makeFixtureOrigin(fixtures, tag = Math.random().toString(36).slice(2, 8)) {
  const root = await buildBareRepos(fixtures);
  const host = `pm-origin-shared-${tag}`;
  const net = `pm-originnet-${tag}`;
  const heads = {};
  for (const name of Object.keys(fixtures)) heads[name] = await headCommit(root, name);
  await execFileP('docker', ['network', 'create', '--label', 'proof-market=1', net]);
  await execFileP('docker', [
    'run', '-d', '--name', host, '--label', 'proof-market=1', '--network', net,
    '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', `${root}:/srv:ro`, '-w', '/srv',
    '--entrypoint', 'python3', 'proof-market-runner:1', '-m', 'http.server', '8080',
  ]);
  return {
    host,
    base: `http://${host}:8080`,
    headCommit: (name) => heads[name],
    // Connect this origin to a job network before the job starts.
    attach: async (jobNet) => { await execFileP('docker', ['network', 'connect', jobNet, host]).catch(() => {}); },
    detach: async (jobNet) => { await execFileP('docker', ['network', 'disconnect', '-f', jobNet, host]).catch(() => {}); },
    cleanup: async () => {
      await execFileP('docker', ['rm', '-f', host]).catch(() => {});
      await execFileP('docker', ['network', 'rm', net]).catch(() => {});
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// A persistent origin that serves a BARE MIRROR of a real local repo (the same commits as its
// remote), so a job can clone a repo that is not public yet. A clone from here and a clone of the
// remote are identical at the same commit. Clone URL: `${base}/repo.git`.
export async function makeRepoMirrorOrigin(repoDir, tag = Math.random().toString(36).slice(2, 8)) {
  const root = await mkdtemp(join(tmpdir(), 'pm-mirror-'));
  const bare = join(root, 'repo.git');
  await execFileP('git', ['clone', '-q', '--bare', repoDir, bare]);
  await execFileP('git', ['-C', bare, 'update-server-info']);
  await execFileP('chmod', ['-R', 'a+rX', root]);
  const head = (await execFileP('git', ['-C', repoDir, 'rev-parse', 'HEAD'])).stdout.trim();
  const host = `pm-origin-shared-${tag}`;
  const net = `pm-originnet-${tag}`;
  await execFileP('docker', ['network', 'create', '--label', 'proof-market=1', net]);
  await execFileP('docker', [
    'run', '-d', '--name', host, '--label', 'proof-market=1', '--network', net,
    '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', `${root}:/srv:ro`, '-w', '/srv',
    '--entrypoint', 'python3', 'proof-market-runner:1', '-m', 'http.server', '8080',
  ]);
  return {
    host,
    base: `http://${host}:8080`,
    headCommit: () => head,
    repoUrl: `${host}/repo.git`,
    attach: async (jobNet) => { await execFileP('docker', ['network', 'connect', jobNet, host]).catch(() => {}); },
    detach: async (jobNet) => { await execFileP('docker', ['network', 'disconnect', '-f', jobNet, host]).catch(() => {}); },
    cleanup: async () => {
      await execFileP('docker', ['rm', '-f', host]).catch(() => {});
      await execFileP('docker', ['network', 'rm', net]).catch(() => {});
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// Start the origin container on a network, serving `root` read-only over HTTP. Returns
// { host, base, cleanup }. base is the clone URL prefix, e.g. http://pm-origin-<tag>:8080
export async function startOrigin(net, tag, root) {
  const host = `pm-origin-${tag}`;
  await execFileP('docker', [
    'run', '-d', '--name', host, '--label', 'proof-market=1', '--network', net,
    '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', `${root}:/srv:ro`, '-w', '/srv',
    '--entrypoint', 'python3', RUNNER_IMAGE, '-m', 'http.server', '8080',
  ]);
  return {
    host,
    base: `http://${host}:8080`,
    cleanup: async () => {
      await execFileP('docker', ['rm', '-f', host]).catch(() => {});
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}
