import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { HudView } from "../core/hud/hud.js";

function Hud() {
  const [v, setV] = useState<HudView | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => window.overlay.onHud(setV), []);
  // Main sizes the window to the content.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => window.overlay.reportHudHeight(el.getBoundingClientRect().height);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const style = v
    ? ({ "--font": `${v.fontSize}px`, "--bg-alpha": v.backgroundOpacity } as React.CSSProperties)
    : undefined;
  const p = v?.panel ?? null;
  return (
    <div ref={ref} className="hud" style={style}>
      {v && (p || v.route || v.moving) && (
        <div className={`panel${v.moving ? " moving" : ""}`}>
          {v.moving && <div className="hint">{v.moving}</div>}
          {p && (
            <>
              <div className="head">
                <span className="title">{p.title}</span>
                {p.subtitle && <span className="subtitle">· {p.subtitle}</span>}
                {p.right && <span className="right">{p.right}</span>}
              </div>
              {p.rows.map((r, i) => (
                <div key={i} className={`row ${r.tone ?? ""}`}>
                  <div className="line">
                    <span className="text">{r.text}</span>
                    {r.right && <span className="right">{r.right}</span>}
                  </div>
                  {r.bar !== undefined && (
                    <div className="bar">
                      <div style={{ width: `${Math.round(r.bar * 100)}%` }} />
                    </div>
                  )}
                </div>
              ))}
              {p.footer.map((f, i) => (
                <div key={`f${i}`} className="footer">
                  {f}
                </div>
              ))}
            </>
          )}
          {v.route && (
            <div className={p ? "route footer" : "route"}>
              {!p && <span className="title">ROUTE </span>}
              {v.route}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Hud />);
