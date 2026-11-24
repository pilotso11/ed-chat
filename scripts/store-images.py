"""Make the Microsoft Store images: nine 1920x1080 screenshots and the 2:3 poster art.

Usage, from the repository root (Windows, for the Segoe UI fonts):

    pip install pillow
    python scripts/store-images.py [out_dir]

The images go to out/store unless out_dir is given. Inputs:
- docs/images/hud-*.png: the README panel images (scripts/hud-screenshots.cjs).
- docs/store/in-game.jpg: a 1920x1080 crop of a real full-screen capture, overlay included.
- build/icon.png: the app icon, for the poster.

The text on the images, the captions and the listing text are in docs/store-listing.md.
"""

import random
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PANELS = ROOT / "docs" / "images"
ORANGE = (255, 140, 0)
WHITE = (240, 240, 245)
GREY = (170, 176, 190)
FONTS = Path("C:/Windows/Fonts")
W, H = 1920, 1080

# The chat on slide 02 and the poster. The overlay's reply card, drawn in its style.
QUESTION = "Best trade route near me?"
ANSWER = [
    "You're at Shinrarta Dezhra with 1,076 t. Take Bauxite from",
    "Angstrom Horizons in Hyades Sector RL-H a25-0 to Clervoy City",
    "in Gendalla, 63 ly: buy at 662, sell at 44,154. A full hold",
    "makes 46.8M a trip, about 168M an hour. Prices are 2 hours old.",
]
CHIPS = [("1", "Hyades Sector RL-H a25-0", "Angstrom Horizons")]

# Slides 03 to 09: (panel image, file name, tag, headline, subtitle).
PANEL_SLIDES = [
    ("hud-trade.png", "03-trade", "Trade", "Stop by stop trade loops",
     "What to sell and buy at each station, what is in the hold, and your profit an hour."),
    ("hud-build-engineer.png", "04-upgrades", "Upgrades", "Detailed engineering plans",
     "The rolls at each engineer, the material trades and the next stop, from a plan the "
     "assistant makes."),
    ("hud-explore-scanned.png", "05-exploration", "Exploration",
     "The bodies worth scanning, with values",
     "Earth-likes, water worlds, terraformables and bio planets as you arrive, first "
     "discoveries, and your credits an hour."),
    ("hud-exobiology.png", "06-exobiology", "Exobiology",
     "Samples, values and the species still to find",
     "The likely species on each planet, the distance to your next sample, and a bookmark "
     "back to your ship."),
    ("hud-mining.png", "07-mining", "Mining", "Which rocks to mine, and where to sell",
     "Prospector results against your targets, ring hotspots, your hold, and the best price "
     "for each load."),
    ("hud-massacre.png", "08-combat", "Combat", "Combat mission stacks on one panel",
     "Each faction's kills, what each kill still pays, and when to take more missions."),
    ("hud-passenger.png", "09-passengers", "Passengers & deliveries",
     "Every stop and deadline, in route order",
     "Passengers or cargo for each station, the soonest expiry, and the planned route."),
]


def font(name, size):
    return ImageFont.truetype(str(FONTS / name), size)


def space_bg(w, h, seed):
    """A dark navy gradient, a seeded star field and a faint orange glow low left."""
    # The gradient is smooth, so it is drawn at 1/8 size and scaled up.
    sw, sh = w // 8, h // 8
    grad = Image.new("RGB", (sw, sh))
    px = grad.load()
    for y in range(sh):
        for x in range(sw):
            dx, dy = (x - sw * 0.7) / sw, (y - sh * 0.45) / sh
            d = min(1.0, (dx * dx + dy * dy) ** 0.5 * 1.6)
            px[x, y] = (int(22 - 14 * d), int(28 - 18 * d), int(52 - 34 * d))
    grad = grad.resize((w, h), Image.BILINEAR)
    rnd = random.Random(seed)
    dr = ImageDraw.Draw(grad)
    for _ in range(w * h // 3000):
        x, y = rnd.randrange(w), rnd.randrange(h)
        b = rnd.randint(60, 200)
        r = 1 if rnd.random() < 0.93 else 2
        dr.ellipse((x, y, x + r, y + r), fill=(b, b, min(255, b + 30)))
    glow = Image.new("RGB", (w, h))
    ImageDraw.Draw(glow).ellipse((-w * 0.26, h * 0.6, w * 0.26, h * 1.4), fill=(120, 55, 10))
    glow = glow.filter(ImageFilter.GaussianBlur(220))
    return Image.blend(grad, Image.composite(glow, grad, glow.convert("L")), 0.55).convert("RGBA")


def wrap(draw, text, fnt, width):
    lines, line = [], ""
    for word in text.split():
        t = (line + " " + word).strip()
        if draw.textlength(t, font=fnt) <= width or not line:
            line = t
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def text_block(img, x, y, tag, head, sub, width, shade=False, h1=64, h2=34):
    """An orange tag, a white headline and a grey subtitle; shade puts a dark box behind."""
    f1, f2, ft = font("segoeuib.ttf", h1), font("segoeui.ttf", h2), font("segoeuib.ttf", 26)
    d = ImageDraw.Draw(img, "RGBA")
    head_lines, sub_lines = wrap(d, head, f1, width), wrap(d, sub, f2, width)
    l1, l2 = int(h1 * 1.2), int(h2 * 1.42)
    if shade:
        hgt = 64 + len(head_lines) * l1 + 24 + len(sub_lines) * l2 + 30
        ov = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ImageDraw.Draw(ov).rounded_rectangle(
            (x - 40, y - 40, x + width + 40, y + hgt), 24, fill=(8, 10, 20, 175)
        )
        img.alpha_composite(ov)
        d = ImageDraw.Draw(img, "RGBA")
    d.text((x, y), tag.upper(), font=ft, fill=ORANGE)
    d.rectangle((x, y + 40, x + 64, y + 44), fill=ORANGE)
    y += 64
    for line in head_lines:
        d.text((x, y), line, font=f1, fill=WHITE)
        y += l1
    y += 24
    for line in sub_lines:
        d.text((x, y), line, font=f2, fill=GREY)
        y += l2


def load_panel(name):
    """A README panel image, cut to its orange border, with rounded corners."""
    panel = Image.open(PANELS / name).convert("RGBA")
    r, _, b = panel.convert("RGB").split()
    border = ImageChops.multiply(
        Image.eval(r, lambda v: 255 if v > 90 else 0),
        Image.eval(b, lambda v: 255 if v < 60 else 0),
    )
    box = border.getbbox()
    if box:
        panel = panel.crop(box)
    m = Image.new("L", panel.size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, panel.width - 1, panel.height - 1), 10, fill=255)
    panel.putalpha(m)
    return panel


def place(img, panel, px, py):
    """Paste a panel with a soft drop shadow."""
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle(
        (px + 20, py + 30, px + panel.width - 10, py + panel.height), 30, fill=(0, 0, 0, 160)
    )
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(30)))
    img.alpha_composite(panel, (px, py))


def fit(panel, bw, bh, most=1.25):
    s = min(bw / panel.width, bh / panel.height, most)
    return panel.resize((int(panel.width * s), int(panel.height * s)), Image.LANCZOS)


def reply_card(s=1.0, status=True):
    """The overlay's chat: the question, a reply card with a chip, and the status line."""
    f = font("segoeui.ttf", int(26 * s))
    fs = font("segoeui.ttf", int(22 * s))
    pad, lh, gap = int(18 * s), int(38 * s), int(12 * s)
    d0 = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    widths = [d0.textlength(t, font=f) for t in ANSWER + ["› " + QUESTION]]
    widths += [d0.textlength(s_ + " · " + st, font=f) + 70 * s for _, s_, st in CHIPS]
    w = int(max(widths) + 2 * pad)
    qh = lh + 2 * pad
    ch = 2 * pad + lh * len(ANSWER) + int(34 * s) + int(48 * s) * len(CHIPS)
    sh = int(52 * s)
    img = Image.new("RGBA", (w, qh + gap + ch + (gap + sh if status else 0) + 1), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    border, bg = (170, 100, 20, 255), (10, 12, 18, 225)
    # The question, as the history shows it.
    d.rounded_rectangle((0, 0, w - 1, qh), int(8 * s), fill=(10, 12, 18, 200), outline=(90, 90, 100, 255))
    d.text((pad, pad), "› " + QUESTION, font=f, fill=(190, 196, 210))
    # The reply card. Segoe UI has no ▾, so the "more" arrow is drawn.
    y0 = qh + gap
    d.rounded_rectangle((0, y0, w - 1, y0 + ch), int(8 * s), fill=bg, outline=border, width=max(1, int(2 * s)))
    y = y0 + pad
    for t in ANSWER:
        d.text((pad, y), t, font=f, fill=WHITE)
        y += lh
    a, ay = int(10 * s), y + int(12 * s)
    d.polygon([(pad, ay), (pad + a, ay), (pad + a / 2, ay + a * 0.8)], fill=ORANGE)
    d.text((pad + int(18 * s), y), "more", font=fs, fill=ORANGE)
    y += int(40 * s)
    for n, sysname, station in CHIPS:
        cw = int(d.textlength(sysname + " · " + station, font=f) + 70 * s)
        d.rounded_rectangle((pad, y, pad + cw, y + int(40 * s)), int(4 * s), fill=(60, 35, 5, 255), outline=border)
        d.rectangle((pad + 2, y + 2, pad + int(38 * s), y + int(40 * s) - 2), fill=(150, 80, 0))
        d.text((pad + int(12 * s), y + int(3 * s)), n, font=f, fill=WHITE)
        x = pad + int(50 * s)
        d.text((x, y + int(3 * s)), sysname + " · ", font=f, fill=WHITE)
        d.text((x + d.textlength(sysname + " · ", font=f), y + int(3 * s)), station, font=f, fill=(255, 190, 90))
        y += int(48 * s)
    if status:
        y1 = y0 + ch + gap
        d.rounded_rectangle((0, y1, w - 1, y1 + sh), int(8 * s), fill=bg, outline=border, width=max(1, int(2 * s)))
        d.text((pad, y1 + int(9 * s)), "● idle", font=f, fill=WHITE)
        ax = pad + d.textlength("● idle  ", font=f)
        d.rounded_rectangle((ax, y1 + int(11 * s), ax + int(70 * s), y1 + int(41 * s)), int(4 * s), outline=border)
        d.text((ax + int(8 * s), y1 + int(12 * s)), "AUTO", font=fs, fill=ORANGE)
    return img


def in_game_slide():
    img = Image.open(ROOT / "docs" / "store" / "in-game.jpg").convert("RGBA")
    # Centre-crop to 16:9 first, so a capture that is not quite 16:9 is not stretched.
    cw, ch = min(img.width, img.height * W // H), min(img.height, img.width * H // W)
    left, top = (img.width - cw) // 2, (img.height - ch) // 2
    img = img.crop((left, top, left + cw, top + ch)).resize((W, H), Image.LANCZOS)
    text_block(img, 90, 640, "ED Chat for Elite Dangerous",
               "An AI assistant and live panels on top of your game",
               "Exobiology values on the right, route chips from the assistant below.",
               width=540, shade=True, h1=46, h2=27)
    return img


def chat_slide():
    img = space_bg(W, H, 2)
    card = fit(reply_card(1.15), 1000, 900, 1.0)
    px, py = W - 70 - card.width, (H - card.height) // 2
    place(img, card, px, py)
    text_block(img, 110, 300, "Chat", "Answers without leaving the game",
               "It knows where you are and what you fly. Names become chips that one key "
               "copies to the galaxy map.", width=min(720, px - 200))
    return img


def panel_slide(name, tag, head, sub, seed):
    img = space_bg(W, H, seed)
    panel = load_panel(name)
    panel = fit(panel, 860 if panel.width < 1000 else 900, 900)
    px, py = W - 80 - panel.width, (H - panel.height) // 2
    place(img, panel, px, py)
    text_block(img, 110, 300, tag, head, sub, width=min(720, px - 260))
    return img


def poster():
    """2:3 poster art: the icon and name, the chat, and two panels below it."""
    w, h = 1440, 2160
    img = space_bg(w, h, 99)
    icon = Image.open(ROOT / "build" / "icon.png").convert("RGBA").resize((240, 240), Image.LANCZOS)
    img.alpha_composite(icon, ((w - 240) // 2, 110))
    d = ImageDraw.Draw(img)
    f = font("segoeuib.ttf", 140)
    d.text(((w - d.textlength("ED Chat", font=f)) / 2, 360), "ED Chat", font=f, fill=WHITE)
    f2 = font("segoeui.ttf", 50)
    for i, line in enumerate(["An AI assistant and live panels", "for Elite Dangerous"]):
        d.text(((w - d.textlength(line, font=f2)) / 2, 560 + i * 66), line, font=f2, fill=GREY)
    exo = fit(load_panel("hud-exobiology.png"), 720, 690)
    combat = fit(load_panel("hud-massacre.png"), 640, 560)
    place(img, exo, 90, h - 90 - exo.height)
    place(img, combat, w - 90 - combat.width, h - 160 - combat.height)
    card = fit(reply_card(1.6, status=False), w - 180, 700, 1.0)
    place(img, card, (w - card.width) // 2, 760)
    return img


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "out" / "store"
    out.mkdir(parents=True, exist_ok=True)
    images = {"01-in-game": in_game_slide(), "02-chat": chat_slide()}
    for i, (name, file, tag, head, sub) in enumerate(PANEL_SLIDES, start=3):
        images[file] = panel_slide(name, tag, head, sub, seed=i)
    images["poster-1440x2160"] = poster()
    for file, img in images.items():
        img.convert("RGB").save(out / f"{file}.png")
        print(out / f"{file}.png")


if __name__ == "__main__":
    main()
