#!/usr/bin/env bash
# Codex drives three NeuroVue windows over MCP: it loads data into each,
# switches between them, and takes a screenshot of each. See README.md.
#
#   demo/codex/run.sh                  # uses Codex's configured model
#   demo/codex/run.sh -m <model>       # anything after is passed to codex exec
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
url="http://127.0.0.1:${NEUROVUE_MCP_PORT:-4242}/mcp"
data="${NEUROVUE_DEMO_DIR:-$HOME/NeuroVue-demo}"
images=https://raw.githubusercontent.com/niivue/niivue/main/packages/niivue/demos/images
more=https://raw.githubusercontent.com/niivue/niivue-demo-images/main
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

# A small BIDS dataset to filter and browse, from NiiVue's demo images under
# BIDS names, so each volume gets an image type and a subject.
bids=(
  "sub-01/anat/sub-01_T1w.nii.gz $more/chris_t1.nii.gz"
  "sub-01/anat/sub-01_T2w.nii.gz $more/chris_t2.nii.gz"
  "sub-01/anat/sub-01_PDw.nii.gz $more/chris_PD.nii.gz"
  "sub-01/anat/sub-01_angio.nii.gz $more/chris_MRA.nii.gz"
  "sub-01/func/sub-01_task-pitch_bold.nii.gz $more/fmri_pitch.nii.gz"
  "sub-02/anat/sub-02_T1w.nii.gz $images/mni152.nii.gz"
  "sub-02/anat/sub-02_FLAIR.nii.gz $images/FLAIR.nii.gz"
  "sub-02/perf/sub-02_asl.nii.gz $images/pcasl.nii.gz"
)
for entry in "${bids[@]}"; do
  read -r file source <<<"$entry"
  if [ ! -s "$data/bids/$file" ]; then
    echo "Downloading bids/$file"
    mkdir -p "$(dirname "$data/bids/$file")"
    curl -fsSL -o "$data/bids/$file" "$source"
  fi
done
printf '{"Name": "NeuroVue demo", "BIDSVersion": "1.10.0"}\n' \
  >"$data/bids/dataset_description.json"

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

# save puts the document in Downloads, adding " (1)" to a name already there;
# a name of its own keeps the path the prompt gives right.
document="$HOME/Downloads/codex-demo-$(date +%Y%m%d-%H%M%S).nvd"
prompt=$(sed -e "s|{{SERVER}}|$server|g" -e "s|{{DATA}}|$data|g" \
  -e "s|{{DOCUMENT}}|$document|g" "$here/prompt.md")

# codex exec appends piped stdin to the prompt and waits for it to close, so
# give it none: run from a script or CI it would otherwise hang.
exec codex exec --skip-git-repo-check --sandbox read-only -C "$here" \
  "${config[@]}" "$@" "$prompt" </dev/null
