import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import type { Chip } from "../core/chips.js";
import { chordFromKey } from "../core/chord.js";
import type { ViewModel } from "../core/view.js";

// Only the open chat takes the mouse; elsewhere chips are labels for the copy hotkey.
function Chips({
  chips,
  keyLabel,
  clickable = false,
}: {
  chips: Chip[];
  keyLabel: string;
  clickable?: boolean;
}) {
  if (!chips.length) return null;
  return (
    <div className="chips" title={`${keyLabel} copies chip n`}>
      {chips.map((c) =>
        clickable ? (
          <button key={c.n} className="chip" onClick={() => window.overlay.copyChip(c.n)}>
            {c.n} 📋 {c.text}
          </button>
        ) : (
          <span key={c.n} className="chip">
            {c.n} 📋 {c.text}
          </span>
        ),
      )}
    </div>
  );
}

function ChatInput({ moving, canSend }: { moving: boolean; canSend: boolean }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setText("");
      window.overlay.closeChat();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Keep the text when main refuses it (a reply is running, or Claude gave up).
      if (!canSend) return;
      void window.overlay.send(text).then((ok) => {
        if (ok) setText("");
      });
    }
  };
  return (
    <div className="input">
      {moving && <div className="warn">⚠ ship is moving</div>}
      <textarea
        ref={ref}
        rows={2}
        value={text}
        placeholder={canSend ? undefined : "Claude is replying…"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
    </div>
  );
}

export function App() {
  const [v, setV] = useState<ViewModel | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const historyBox = useRef<HTMLDivElement>(null);
  // The history view does not take the mouse, so keep the newest turn in sight.
  useLayoutEffect(() => {
    const el = historyBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => window.overlay.onView(setV), []);

  // Ctrl+Alt hotkeys are not registered while the chat has focus, so AltGr can type letters.
  // A real Ctrl+Alt chord goes to main instead. The listener is on the window, so the chord
  // still works after a click on a chip or the history moves focus off the input.
  const chatInput = v?.chat?.input === true;
  useEffect(() => {
    if (!chatInput) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const chord = chordFromKey({
        key: e.key,
        code: e.code,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
        altGraph: e.getModifierState("AltGraph"),
      });
      if (!chord) return;
      e.preventDefault();
      window.overlay.chord(chord);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chatInput]);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      window.overlay.reportHeight(el.getBoundingClientRect().height),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [v === null]);

  if (!v) return null;
  const style = {
    "--font": `${v.ui.fontSize}px`,
    "--bg-alpha": v.ui.backgroundOpacity,
    "--max-lines": v.ui.maxLines,
    "--chat-lines": v.ui.chatLines,
    flexDirection: v.ui.growsUp ? "column-reverse" : "column",
  } as CSSProperties;

  return (
    <div ref={root} className="overlay" style={style}>
      {v.icon && (
        <div
          className={v.icon.danger ? "icon danger" : "icon"}
          style={{ alignSelf: v.ui.align }}
          title="ED Chat"
        >
          {v.icon.danger ? "⛔" : "✦"}
          {v.icon.dot && !v.icon.danger && <span className="dot" />}
        </div>
      )}
      <div
        className={v.mode === "chat" && v.chat?.input ? "strip drag" : "strip"}
        hidden={v.mode === "icon"}
      >
        <div className="status">
          <span>{v.status}</span>
          {v.notice && <span className="notice">{v.notice}</span>}
        </div>
        {v.mode === "strip" && v.pinned && <div className="pinned">▸ {v.pinned}</div>}
        {v.mode === "strip" && <Chips chips={v.chips} keyLabel={v.ui.copyChipKey} />}
      </div>
      {v.approval && (
        <div className="approval">
          <div>
            Claude wants to run <b>{v.approval.toolName}</b>
          </div>
          <div className="summary">{v.approval.summary}</div>
          <div className="keys">
            {v.approval.approveKey} allow · {v.approval.denyKey} deny
          </div>
        </div>
      )}
      {v.card && (
        <div className="card">
          <div className="text">{v.card.text}</div>
          <Chips chips={v.card.chips} keyLabel={v.ui.copyChipKey} />
        </div>
      )}
      {v.chat && (
        <div className="chat">
          <div className="history" ref={historyBox}>
            {v.chat.history.map((t, i) => (
              <div key={i} className={t.role}>
                {t.text}
              </div>
            ))}
            {v.chat.streaming !== null && <div className="assistant">{v.chat.streaming}</div>}
          </div>
          <Chips chips={v.chat.chips} keyLabel={v.ui.copyChipKey} clickable={v.chat.input} />
          {v.chat.input && <ChatInput moving={v.chat.moving} canSend={v.chat.canSend} />}
        </div>
      )}
    </div>
  );
}
