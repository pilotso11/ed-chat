# Manual checklist

Run on a Windows PC with Elite Dangerous before each release. Write the result
next to each item.

## Phase 0, part B (first run only; copy results to the spec's "Phase 0 results")

1. Hotkeys: with the game in Borderless mode and in front, do Ctrl+Alt+Enter,
   Ctrl+Alt+1 and Ctrl+Alt+Left reach the overlay?
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
- [ ] Ctrl+Alt+Shift+Enter switches to the icon and back, and the game does not also act on it.
- [ ] Ctrl+` steps: the last reply, the whole reply, the chat, then back to rest with focus on the game. From minimized, the first press restores the overlay and the last press minimizes it again. With the history open (Ctrl+Alt+H), a press adds the input and the next closes both.
- [ ] Quit ED Chat after a reply and start it again: the status line shows `↺ resumed your last conversation`, Ctrl+Alt+H shows the earlier turns, and Claude remembers them.
- [ ] After `/new`, a restart does not resume. With `resumeHours` at `0`, no restart resumes.
- [ ] `/quit` and `/exit` in the chat quit ED Chat, with focus back on the game, and the tray icon goes.
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

## Codex (each release that changes the Codex backend)

Run with the Codex CLI installed and logged in (`codex login`), ed-mcp set up in only
one of the two CLIs.

- [ ] `/codex` posts `Switched to Codex.`, and `/version` names codex and its version.
- [ ] The first switch asks how Codex should run tools; the answer is in
      `codex.permissionMode`, and `claude.permissionMode` is unchanged.
- [ ] A question that needs ed-mcp (for example "where am I?") gets an answer from it,
      with ed-mcp set up only in Claude Code. No "ed-mcp not connected" notice shows.
- [ ] A reply streams into the card, and its chips copy.
- [ ] Asking for a command outside ED Chat's folder shows the approval card with the
      command; Ctrl+Alt+N declines it and the reply goes on.
- [ ] Ctrl+Alt+A on a card allows that kind of tool until `/new`.
- [ ] Ctrl+Alt+X stops a reply, and a message sent right after it is answered.
- [ ] `/new` starts a new conversation; the history shows only the new turns.
- [ ] Quit after a reply and start again within 12 hours: the Codex conversation resumes.
- [ ] Without the Windows sandbox installed: write down what Codex reports, for the spec.

## Switching

- [ ] `/claude` and `/codex` switch back and forth; each resumes its own conversation.
- [ ] The tray's Assistant submenu shows a check on the running assistant and switches.
- [ ] A switch while a reply streams stops it, and withdraws an open approval card.
- [ ] A switch while `settings.json` has an error says to fix it first.
- [ ] With only Codex installed and no `%APPDATA%\ed-chat\state.json`, the first start
      uses Codex. With both installed, it uses Claude and says once how to switch.
