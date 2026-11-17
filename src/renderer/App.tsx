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

// Outside the open chat, clicks pass through to the game; a hovered target takes them.
// Targets nest (a chip in the card), so the window takes clicks while any target is hovered.
let hovered = 0;
function setHovered(delta: number): void {
  const was = hovered > 0;
  hovered = Math.max(0, hovered + delta);
  if (hovered > 0 !== was) window.overlay.hover(hovered > 0);
}

function useClickTarget(onHover?: (over: boolean) => void) {
  const over = useRef(false);
  const hover = (v: boolean) => {
    if (over.current === v) return;
    over.current = v;
    setHovered(v ? 1 : -1);
    onHover?.(v);
  };
  // A target can vanish under the pointer without a mouseleave; the game must get its clicks back.
  useEffect(
    () => () => {
      if (over.current) {
        setHovered(-1);
        onHover?.(false);
      }
    },
    [],
  );
  return { onMouseEnter: () => hover(true), onMouseLeave: () => hover(false) };
}

function ChipButton({ chip }: { chip: Chip }) {
  const target = useClickTarget();
  return (
    <button className="chip" {...target} onClick={() => window.overlay.copyChip(chip.n)}>
      <span className="keycap">{chip.n}</span> {chip.text}
      {chip.detail && <span className="chip-detail"> · {chip.detail}</span>}
    </button>
  );
}

// A command in backticks shows as code; a click copies it. "+n" lists every notice.
function NoticeView({ notice }: { notice: NonNullable<ViewModel["notice"]> }) {
  const target = useClickTarget();
  const more = useClickTarget();
  const parts = notice.text.split("`");
  return (
    <span className="notices">
      <span
        className={notice.command ? "notice copyable" : "notice"}
        title={notice.command ? "Click to copy the command" : notice.text}
        {...(notice.command ? target : {})}
        onClick={notice.command ? () => window.overlay.copyNotice() : undefined}
      >
        {parts.map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))}
      </span>
      {notice.more > 0 && (
        <button
          className="more-notices"
          title="Show all messages"
          {...more}
          onClick={() => window.overlay.showNotices()}
        >
          +{notice.more}
        </button>
      )}
    </span>
  );
}

function KeysCard({ rows }: { rows: NonNullable<ViewModel["keys"]> }) {
  const target = useClickTarget();
  return (
    <div className="keys-card" {...target} onClick={() => window.overlay.closeKeys()}>
      <div className="title">ED Chat hotkeys</div>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td className={r.failed.length || r.unused.length ? "taken" : undefined}>
                {r.keys}
                {r.failed.length > 0 && ` ⚠ not working: ${r.failed.join(", ")}`}
                {r.unused.length > 0 && ` ⚠ off in always scope: ${r.unused.join(", ")}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="hint">Click to close · tray menu → Show hotkeys</div>
    </div>
  );
}

// The card clamps long replies; "more" shows the whole reply. It does not fade while hovered.
function Card({ card, keyLabel }: { card: NonNullable<ViewModel["card"]>; keyLabel: string }) {
  const target = useClickTarget((over) => window.overlay.holdCard(over));
  const text = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState(false);
  const full = card.full;
  useLayoutEffect(() => {
    const el = text.current;
    if (el) setClamped(el.scrollHeight > el.clientHeight + 1);
  });
  return (
    <div className="card" {...target}>
      <div ref={text} className={full ? "text full" : "text"}>
        {card.text}
      </div>
      {(clamped || full) && (
        <button className="more" onClick={() => window.overlay.showMore()}>
          {full ? "▴ less" : "▾ more"}
        </button>
      )}
      <Chips chips={card.chips} keyLabel={keyLabel} />
    </div>
  );
}

function Icon({
  icon,
  align,
}: {
  icon: NonNullable<ViewModel["icon"]>;
  align: ViewModel["ui"]["align"];
}) {
  const target = useClickTarget();
  return (
    <div
      className={icon.danger ? "icon danger" : "icon"}
      style={{ alignSelf: align }}
      title="ED Chat"
      {...target}
      onClick={() => window.overlay.expand()}
    >
      {icon.danger ? "⛔" : "✦"}
      {icon.dot && !icon.danger && <span className="dot" />}
    </div>
  );
}

function Chips({ chips, keyLabel }: { chips: Chip[]; keyLabel: string }) {
  if (!chips.length) return null;
  return (
    <div className="chips" title={`Click or ${keyLabel} copies chip n`}>
      {chips.map((c) => (
        <ChipButton key={c.n} chip={c} />
      ))}
    </div>
  );
}

function AnswerButton({
  id,
  answer,
  children,
}: {
  id: string;
  answer: "approve" | "deny" | "alwaysAllow";
  children: string;
}) {
  const target = useClickTarget();
  return (
    <button
      className={`answer ${answer}`}
      {...target}
      onClick={() => window.overlay.answerApproval(id, answer)}
    >
      {children}
    </button>
  );
}

// Keyed by request id, so a new request restarts the pulse and the countdown.
function ApprovalCard({ a }: { a: NonNullable<ViewModel["approval"]> }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((a.deadline - now) / 1000));
  const share = Math.min(1, Math.max(0, (a.deadline - now) / a.timeoutMs));
  return (
    <div className="approval">
      <div className="head">
        <span>
          Claude wants to run <b>{a.toolName}</b>
        </span>
        {a.position && <span className="position">{a.position}</span>}
      </div>
      {a.shell && <div className="warn">⚠ runs a shell command</div>}
      <div className="summary">{a.summary}</div>
      <div className="answers">
        <AnswerButton id={a.id} answer="approve">{`Allow · ${a.approveKey}`}</AnswerButton>
        <AnswerButton id={a.id} answer="deny">{`Deny · ${a.denyKey}`}</AnswerButton>
        <AnswerButton id={a.id} answer="alwaysAllow">{`Always · ${a.alwaysKey}`}</AnswerButton>
      </div>
      <div className="countdown" title={`Denied in ${left} s without an answer`}>
        <div style={{ width: `${share * 100}%` }} />
      </div>
      <div className="hint">denied in {left} s without an answer</div>
    </div>
  );
}

function ChatInput({ canSend }: { canSend: boolean }) {
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

  // Ctrl+Alt hotkeys are not registered while the overlay has focus, so AltGr can type
  // letters. A real Ctrl+Alt chord goes to main instead. The window gets keys only while it has
  // focus, so the listener is always on: the approval keys also work when the overlay keeps
  // focus with the chat closed, for example when Windows refuses to give focus back.
  const chatInput = v?.chat?.input === true;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      // The input handles its own Escape; this one closes the chat after a click moved focus off it.
      if (chatInput && e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        window.overlay.closeChat();
        return;
      }
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
      {v.icon && <Icon icon={v.icon} align={v.ui.align} />}
      <div
        className={v.mode === "chat" && v.chat?.input ? "strip drag" : "strip"}
        hidden={v.mode === "icon"}
      >
        <div className="status">
          <span className="state">
            {v.status}
            {v.auto && (
              <span className="badge" title="Claude runs most tools without asking">
                AUTO
              </span>
            )}
          </span>
          {v.notice && <NoticeView notice={v.notice} />}
        </div>
        {v.mode === "strip" && v.pinned && <div className="pinned">▸ {v.pinned}</div>}
        {v.mode === "strip" && <Chips chips={v.chips} keyLabel={v.ui.copyChipKey} />}
      </div>
      {v.keys && <KeysCard rows={v.keys} />}
      {v.approval && <ApprovalCard key={v.approval.id} a={v.approval} />}
      {v.card && <Card card={v.card} keyLabel={v.ui.copyChipKey} />}
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
          <Chips chips={v.chat.chips} keyLabel={v.ui.copyChipKey} />
          {v.chat.input && <ChatInput canSend={v.chat.canSend} />}
        </div>
      )}
    </div>
  );
}
