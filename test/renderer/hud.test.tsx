import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HudView } from "../../src/core/hud/hud.js";
import { HudPanel } from "../../src/renderer/HudPanel.js";
import { fakeOverlay, FakeResizeObserver, resize } from "./overlay.js";

const base: HudView = {
  panel: null,
  route: null,
  moving: null,
  fontSize: 15,
  backgroundOpacity: 0.5,
  width: 300,
};

function setup() {
  const overlay = fakeOverlay();
  const { container, unmount } = render(<HudPanel />);
  return { overlay, unmount, hud: container.querySelector<HTMLDivElement>(".hud")! };
}

describe("activity panel", () => {
  it("shows nothing until main sends a view", () => {
    const { hud } = setup();
    expect(hud.children).toHaveLength(0);
  });

  it("reports its size at once and on each change, until unmounted", () => {
    const { overlay, unmount } = setup();
    expect(overlay.reportHudSize).toHaveBeenLastCalledWith(0, 0);
    const atMount = overlay.reportHudSize.mock.calls.length;
    resize();
    expect(overlay.reportHudSize).toHaveBeenCalledTimes(atMount + 1);
    // New views do not add observers.
    overlay.hud({ ...base, moving: "move" });
    overlay.hud({ ...base, moving: "move on" });
    expect(FakeResizeObserver.observing()).toBe(1);
    unmount();
    expect(FakeResizeObserver.observing()).toBe(0);
  });

  it("shows nothing for a view with no panel, route or move", () => {
    const { overlay, hud } = setup();
    overlay.hud(base);
    expect(hud.children).toHaveLength(0);
  });

  it("draws a panel's head, rows and footer", () => {
    const { overlay, hud } = setup();
    overlay.hud({
      ...base,
      fontSize: 30,
      panel: {
        mode: "exobiology",
        title: "EXOBIOLOGY",
        subtitle: "Body 3",
        right: "95.1M",
        rows: [
          { text: "Stratum Tectonicas", right: "2/3", bar: 0.666, tone: "good" },
          { text: "Bacterium", detail: "likely Aurasus" },
        ],
        footer: ["one more sample"],
      },
    });
    expect(hud.style.getPropertyValue("--font")).toBe("30px");
    // The width scales with the font: 300 at 15 px is 600 at 30 px.
    expect(hud.style.getPropertyValue("--min-width")).toBe("600px");
    expect(hud.querySelector(".head .title")?.textContent).toBe("EXOBIOLOGY");
    expect(hud.querySelector(".head .subtitle")?.textContent).toBe("· Body 3");
    expect(hud.querySelector(".head .right")?.textContent).toBe("95.1M");
    const rows = hud.querySelectorAll(".row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.className).toBe("row good");
    expect(rows[0]!.querySelector(".right")?.textContent).toBe("2/3");
    expect(rows[0]!.querySelector<HTMLDivElement>(".bar > div")!.style.width).toBe("67%");
    expect(rows[0]!.querySelector(".detail")).toBeNull();
    expect(rows[1]!.querySelector(".detail")?.textContent).toBe("likely Aurasus");
    expect(rows[1]!.querySelector(".bar")).toBeNull();
    expect(hud.querySelector(".footer")?.textContent).toBe("one more sample");
    // No route: no route block.
    expect(hud.querySelector(".route")).toBeNull();
  });

  it("draws a route alone, with its title and stop marks", () => {
    const { overlay, hud } = setup();
    overlay.hud({
      ...base,
      route: [
        { kind: "current", text: "Sol", right: "3 jumps" },
        { kind: "label", text: "sell cargo" },
        { kind: "next", text: "Achenar" },
        { kind: "more", text: "+2 more" },
      ],
    });
    const route = hud.querySelector(".route")!;
    expect(route.className).toBe("route");
    expect(route.querySelector(".title")?.textContent).toBe("ROUTE");
    const stops = [...route.querySelectorAll(".stop")].map((s) => [
      s.className,
      s.querySelector(".mark")?.textContent,
      s.querySelector(".text")?.textContent,
      s.querySelector(".right")?.textContent ?? null,
    ]);
    expect(stops).toEqual([
      ["line stop current", "●", "Sol", "3 jumps"],
      ["line stop label", "", "sell cargo", null],
      ["line stop next", "▸", "Achenar", null],
      ["line stop more", "", "+2 more", null],
    ]);
  });

  it("puts the route under a panel, without its own title", () => {
    const { overlay, hud } = setup();
    overlay.hud({
      ...base,
      panel: { mode: "exploration", title: "EXPLORATION", rows: [], footer: [] },
      route: [{ kind: "current", text: "Sol" }],
    });
    expect(hud.querySelector(".route")?.className).toBe("route under");
    expect(hud.querySelector(".route .title")).toBeNull();
    expect(hud.querySelector(".head .subtitle")).toBeNull();
  });

  it("shows the move hint, also with no panel", () => {
    const { overlay, hud } = setup();
    overlay.hud({ ...base, moving: "Arrows move the panel · Enter to finish" });
    expect(hud.querySelector(".panel")?.className).toBe("panel moving");
    expect(hud.querySelector(".hint")?.textContent).toBe("Arrows move the panel · Enter to finish");
  });
});
