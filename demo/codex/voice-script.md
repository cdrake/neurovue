# Voice script for the Codex desktop app

Read these lines aloud to the Codex desktop app, one turn at a time, so the
audience sees each step happen. [run.sh](run.sh) runs the same demo
unattended.

## Before you start

- Open NeuroVue and turn on **View > Allow AI Agents**.
- Start a **new chat** in Codex so it loads the NeuroVue tools.
- The demo files are in `~/NeuroVue-demo`. If that folder is gone, run
  `demo/codex/run.sh` once to download them.

## Script

**1. Get started**
> "Use the niivue tools to control NeuroVue. List the open NeuroVue windows and call the first one window A."

**2. Load the anatomy**
> "In window A, bring the window to the front and open the MNI152 template from the NeuroVue demo folder in my home folder."

**3. Add the activation map**
> "Now overlay the spm motor file from the same folder. Use a warm colour map and hide anything below three."

**4. Change the layout**
> "Show all three slice views plus the 3D render."

**5. Open a second window**
> "Open a new NeuroVue window called tracts. Call it window B and bring it to the front."

**6. Load surfaces and tracts**
> "In window B, open the same MNI152 template, then load the left hemisphere brain mesh and the dpsv tract file from the demo folder. Show only the 3D render."

**7. Switch back and explore**
> "Go back to window A and bring it to the front. Move the crosshair to the strongest motor activation and tell me where it is in MNI coordinates."

**8. Take a look**
> "Take a screenshot of window A and describe what you see."

**9. Switch again**
> "Switch to window B, bring it to the front, and rotate the brain so the left hemisphere faces me."

**10. Save the results**
> "Save a picture of window B called tracts view, then switch to window A and save the whole scene as a document called motor demo."

**11. Wrap up**
> "Bring window A to the front and give me a one paragraph summary of what each window shows."

## Tips

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
  Steps 8 and 9 are the slowest, so that's a good moment to talk the audience
  through what's on screen.
