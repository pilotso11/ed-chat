# Microsoft Store listing

The text and images for the Store listing (9PL5FNGQRJX8) in Partner Center → Store
listings → English. Keep it in step with the README.

## Images

`scripts/store-images.py` makes the screenshots and the poster art into `out/store`. Run it
on Windows (it uses the Segoe UI fonts) after the README panel images change:

```
pip install pillow
python scripts/store-images.py
```

- The panel slides use the README images in `docs/images`, so run
  `scripts/hud-screenshots.cjs` first when the panels change.
- `docs/store/in-game.jpg` is a crop of a real full-screen capture with the overlay. Steam's
  screenshot key captures only the game, so take a new one with Win+Shift+S (full screen),
  with any frame-rate overlay off, then crop it to 16:9 around the panel and the chat.
- The chat on slide 02 and the poster is drawn in the overlay's style from `QUESTION`,
  `ANSWER` and `CHIPS` in the script. A real capture of the same question would be better.
- The headlines on the slides are in the script. Keep them short and plain.

## Short description

A free AI assistant, copilot and live activity panels for Elite Dangerous. Ask a question without
leaving the game, and see what matters for trade, engineering, exploration, exobiology,
mining, combat missions and passenger runs, straight from your journal. Works with Claude
Code or OpenAI's Codex.

## Description

Elite Dangerous is a game you play with a browser open: Inara, Spansh, EDSM, the wiki, a
spreadsheet for your combat missions. ED Chat brings that into the game, in a small overlay
that stays out of the way while you fly.

ASK WITHOUT LEAVING THE GAME
Press Ctrl+Alt+Enter, type a question, and press Enter. The answer shows in a corner of
the screen. System and station names in it become numbered chips, and one key copies a
chip, ready to paste into the galaxy map.

AN ASSISTANT THAT KNOWS YOUR GAME
With the free ed-mcp tools, the assistant reads your journal and looks up trade routes,
engineers and blueprints, materials, stations and mission runs. It knows where you are,
what you fly and what is in your hold, so you do not have to tell it. ED Chat is your AI Copilot.

LIVE PANELS
A second panel follows what you are doing, from your journal, without asking the AI:
• Trade: stop by stop trade loops, what to sell and buy at each station, the hold against
  the plan, and your profit an hour.
• Upgrades: detailed engineering plans, with the rolls at each engineer, the material
  trades and the next stop.
• Exploration: the bodies worth scanning and mapping as you arrive, with their values,
  first discoveries and your credits an hour.
• Exobiology: each species' samples and value, the likely species still to find, the
  distance to your next sample, and a bookmark back to your ship.
• Mining: mine or skip for each rock, ring hotspots, your hold and limpets, and the best
  price for each load, fleet carriers included.
• Combat: each faction's progress, what each kill still pays, and when to take more
  missions.
• Passengers and deliveries: each stop's passengers or cargo and deadlines, in route
  order.

YOUR ASSISTANT, YOUR ACCOUNT
ED Chat runs the Claude Code or Codex CLI that you already use, with your own login and
settings. Switch with /claude or /codex. ED Chat has no account and no telemetry; your
messages go only to the assistant that you choose.

MADE FOR PLAYING
• Hotkeys for everything, active only while Elite is in front.
• The chat does not open while your ship is in danger.
• Allow or deny the assistant's tool requests with one key.
• Colour themes that follow your HUD colour, and a compact font.
• Put it in any corner or on any monitor, or shrink it to an icon.

REQUIREMENTS
• Windows 10 or 11.
• Elite Dangerous in Borderless or Windowed mode. The overlay cannot show over exclusive
  fullscreen or in VR.
• Claude Code (Anthropic) or the Codex CLI (OpenAI), installed and logged in. These need
  an account with that company, and can need a paid plan.
• Recommended: ed-mcp (free, open source) for the game tools.

ED Chat is free and open source: github.com/pilotso11/ed-chat

ED Chat is an unofficial fan-made tool. It is not affiliated with or endorsed by Frontier
Developments. Elite Dangerous is a trademark of Frontier Developments plc.

## What's new in this version

Since the last Store release:
• Trade panel: stop by stop trade loops, with the hold, the market and profit an hour.
• Upgrade panel: detailed engineering plans, roll by roll and stop by stop.
• Mining panel: mine or skip for each rock, ring hotspots, your hold, and where to sell
  each load, fleet carriers included.
• Passenger and delivery panel: each stop, passenger and deadline, in route order.
• Surface bookmarks with a hotkey, and directions back to them.
• Credits an hour for exploration and exobiology.
• Combat mission stacks show what each kill still pays.
• Colour themes that follow the game's HUD colour, and a compact font.
• The main hotkeys are now on Ctrl+Alt. /quit in the chat quits ED Chat.

## Product features

1. AI Copilot for Elite Dangerous
2. Ask questions without leaving the game
3. One key copies a system or station name to the galaxy map
4. Knows your location, ship and cargo from your journal
5. Detailed panels for most game modes: exploration, exobiology, combat, trade and mining
6. Stop by stop trade loops with profit an hour
7. Detailed engineering plans: rolls, material trades and stops
8. Surface bookmarks with directions back to your ship
9. Works with Claude Code or OpenAI's Codex
10. Hotkeys for everything, active only while the game is in front
11. Colour themes that follow your HUD colour
12. Free and open source, with no telemetry

## Search terms (7)

Elite Dangerous · ED overlay · trade routes · engineering · exobiology · AI assistant ·
Claude Code

## Screenshots (1920×1080) and captions

1. 01-in-game.png: "An AI assistant and live panels on top of Elite Dangerous."
2. 02-chat.png: "Ask without leaving the game. One key copies a name to the galaxy map."
3. 03-trade.png: "Stop by stop trade loops, with your profit an hour."
4. 04-upgrades.png: "Detailed engineering plans: the rolls, trades and stops."
5. 05-exploration.png: "Exploration: the bodies worth your time, with values and credits an hour."
6. 06-exobiology.png: "Exobiology: samples, values, likely species and the way back to your ship."
7. 07-mining.png: "Mining: mine or skip, and where to sell each load."
8. 08-combat.png: "Combat: each faction's progress and what each kill still pays."
9. 09-passengers.png: "Passengers and deliveries: each stop and deadline, in route order."

## Poster art (2:3)

poster-1440x2160.png (Partner Center also takes 720×1080): the icon, "ED Chat", "An AI assistant and live panels for Elite
Dangerous", a trade-route answer, and the exobiology and combat panels.
