# Codex drives NeuroVue

[Codex](https://github.com/openai/codex) runs NeuroVue over its MCP server,
following a script ([prompt.md](prompt.md)). The person watches it happen:

1. **Window A**: opens a small BIDS dataset, filters its dataset pane to the
   T1-weighted volumes, zooms in on sub-02's thumbnail and shows that volume,
   which is registered to MNI152 space. It switches back to Express, so the
   viewer fills the window, overlays a motor-task statistical map in warm
   colours, and shows the multiplanar layout with a render tile.
2. **Window B**: opens a second window, titled "Codex demo: tracts", with the
   same MNI-registered T1w, a left-hemisphere surface and a tractogram, as a
   render alone, with the T1w hidden and the surface drawn as an outline so the
   tracts show through.
3. It goes back to A, moves the crosshair to the strongest activation, and
   takes a screenshot.
4. It goes to B, turns the render so the left hemisphere faces the viewer,
   and takes a screenshot.
5. It goes back to A, explodes the T1w into bricks in the render,
   labels the motor peak and dims the other bricks, takes a screenshot,
   closes them up again, and spins the render one full turn over ten seconds.
6. It saves A's scene as a NiiVue document in `~/Downloads`, empties the
   window, and opens the document again: the T1w and the overlay come
   back with the same colormap and threshold.
7. It makes A the tab later calls go to.

Each switch is a `focus_window` call, so the window comes to the front as
Codex starts working in it. Every call names its `tab`.

To run it live by voice in the Codex desktop app instead, read
[voice-script.md](voice-script.md) aloud.

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
- downloads three demo files from the NiiVue repo into `~/NeuroVue-demo`,
  once, and lays out eight more from NiiVue's demo images as a BIDS dataset
  in `~/NeuroVue-demo/bids`; its sub-02 T1w is the MNI152 template. Agents
  can only open files inside the allowed data roots, which is the home folder
  unless `roots` in NeuroVue's `mcp.json` lists others. If you set `roots`,
  put the demo folder inside one of them.
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
