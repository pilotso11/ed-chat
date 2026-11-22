import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { HudView } from "../core/hud/hud.js";
import type { RouteRow } from "../core/hud/panels.js";
import { footerText, footerTone } from "../core/hud/footer.js";

const MARKS: Record<RouteRow["kind"], string> = {
  current: "●",
  label: "",
  next: "▸",
  more: "",
};

/**
 * Leading spaces in a row's text indent it under the row above (white-space: nowrap would drop
 * them): half an em each.
 */
function indent(text: string): { paddingLeft: string } | undefined {
  const n = /^ */.exec(text)![0].length;
  return n ? { paddingLeft: `${n / 2}em` } : undefined;
}

export function HudPanel() {
  const [v, setV] = useState<HudView | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => window.overlay.onHud(setV), []);
  // Main sizes the window to the content.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Observing reports the first size too.
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      window.overlay.reportHudSize(r.width, r.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const style = v
    ? ({
        "--font": `${v.fontSize}px`,
        "--bg-alpha": v.backgroundOpacity,
        "--min-width": `${Math.round(v.width * (v.fontSize / 15))}px`,
      } as React.CSSProperties)
    : undefined;
  const p = v?.panel ?? null;
  return (
    <div ref={ref} className="hud" style={style}>
      {v && (p || v.route || v.moving) && (
        <div className={`panel${v.moving ? " moving" : ""}`}>
          {v.moving && <div className="hint">{v.moving}</div>}
          {p && (
            <>
              <div className={p.tone ? `head ${p.tone}` : "head"}>
                <span className="title">{p.title}</span>
                {p.subtitle && <span className="subtitle">· {p.subtitle}</span>}
                {p.right && <span className="right">{p.right}</span>}
              </div>
              {p.rows.map((r, i) => (
                <div key={i} className={`row ${r.tone ?? ""}`}>
                  <div className="line">
                    <span className="text" style={indent(r.text)}>
                      {r.text.replace(/^ +/, "")}
                    </span>
                    {r.right && <span className="right">{r.right}</span>}
                  </div>
                  {r.detail && <div className="detail">{r.detail}</div>}
                  {r.bar !== undefined && (
                    <div className="bar">
                      <div style={{ width: `${Math.round(r.bar * 100)}%` }} />
                    </div>
                  )}
                </div>
              ))}
              {p.footer.map((f, i) => (
                <div key={`f${i}`} className={footerTone(f) ? `footer ${footerTone(f)}` : "footer"}>
                  {footerText(f)}
                </div>
              ))}
            </>
          )}
          {v.route && (
            <div className={p ? "route under" : "route"}>
              {!p && <div className="title">ROUTE</div>}
              {v.route.map((r, i) => (
                <div key={i} className={`line stop ${r.kind}`}>
                  <span className="mark">{MARKS[r.kind]}</span>
                  <span className="text">{r.text}</span>
                  {r.right && <span className="right">{r.right}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
