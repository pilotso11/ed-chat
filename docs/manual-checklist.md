# Manual checklist

Run on a Windows PC with Elite Dangerous before each release. Write the result
next to each item.

## Phase 0, part B (first run only; copy results to the spec's "Phase 0 results")

1. Hotkeys: with the game in Borderless mode and in front, do Ctrl+Alt+Enter,
   Ctrl+Shift+1 and Ctrl+Alt+Left reach the overlay?
2. Focus: after Enter, does the game have focus again (ship controls respond at
   once)?
3. `DisplaySettings.xml`: the `FullScreen` value for Windowed, Fullscreen and
   Borderless.
4. Topmost: does the overlay stay on top after Alt+Tab back into the game?
5. Frame time: run PresentMon for 60 s with the overlay shown and 60 s with it
   minimized to the tray (tray menu). Write down the average and 99th percentile frame
   times.
6. Win32: the log shows no koffi errors, and the game is detected
   (`EliteDangerous64.exe`).

## Every release

- [ ] The overlay shows over the game in Borderless mode.
- [ ] The fullscreen warning shows in exclusive fullscreen.
- [ ] Hotkeys work while the game is in front, and not while another app is.
- [ ] Ctrl+Shift+Enter switches to the icon and back, and the game does not also act on it.
- [ ] Ctrl+` steps: the last reply, the whole reply, the chat, then back to rest with focus on the game. From minimized, the first press restores the overlay and the last press minimizes it again. With the history open (Ctrl+Shift+H), a press adds the input and the next closes both.
- [ ] Quit ED Chat after a reply and start it again: the status line shows `↺ resumed your last conversation`, Ctrl+Shift+H shows the earlier turns, and Claude remembers them.
- [ ] After `/new`, a restart does not resume. With `claude.resumeHours` at `0`, no restart resumes.
- [ ] In icon mode, a reply expands the overlay and it stays expanded.
- [ ] With the chat open, dragging the status line moves the overlay, and it snaps to the nearest edge or corner.
- [ ] `style.backgroundOpacity` changes apply live, and text stays readable over a bright star.
- [ ] Enter gives focus back to the game.
- [ ] A copied chip pastes into the galaxy map search with Ctrl+V.
- [ ] Clicking a chip in the card copies it, clicking the icon expands it, and neither takes focus from the game.
- [ ] In flight, firing with the mouse still works while the hidden cursor rests over a chip or the icon.
- [ ] A tool request shows the approval card; Ctrl+Alt+Y and N work.
- [ ] The chat does not open while in danger.
- [ ] Position hotkeys work, including Ctrl+Alt+M with two monitors.
- [ ] A position chosen by hotkey survives a restart.
- [ ] `settings.json` edits apply without a restart; a broken edit shows a warning.
- [ ] The ed-mcp warning shows when ed-mcp is not added for the user.
