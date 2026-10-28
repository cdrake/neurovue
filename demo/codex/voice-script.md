# Voice script for the Codex desktop app

Read these lines aloud to the Codex desktop app, one turn at a time, so the
audience sees each step happen. [run.sh](run.sh) runs the same demo
unattended.

## Before you start

- Open NeuroVue and turn on **View > Allow AI Agents**.
- Start a **new chat** in Codex so it loads the NeuroVue tools.
- The demo files are in `~/NeuroVue-demo`, with a small BIDS dataset in its
  `bids` folder. If either is missing, run `demo/codex/run.sh` once to
  download them.

## Script

**1. Get started**
> "Use the niivue tools to control NeuroVue. List the open NeuroVue windows and call the first one window A."

**2. Open the dataset**
> "In window A, bring the window to the front and open the bids folder in the NeuroVue demo folder in my home folder."

**3. Filter it**
> "Filter the dataset to just the T1 weighted volumes."

**4. Zoom in and pick one**
> "Zoom in on subject 2's T1 thumbnail and show it in the viewer. It's registered to MNI space. Then switch back to the express view."

**5. Add the activation map**
> "Now overlay the spm motor file from the NeuroVue demo folder. Use a warm colour map and hide anything below three."

**6. Change the layout**
> "Show all three slice views plus the 3D render."

**7. Open a second window**
> "Open a new NeuroVue window called tracts. Call it window B and bring it to the front."

**8. Load surfaces and tracts**
> "In window B, open subject 2's T1 from the dataset, then load the left hemisphere brain mesh and the dpsv tract file from the demo folder. Show only the 3D render, hide the T1 there, and draw the brain mesh as an outline so the tracts show through."

**9. Switch back and explore**
> "Go back to window A and bring it to the front. Move the crosshair to the strongest motor activation and tell me where it is in MNI coordinates."

**10. Take a look**
> "Take a screenshot of window A and describe what you see."

**11. Switch again**
> "Switch to window B, bring it to the front, and rotate the brain so the left hemisphere faces me. The orientation cube should show L."

**12. Explode the brain**
> "Switch to window A, bring it to the front, show only the 3D render, and explode the brain into bricks."

**13. Label it**
> "Turn window A so the right hemisphere faces me, label the strongest motor activation as motor peak, and dim all the other bricks."

**14. Put it back together**
> "Take the labels down, close the bricks back up, and go back to the three slice views plus the 3D render."

**15. Spin it**
> "Animate one full 360 degree turn of the 3D render over 10 seconds."

**16. Save the results**
> "Save a picture of window B called tracts view, then save window A's whole scene as a document called motor demo."

**17. Open it again**
> "In window A, remove all the volumes, then open the motor demo document from my Downloads folder."

**18. Wrap up**
> "Bring window A to the front and give me a one paragraph summary of what each window shows."

## Act 2: draw on the iPad

Before the meeting, open NeuroVue on the iPad and keep it in the foreground,
on the same Wi-Fi as the Mac. A drawing sent back lands in window A, the
main window, so do this act there.

**19. Find the iPad**
> "Bring window A to the front, open the bids folder again, and show subject 1's T1. Then list the devices I can send to."

**20. Send it**
> "Send that T1 to my iPad."

Tap **Accept** on the iPad. Draw on the T1 with the Pencil, then tap the send
button in the drawing tools. The drawing appears in window A as an overlay.

**21. Look at it**
> "Take a screenshot of window A and describe the drawing."

## Tips

- Wait for Codex to say a step is finished before reading the next line. A
  line read while it is still reporting the last step may only get "next,
  I'll…" with nothing happening; if so, say "go ahead" or repeat the line.
- Say "window A" and "window B" every time. Codex keeps track of which window
  ID is which, and naming them keeps it from drifting.
- Dictation may write file names oddly, such as "spm motor" or "d p s v". If
  Codex can't open a file, spell out the name: "spmMotor dot nii dot gz",
  "BrainMesh underscore ICBM152 dot lh dot mz3", "dpsv dot trx".
- If a step fails, say "follow the advice in that error and try again". Every
  NeuroVue error comes back with a suggested fix.
- Saved files go to `~/Downloads`, so have a Finder window on that folder
  ready to show the audience.
- Codex can take 10 to 30 seconds per step, longer when it takes screenshots.
  Steps 10 and 11 are the slowest, so that's a good moment to talk the audience
  through what's on screen.
- Dimming works through labels: the bricks holding a label stay solid and
  the rest fade. To dim a whole side, ask for a label on just the bricks you
  want to keep, such as "label the motor peak and dim everything else".
- Filtering and zooming happen in the dataset pane, which Express view hides,
  so step 3 switches window A to the dataset view by itself; step 4 switches
  it back to Express.
- Step 17 opens the newest save. If "motor demo" was saved before, the new
  one is "motor demo (1).nvd"; say that name, or clear old copies out of
  Downloads before the demo.
- The 3D render draws the T1 as a solid brain, which hides any surface
  or tracts inside it. That is why step 8 hides the T1 in window B.
- If the iPad isn't listed, bring NeuroVue on the iPad to the front and ask
  again: iOS stops it listening while it's in the background. On a network
  that keeps devices apart (many office and hotel Wi-Fi networks do), put the
  Mac and the iPad on a phone's hotspot instead.
- Quit any dev build of NeuroVue first. It runs its own agent server on 4243
  and shows up on the iPad as "(dev)", so it won't take the release app's
  calls, but two Macs in the iPad's list invite the wrong tap.
