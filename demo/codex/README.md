# Codex drives NeuroVue

[Codex](https://github.com/openai/codex) runs NeuroVue over its MCP server,
following a script ([prompt.md](prompt.md)). The person watches it happen:

1. **Window A**: opens the MNI152 template, overlays a motor-task statistical
   map in warm colours, and shows the multiplanar layout with a render tile.
2. **Window B**: opens a second window, titled "Codex demo: tracts", with the
   same template, a left-hemisphere surface and a tractogram, as a render
   alone.
3. It goes back to A, moves the crosshair to the strongest activation, and
   takes a screenshot.
4. It goes to B, turns the render so the left hemisphere faces the viewer,
   and takes a screenshot.
5. It brings A to the front again and makes it the tab later calls go to.

Each switch is a `focus_window` call, so the window comes to the front as
Codex starts working in it. Every call names its `tab`.

## Run it

You need NeuroVue, with View > Allow AI Agents turned on, and the Codex CLI,
signed in.

```sh
demo/codex/run.sh                 # Codex's configured model
demo/codex/run.sh -m gpt-6-sol    # anything after run.sh goes to codex exec
demo/codex/run.sh --json          # one JSON event per line, tool calls included
```

The script:

- stops early if NeuroVue's agent server isn't answering at
  `http://127.0.0.1:4242/mcp`.
- downloads the four demo files from the NiiVue repo into `~/NeuroVue-demo`,
  once. Agents can only open files inside the allowed data roots, which is the
  home folder unless `roots` in NeuroVue's `mcp.json` lists others. If you set
  `roots`, put the demo folder inside one of them.
- reuses the Codex MCP server already pointed at NeuroVue, such as
  `[mcp_servers.niivue]` in `~/.codex/config.toml`, or adds one named
  `neurovue` for this run only. It changes nothing in your Codex config.
- runs `codex exec` in a read-only sandbox and approves that one server's
  tools for the run, since there is nobody to answer prompts. NeuroVue still
  checks every path against the allowed roots.

| Variable | Default |
| --- | --- |
| `NEUROVUE_MCP_PORT` | `4242` |
| `NEUROVUE_DEMO_DIR` | `~/NeuroVue-demo` |

A run takes about three minutes and uses your OpenAI quota. Each screenshot
returns an image the model reads, so the input adds up to over a million tokens
per run, most of them cached.

If a model isn't available to your Codex account, `codex exec` says so; pass
another with `-m`.
