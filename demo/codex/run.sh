#!/usr/bin/env bash
# Codex drives two NeuroVue windows over MCP: it loads data into each,
# switches between them, and takes a screenshot of each. See README.md.
#
#   demo/codex/run.sh                  # uses Codex's configured model
#   demo/codex/run.sh -m <model>       # anything after is passed to codex exec
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
url="http://127.0.0.1:${NEUROVUE_MCP_PORT:-4242}/mcp"
data="${NEUROVUE_DEMO_DIR:-$HOME/NeuroVue-demo}"
images=https://raw.githubusercontent.com/niivue/niivue/main/packages/niivue/demos/images
files=(mni152.nii.gz spmMotor.nii.gz BrainMesh_ICBM152.lh.mz3 dpsv.trx)

if ! command -v codex >/dev/null; then
  echo "Install the Codex CLI first: https://github.com/openai/codex" >&2
  exit 1
fi

# Any HTTP answer will do; only a refused connection means it isn't running.
if ! curl -s -o /dev/null --max-time 3 "$url"; then
  echo "NeuroVue's agent server isn't answering at $url." >&2
  echo "Open NeuroVue and turn on View > Allow AI Agents." >&2
  exit 1
fi

# NeuroVue's own demo images. The folder must be inside the folders agents
# may open: the home folder unless "roots" in NeuroVue's mcp.json says else.
mkdir -p "$data"
for file in "${files[@]}"; do
  if [ ! -s "$data/$file" ]; then
    echo "Downloading $file"
    curl -fsSL -o "$data/$file" "$images/$file"
  fi
done

# Reuse the Codex MCP server already pointed at NeuroVue, if any, so its tools
# aren't listed twice; otherwise add one for this run only.
server=$(codex mcp list --json 2>/dev/null | URL="$url" python3 -c '
import json, os, sys
for entry in json.load(sys.stdin):
    if entry.get("enabled") and entry.get("transport", {}).get("url") == os.environ["URL"]:
        print(entry["name"])
        break
' || true)
config=()
if [ -z "$server" ]; then
  server=neurovue
  config+=(-c "mcp_servers.$server.url=\"$url\"")
fi
# Codex runs unattended, so it may call NeuroVue's tools without asking. The
# app still confines every file path to the allowed folders.
config+=(-c "mcp_servers.$server.default_tools_approval_mode=\"approve\"")

prompt=$(sed -e "s|{{SERVER}}|$server|g" -e "s|{{DATA}}|$data|g" "$here/prompt.md")

# codex exec appends piped stdin to the prompt and waits for it to close, so
# give it none: run from a script or CI it would otherwise hang.
exec codex exec --skip-git-repo-check --sandbox read-only -C "$here" \
  "${config[@]}" "$@" "$prompt" </dev/null
