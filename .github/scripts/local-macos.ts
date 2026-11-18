// Runs CI's Build (macOS) job on this Mac for a PR, then reports it.
//
// Hosted macOS arm64 runners are often out of capacity, so the CI job can sit
// queued and get cancelled. This runs the same steps (install, universal tauri
// build, cargo test, the .dmg exists) in a throwaway worktree at the PR head,
// posts a `local-macos` commit status on that head, and on success adds the
// skip-macos label, removing it first if it is already there so the `labeled`
// event re-runs CI's gate against the new status. CI skips its macOS build only
// when the label and a successful status on the head are both present, so a
// later push (a new head without the status) builds on macOS again.
//
// Needs write access to cdrake/neurovue (statuses and labels). It runs the PR's
// code (install scripts, build scripts, tests) as you; a fork PR is refused
// unless --reviewed=<sha> names the head commit you read. Signing variables are
// dropped so the build is unsigned, like CI's.
//
// Usage: bun .github/scripts/local-macos.ts <pr-number> [--no-label] [--reviewed=<sha>]

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// Pinned, so a fork clone's origin or gh default repo cannot misdirect the
// fetch, the status or the label.
const REPO = 'cdrake/neurovue'
const LABEL = 'skip-macos'
const TARGET = 'universal-apple-darwin'

const pr = process.argv[2]
const addLabel = !process.argv.includes('--no-label')
const reviewed =
  process.argv.find((a) => a.startsWith('--reviewed='))?.slice(11) ?? ''
if (!pr || !/^\d+$/.test(pr)) {
  console.error(
    'usage: bun .github/scripts/local-macos.ts <pr-number> [--no-label] [--reviewed=<sha>]',
  )
  process.exit(2)
}
if (process.platform !== 'darwin') {
  console.error('local-macos: run this on a Mac')
  process.exit(2)
}

function run(
  cmd: string[],
  cwd?: string,
  env?: Record<string, string | undefined>,
): boolean {
  console.log(`$ ${cmd.join(' ')}`)
  return (
    Bun.spawnSync(cmd, { cwd, env, stdout: 'inherit', stderr: 'inherit' })
      .exitCode === 0
  )
}

function out(cmd: string[]): string {
  const r = Bun.spawnSync(cmd)
  if (r.exitCode !== 0)
    throw new Error(`${cmd.join(' ')} failed: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

const pull = ['gh', 'pr', 'view', pr, '-R', REPO, '--json']
const view = JSON.parse(out([...pull, 'headRefOid,isCrossRepository']))
const sha: string = view.headRefOid
// Tied to a commit, so a push after your review is not run unread.
if (
  view.isCrossRepository &&
  !(reviewed.length >= 7 && sha.startsWith(reviewed))
) {
  console.error(
    `local-macos: #${pr} is from a fork and its code runs on this machine; read the diff at ${sha.slice(0, 8)}, then pass --reviewed=${sha.slice(0, 8)}`,
  )
  process.exit(2)
}

function status(
  state: 'pending' | 'success' | 'failure' | 'error',
  description: string,
) {
  out([
    'gh',
    'api',
    `repos/${REPO}/statuses/${sha}`,
    '-f',
    `state=${state}`,
    '-f',
    'context=local-macos',
    '-f',
    `description=${description}`,
  ])
}

const dir = mkdtempSync(join(tmpdir(), `neurovue-macos-${pr}-`))
// Kept between runs (a cold universal build takes far longer than a warm one),
// apart from the dev app's target dir.
const targetDir = join(homedir(), 'Library/Caches/neurovue-local-macos/target')
const dmgDir = join(targetDir, TARGET, 'release/bundle/dmg')
const env: Record<string, string | undefined> = {
  ...process.env,
  CI: 'true', // tauri's --ci parses true|false, as GitHub sets it
  CARGO_TARGET_DIR: targetDir,
}
// Keeps tokens out of the PR's environment, and signing off like CI.
for (const k of Object.keys(env)) {
  if (
    /^(APPLE_|TAURI_SIGNING_)/.test(k) ||
    ['GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN'].includes(k)
  )
    delete env[k]
}

// CI's pinned niimath release, read from the PR's own workflow.
function niimathTag(): string | undefined {
  const workflow = readFileSync(
    join(dir, '.github/workflows/build.yml'),
    'utf8',
  )
  return /NIIMATH_RELEASE_TAG:\s*(\S+)/.exec(workflow)?.[1]
}

type Final = 'success' | 'failure' | 'error'
let final: Final | undefined // unset: no public status yet
const started = Date.now()
const ref = `refs/remotes/local-macos/${pr}`
try {
  if (
    !run([
      'git',
      'fetch',
      `https://github.com/${REPO}.git`,
      `+pull/${pr}/head:${ref}`,
    ])
  )
    throw new Error('fetch failed')
  if (!run(['git', 'worktree', 'add', '--detach', dir, sha]))
    throw new Error('worktree failed')
  env.NIIMATH_RELEASE_TAG = niimathTag()
  status('pending', `running at ${sha.slice(0, 8)}`)
  final = 'error' // a setup step or a crash: the job did not run to the end
  rmSync(dmgDir, { recursive: true, force: true }) // so only this build's .dmg counts
  if (
    run(
      [
        'rustup',
        'target',
        'add',
        'aarch64-apple-darwin',
        'x86_64-apple-darwin',
      ],
      dir,
      env,
    ) &&
    run(['bun', 'install', '--frozen-lockfile'], dir, env)
  )
    final =
      run(['bunx', 'tauri', 'build', '--target', TARGET], dir, env) &&
      run(['cargo', 'test'], join(dir, 'src-tauri'), env) &&
      existsSync(dmgDir) &&
      readdirSync(dmgDir).some((f) => f.endsWith('.dmg'))
        ? 'success'
        : 'failure'
} catch (e) {
  console.error(`local-macos: ${(e as Error).message}`)
}
// Only the fetch needs it; a kept worktree's HEAD keeps the commit.
run(['git', 'update-ref', '-d', ref])
let ok = final === 'success'
if (ok) run(['git', 'worktree', 'remove', '--force', dir])
else console.error(`local-macos: worktree kept for the logs at ${dir}`)

const minutes = ((Date.now() - started) / 60_000).toFixed(1)
const said: Record<Final, string> = {
  success: 'passed',
  failure: 'failed',
  error: 'did not finish',
}
if (final) {
  try {
    status(final, `build and tests ${said[final]} in ${minutes} min`)
  } catch (e) {
    ok = false
    console.error(
      `local-macos: could not post the status: ${(e as Error).message}`,
    )
  }
}
if (ok && addLabel) {
  // Re-adding a label that is already there fires no event, so take it off
  // first: the labeled event then re-runs the gate against this status.
  const labels = out([...pull, 'labels', '-q', '.labels[].name']).split('\n')
  const edit = (flag: string) =>
    run(['gh', 'pr', 'edit', pr, '-R', REPO, flag, LABEL])
  if (
    (labels.includes(LABEL) && !edit('--remove-label')) ||
    !edit('--add-label')
  ) {
    console.error(
      `local-macos: passed, but re-adding ${LABEL} failed, so CI will still build on macOS; remove and add it by hand`,
    )
    ok = false
  }
}
console.log(
  `local-macos: PR #${pr} at ${sha.slice(0, 8)} ${ok ? 'PASSED' : 'FAILED'}`,
)
process.exit(ok ? 0 : 1)
