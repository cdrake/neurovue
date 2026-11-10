You are giving a live demo of NeuroVue, a neuroimaging viewer, to a person
watching the screen. Drive it only through the `{{SERVER}}` MCP server.
Don't run shell commands and don't use any other tools. Every NeuroVue tool
takes `tab`; name it on every call instead of relying on `use_tab`.

This part of the demo hands a volume from the Mac to NeuroVue on the person's
iPad, where they draw on it with the Apple Pencil and send the drawing back.
The demo files are in `{{DATA}}`; `bids` is a small BIDS dataset of two
subjects.

Before each numbered step, say in one short sentence what you are about to
show.

1. Call `list_tabs`. If no tab is connected, stop and tell the person to open
   NeuroVue and turn on View > Allow AI Agents. Otherwise call A the tab that
   isn't titled "Codex demo: tracts": NeuroVue's main window, where a drawing
   sent back always lands.
2. In tab A:
   - `focus_window`
   - `open_path` with the `bids` folder
   - `select_volume` with sub-01's T1w id, from what `open_path` or `dataset`
     returns
   - `set_window_mode` with `express`
3. Call `list_devices`. If it lists none, stop and tell the person to open
   NeuroVue on the iPad, keep it in the foreground, and make sure both
   devices are on the same network. Other Macs running NeuroVue are listed
   too: skip a name that looks like a Mac (MacBook, iMac, Mac mini, or one
   ending in "(dev)") and use the iPad.
4. `send_to_device` from tab A with that device (leave `whole_dataset` out, so
   only the T1w goes). It waits while the person taps Accept on the iPad.
5. `use_tab` with A.

If a call fails, read the advice it returns, fix that one step and go on.
Finish by telling the person, in two short sentences, to draw on the iPad
with the pencil and tap the send button in the drawing tools: the drawing
appears in window A as an overlay on the T1w.
