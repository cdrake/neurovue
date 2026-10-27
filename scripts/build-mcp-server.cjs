// Compiles mcp-server/main.ts into the `neurovue-mcp` Tauri sidecar with
// `bun build --compile`, named for this platform's target triple like the
// niimath sidecar (see ensure-niimath.cjs). On macOS it builds both
// architectures and joins them for `tauri build --target universal-apple-darwin`.
// Skips the build while the staged binary is newer than the server's sources.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const binariesDir = path.join(root, 'src-tauri', 'binaries')
const entry = path.join(root, 'mcp-server', 'main.ts')
const force = process.argv.includes('--force')

// Bun's compile target for each Rust target triple.
const bunTargets = {
  'aarch64-apple-darwin': 'bun-darwin-arm64',
  'x86_64-apple-darwin': 'bun-darwin-x64',
  'x86_64-unknown-linux-gnu': 'bun-linux-x64',
  'aarch64-unknown-linux-gnu': 'bun-linux-arm64',
  'x86_64-pc-windows-msvc': 'bun-windows-x64',
}

const hostTriples = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
}

const hostTriple = hostTriples[`${process.platform}-${process.arch}`]
if (!hostTriple) {
  console.log(
    `No neurovue-mcp build for ${process.platform}-${process.arch}; skipping.`,
  )
  process.exit(0)
}

const triples =
  process.platform === 'darwin'
    ? ['aarch64-apple-darwin', 'x86_64-apple-darwin']
    : [hostTriple]
const outputPath = (triple) =>
  path.join(
    binariesDir,
    triple.includes('windows')
      ? `neurovue-mcp-${triple}.exe`
      : `neurovue-mcp-${triple}`,
  )
const universalPath = path.join(
  binariesDir,
  'neurovue-mcp-universal-apple-darwin',
)
const outputs = [
  ...triples.map(outputPath),
  ...(process.platform === 'darwin' ? [universalPath] : []),
]

// The server's own sources (with its tool documents in mcp-server/tools) plus
// the lockfile, which pins @niivue/nv-mcp.
function newestSource() {
  const files = [path.join(root, 'bun.lock'), path.join(root, 'package.json')]
  for (const name of fs.readdirSync(path.join(root, 'mcp-server'), {
    recursive: true,
  })) {
    files.push(path.join(root, 'mcp-server', name))
  }
  return Math.max(
    ...files.filter(fs.existsSync).map((f) => fs.statSync(f).mtimeMs),
  )
}

const upToDate =
  !force &&
  outputs.every(
    (output) =>
      fs.existsSync(output) && fs.statSync(output).mtimeMs >= newestSource(),
  )
if (upToDate) {
  console.log('neurovue-mcp is up to date.')
  process.exit(0)
}

fs.mkdirSync(binariesDir, { recursive: true })

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`${command} ${args.join(' ')} failed`)
    process.exit(result.status ?? 1)
  }
}

for (const triple of triples) {
  run('bun', [
    'build',
    '--compile',
    '--minify',
    `--target=${bunTargets[triple]}`,
    entry,
    '--outfile',
    outputPath(triple),
  ])
}

if (process.platform === 'darwin') {
  run('lipo', ['-create', ...triples.map(outputPath), '-output', universalPath])
}
