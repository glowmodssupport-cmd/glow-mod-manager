# Glow Mod Manager

## Contributors

- **Glow Mods** maintains the project.
- **Claude (Anthropic)** contributed to planning, implementation, and review.
- **Codex (OpenAI)** contributed to planning, implementation, and testing.

Glow Mod Manager is a desktop app for compatible data-only mod packages. On Windows, run the single setup executable and open Glow Mod Manager from Start or the desktop.

## Use the manager

1. Choose **Find games** to look in common Rockstar folders, Steam libraries and Epic install records. **Browse** accepts a native game executable or a macOS app bundle.
2. Drag Glow Mods ZIPs into the library and select the mods you want for this game. Selections are remembered per game. Review individual file lists and use search, filters, and sort to find a package. **Find more mods** opens the Glow Mods catalogue when a catalogue URL is configured.
3. Choose **Launch modded**. Glow normally creates the `mods` folder in an independent copy of the game, or uses the folder copied from the original. You can change the relative folder under **Game setup** if your game’s loader documents a different location.
4. Choose **Launch original** to start the original executable with the original game files. Opening that executable outside Glow uses those same files.
5. If you used a version that copied files into the original game, **Restore original** will verify the old copies against the library before withdrawing them. Save edited legacy files separately before restoring. Other folders stay in place.

Preparing the first copy needs time and disk space. You can cancel preparation. Glow reuses a copy after it verifies the original installation fingerprint, the executable, the selected packages, and the deployed mod files. Changed game files or selections can require a new copy. The app retains at most two copies and provides **Clear saved copies** under **Safety & settings**. Copy out any saves stored inside them before clearing. The original game directory and mod library are separate.

## Package format

A `.zip` contains a root `glow-mod.json` and a `files/` folder. For example:

```json
{"format":"glow-mod-v1","name":"Coast lighting","category":"Visuals"}
```

A file such as `files/looks/coast.ini` is copied inside the mod's managed subfolder. Categories are Gameplay, Visuals, Vehicles, Audio, Tools and Other. Accepted files are CFG, CSV, DDS, INI, JPEG, JPG, JSON, OGG, PNG, TXT, WAV, WEBP and XML. The import caps the ZIP and its expanded contents at 256 MB each. Only import packages you trust.

## Game and mod requirements

Glow Mod Manager runs compatible data packages in a separate copy of your game. Choose a native executable that can run from a copy and a game or mod loader that reads the selected mod folder. Use **Launch original** when you want the original installation. Some games use shared save locations outside their installation folder.

## Build and release

Use Node.js 24. Run `npm ci` and `npm test`, then build on the target operating system.

| Platform | Build command | Output in `dist/` |
| --- | --- | --- |
| Windows | `npm run package -- x64` | Per-user NSIS installer |
| macOS | `npm run package:mac -- arm64` | DMG installer and update ZIP |
| Linux | `npm run package:linux -- x64` | AppImage |

Each command accepts `x64` or `arm64`. Set `GLOW_BUILD_DIR` to write the artifacts to a separate folder and `GLOW_RELEASE_VERSION` to set the release version without editing the source. Run the Windows integration check with `node test/desktop-smoke.cjs "dist/win-unpacked/Glow Mod Manager.exe"`. Test installation, discovery and launching on each platform you distribute.

### Windows releases with SignPath

The **Windows release** GitHub Actions workflow builds a release from the standalone desktop repository. Run it with signing off to build the first downloadable release for the SignPath application. The source is available under the MIT licence.

After SignPath approval, link the public repository as a trusted build source. Copy `signpath-artifact.xml` into the project’s default artifact configuration. It checks the installer name, product and version. Scope the signing policy to the release workflow and approved release refs. Set these values on GitHub.

| Type | Name | Value |
| --- | --- | --- |
| Secret | `SIGNPATH_API_TOKEN` | SignPath submitter token |
| Variable | `SIGNPATH_ORGANIZATION_ID` | SignPath organisation ID |
| Variable | `SIGNPATH_PROJECT_SLUG` | SignPath project slug |
| Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | SignPath policy slug |
| Variable | `GLOW_WINDOWS_PUBLISHER` | Exact Authenticode certificate subject confirmed by SignPath |
| Variable | `GLOW_UPDATE_URL` | Final HTTPS address of the Windows x64 update folder |
| Variable | `GLOW_MODS_URL` | Final HTTPS address of the Glow Mods catalog |

Run **Windows release** with signing on and a new version, then approve the signing request in SignPath. The workflow verifies the signed installer and outputs `windows-update-feed`. Upload the installer to the configured update folder, then upload `latest.yml` last. Windows downloads the full installer and verifies its hash and publisher. Keep the same publisher identity and feed address between releases. Use a separate feed if you later release another architecture.

Install the first signed build manually. On a test PC with that build, verify **Check for updates → Update now → Restart to update** against a newer signed release before distributing the signed updater. A build exposes **Check for updates** when it contains a release feed. Builds with a catalog URL also expose **Find more mods**.

For direct Windows signing, set the update URL and publisher plus `WIN_CSC_LINK` or `CSC_LINK` instead. Set an HTTPS feed on signed macOS builds and AppImage Linux builds if you plan to distribute updates for those platforms.
