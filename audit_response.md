# Audit response

Response to the external Apple-readiness review of b66a99a (`audit_temp.md`,
deleted). Work is on branch `fix/ios-submission-blockers` (issues #78–#93).
Scope decision (owner): ship iOS (iPhone + iPad) to the App Store now; macOS
stays Developer ID DMG. The Mac App Store is deferred to #93.

## Findings

| # | Point | Decision | Status |
|---|-------|----------|--------|
| 1 | No App Sandbox on the macOS host | Defer | #93. Needed only for the Mac App Store; the DMG is notarized Developer ID. |
| 2 | Recents need security-scoped bookmarks | Defer | #93, with the sandbox. |
| 3 | niimath and MCP sidecars under the sandbox | Defer | #93. They need `com.apple.security.inherit` helper entitlements and their own signing. |
| 4 | Desktop feature set vs. 2.4.5/2.5.2 (NeuroFlow dev paths, terminal login shell) | Defer | #93. A Mac App Store build likely drops the terminal and NeuroFlow, or gates them behind a build flag. |
| 5 | iOS `PrivacyInfo.xcprivacy` | Fixed | 122784f. FileTimestamp C617.1 and 3B52.1; no tracking, no collected data. |
| 6 | Privacy policy and support URLs | In progress | #80. `docs/privacy.md` and `docs/support.md`; GitHub Pages serves main `/docs`, so they go live when this branch merges: cdrake.github.io/neurovue/privacy and /support. Linked from Welcome and the desktop Help menu. Still to do: enter both URLs in App Store Connect. |
| 7 | iOS 4D allocation bound; mobile cache budgets | Fixed | This audit. iOS counts 4D frames toward the voxel ceiling. iOS ceiling: 128M voxels. Preview cache: 64 MB. Decoded-level cache: 128 MB. Desktop is unchanged. |
| 8 | iOS doesn't register `.nvbundle` | Fixed | #84, via `Info.ios.plist` CFBundleDocumentTypes and UTExportedTypeDeclarations. |
| 9 | Quick Look logs filenames and errors `.public` | Fixed | This audit. Now `.private` in PreviewProvider and ThumbnailProvider. |
| 10 | "Allow AI Agents" has no disclosure (5.1.2(i)) | Fixed | This audit. Enabling it shows a confirm dialog that says what agents can reach and that an agent may forward data to its provider; Cancel unchecks the item. Desktop only; there is no MCP on iOS. |
| G1 | macOS package (pkg, App Store signing) | Defer | #93. |
| G2 | iOS package: fresh archive, build number | Release check | Raise `CFBundleVersion` for every upload (README). Export with `--export-method app-store-connect`. |
| G3 | `project.yml` version 0.1.0 | Already resolved | `project.yml:54-55` is 0.2.12. |
| G4 | macOS floor 10.13 vs. Quick Look 12.0 | Already resolved | `tauri.conf.json` minimumSystemVersion is 15.0 and Quick Look's minimum is 13.0 (132be6d). |
| G5 | Physical iPhone/iPad checks | Open | Device test pass needed. See "Next steps". |
| G6 | Signed sandboxed Mac checks | Defer | #93. |
| G7 | Privacy labels | Open | App Store Connect: "Data Not Collected" is accurate. Nothing leaves the device except a user-initiated LAN send. |
| G8 | Store records (support URL, screenshots, review notes) | Open | Owner's action. The review notes should include sample data (MNI152) and say receiving is opt-in. |
| G9 | Claims and rights | Note | Research-use positioning; no atlases are bundled (AAL licence). Check notices for the MNI template, niimath and the bun runtime. |
| G10 | Export compliance | Note | The LAN transfer is unencrypted HTTP and uses no proprietary crypto, so the exempt declaration holds. |

## Internal audit (this pass)

Security and bugs (agent run; nothing lets a LAN peer skip Accept or write
outside the inbox):
- P1 Fixed: the Linux and Windows builds were broken by the misplaced `#[cfg]` on `mod background` (see below).
- P1 Fixed: `share_file` (iOS save via the share sheet) was missing from the mobile invoke_handler, so mask save and SVG export on iPad failed.
- P2 Fixed: the gzip-bomb cap counted one frame on desktop, which truncated 4D `.nii.gz` files. The cap now uses every frame.
- P2 Fixed: an offer without a code now warns "accept only if you just sent this from your own Mac" instead of hiding the check.
- P2 Open (PLAUSIBLE): NSFileProtectionComplete may fail background transfers about 10 s after the device locks. The fix is `CompleteUnlessOpen`, which needs the App ID's Data Protection changed in the developer portal and a new profile. Verify on a device.
- P3 Fixed: the mirror's duplicate "Undo" labels are now "Undo shape", "Redo shape" and "Undo ink".
- P3 Open:
  - `MainThreadMarker::new_unchecked` is called off the main thread in background.rs. It breaks the Rust safety contract; dispatch to main instead.
  - A race between task expiry and `begin` storing its id.
  - Opening Send to iPad on a Mac turns on listening for good, with no off switch.
  - Offer spam can hold the single offer slot, and unused upload tokens are never cleared (both pre-existing).

Refactor findings applied:
- `lib.rs`: `#[cfg(macos|ios)]` had moved from `bonjour` onto `background`, which would break the Linux and Windows builds. Restored.
- `lib.rs`: `share_file` was registered twice in invoke_handler; removed the duplicate.
- `lib.rs`: restored an orphaned `list_send_targets` doc comment.
- `COARSE_POINTER` is now defined once, in `stageControls.ts`, and ControlsHelp imports it. ControlsHelp's copy called `matchMedia` without a guard.

Refactor findings skipped (low value): unifying `PRESS` with the `setStageControl`
tables, folding the tool-row `gapBefore`, and merging the receive-marker helpers.
`confirmationCode` stays on crypto RNG.

## Next steps

1. #80: after merge, check that the Pages URLs load, then enter them in App Store Connect.
2. Device pass on iPhone and iPad (iOS 27):
   - cold-launch "Open in";
   - AirDrop an `.nvbundle`;
   - a Mac→iPad send with the code, with Local Network granted and denied;
   - background during a send;
   - a lock during a transfer (NSFileProtectionComplete can fail it);
   - VoiceOver on StageControlsMirror;
   - a large 4D file on iPhone, checking it hits the new ceiling, not jetsam.
3. Raise CFBundleVersion, archive, and upload to TestFlight, then fill in the store records (G7, G8).
4. Known UI residuals:
   - At accessibility text sizes the status bar clips and the viewer header crowds.
   - The canvas controls don't follow Dynamic Type.
5. Security P2/P3 opens above, especially CompleteUnlessOpen and the main-thread dispatch in background.rs.
6. #88 follow-up: transfers have no TLS or pairing; the 4-digit code only tells look-alike devices apart.
7. #93 (Mac App Store): sandbox, bookmarks, helper entitlements, feature gating, then a pkg. A separate project.
