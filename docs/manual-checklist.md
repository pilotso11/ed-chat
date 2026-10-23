# Manual checklist

Run on a Windows PC with Elite Dangerous before each release. Write the result
next to each item.

## Phase 0, part B (first run only; copy results to the spec's "Phase 0 results")

1. Hotkeys: with the game in Borderless mode and in front, do Ctrl+Shift+Space,
   Ctrl+Shift+1 and Ctrl+Alt+Left reach the overlay?
2. Focus: after Enter, does the game have focus again (ship controls respond at
   once)?
3. `DisplaySettings.xml`: the `FullScreen` value for Windowed, Fullscreen and
   Borderless.
4. Topmost: does the overlay stay on top after Alt+Tab back into the game?
5. Frame time: run PresentMon for 60 s with the overlay shown and 60 s with it
   hidden (Ctrl+Shift+O). Write down the average and 99th percentile frame
   times.
6. Win32: the log shows no koffi errors, and the game is detected
   (`EliteDangerous64.exe`).

## Every release

- [ ] The overlay shows over the game in Borderless mode.
- [ ] The fullscreen warning shows in exclusive fullscreen.
- [ ] Hotkeys work while the game is in front, and not while another app is.
- [ ] Enter gives focus back to the game.
- [ ] A copied chip pastes into the galaxy map search with Ctrl+V.
- [ ] A tool request shows the approval card; Ctrl+Shift+Y and N work.
- [ ] The chat does not open while in danger.
- [ ] Position hotkeys work, including Ctrl+Alt+M with two monitors.
- [ ] A position chosen by hotkey survives a restart.
- [ ] `settings.json` edits apply without a restart; a broken edit shows a warning.
- [ ] The ed-mcp warning shows when ed-mcp is not added for the user.
