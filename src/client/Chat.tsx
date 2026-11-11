// Chat (M29): a button with an unread count, a sheet with the history, quick phrases, emojis and a
// text box, and a speech bubble by whoever just spoke. Nothing here touches the game.
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CHAT_KEEP,
  CHAT_MAX,
  CHAT_PRESETS,
  CHAT_SHOW_MS,
  type ChatMsg,
  type ChatPreset,
  type RoomView,
} from "../protocol";
import { type T, useI18n } from "./i18n";
import { follow, useResting } from "./Toss";

const CHAT_KEY = "skyjo:chat";
/** Sent as text: an emoji reads the same in every language. */
const EMOJIS = ["😂", "👍", "👏", "😱", "😭", "😡", "🥳", "🤔", "❤️", "🍀"];
/** Where a bubble points: a spot on screen (px). */
export interface At {
  x: number;
  y: number;
  /** The bubble hangs below the spot (an opponent at the top of the table), not above it. */
  below?: boolean;
}
type Said = { preset: ChatPreset } | { text: string };

/** A message as this phone reads it: a quick phrase in its own language, text as typed. */
const words = (t: T, m: ChatMsg) => (m.preset ? t(`chat_${m.preset}`) : (m.text ?? ""));
const who = (t: T, m: ChatMsg) => m.name || t("chatSpectator");

/**
 * This phone's chat: the messages it has seen (the room keeps its own only in memory), the ones
 * to pop as bubbles now, the unread count, and the "Chat" switch, remembered across visits. Off,
 * you see no message and send none.
 */
export function useChat(
  room: Pick<RoomView, "chat" | "chatFresh" | "chatIn" | "you"> | null,
  send: (said: Said) => void,
) {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(CHAT_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOn(!on);
    try {
      localStorage.setItem(CHAT_KEY, on ? "0" : "1");
    } catch {
      // Not remembered next visit; still applies now.
    }
  };
  const [log, setLog] = useState<ChatMsg[]>([]);
  const [said, setSaid] = useState<ChatMsg[]>([]);
  const [open, setOpen] = useState(false);
  /** The last message read (its id), and when Send works again (ms). */
  const [read, setRead] = useState(0);
  const [until, setUntil] = useState(0);
  /** After a send, Send rests at least until the room has answered it. */
  const guard = useRef(0);
  /** The text being typed: kept here, since the sheet is drawn anew when the summary comes or goes. */
  const [text, setText] = useState("");
  const seen = useRef(0);
  useEffect(() => {
    if (!room) return;
    setUntil(Math.max(guard.current, Date.now() + (room.chatIn ?? 0)));
    const chat = room.chat ?? [];
    // A quick phrase this build doesn't know (a newer server) is skipped.
    const news = chat.filter(
      (m) => m.id > seen.current && (!m.preset || CHAT_PRESETS.includes(m.preset)),
    );
    if (!news.length) return;
    seen.current = news[news.length - 1].id;
    setLog((log) => [...log, ...news].slice(-CHAT_KEEP));
    // Only what was just said pops: a reconnecting phone gets the rest as history.
    const fresh = chat.slice(chat.length - (room.chatFresh ?? 0)).filter((m) => news.includes(m));
    if (!fresh.length) return;
    // One bubble per sender: their latest.
    setSaid((said) => [...said.filter((s) => !fresh.some((m) => m.from === s.from)), ...fresh]);
    // Not cleared when the next view comes: each bubble has its own 3 s.
    setTimeout(() => setSaid((said) => said.filter((s) => !fresh.includes(s))), CHAT_SHOW_MS);
  }, [room]);

  const last = log.at(-1)?.id ?? 0;
  useEffect(() => {
    if (open) setRead(last);
  }, [open, last]);
  const you = room?.you ?? null;
  // Your own don't count. A spectator's have no seat to tell them by: their sheet stays open.
  const unread = log.filter((m) => m.id > read && (you === null || m.from !== you)).length;
  return {
    on,
    toggle,
    log,
    said: on ? said : [],
    unread: on && !open ? unread : 0,
    open,
    setOpen,
    until,
    you,
    text,
    setText,
    say: (said: Said) => {
      send(said);
      // Until the room's answer says how long: no double send.
      guard.current = Date.now() + 400;
      setUntil((until) => Math.max(until, guard.current));
    },
  };
}
export type Chat = ReturnType<typeof useChat>;

/** The button, 44 px, with the unread count; it opens the sheet. Dimmed while chat is off. */
export function ChatButton({ chat }: { chat: Chat }) {
  const { t } = useI18n();
  return (
    <>
      <button
        type="button"
        className={`btn icon chat-btn${chat.on ? "" : " off"}`}
        data-testid="chat-button"
        aria-label={chat.unread ? t("chatUnread", { n: chat.unread }) : t("chat")}
        aria-haspopup="dialog"
        onClick={() => chat.setOpen(true)}
      >
        <span aria-hidden="true">💬</span>
        {chat.unread > 0 && (
          <span className="chat-badge" aria-hidden="true" data-testid="chat-badge">
            {chat.unread > 9 ? "9+" : chat.unread}
          </span>
        )}
      </button>
      {chat.open && <Sheet chat={chat} />}
    </>
  );
}

function Sheet({ chat }: { chat: Chat }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const { text, setText } = chat;
  const resting = useResting(chat.until);
  const close = () => chat.setOpen(false);
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    // The sheet itself, not its first control: no switch looks chosen, and no keyboard opens.
    dialog?.focus();
    // Phones shrink only the visual viewport for the keyboard: the sheet moves up above it, so
    // the text box is never under the keys.
    const vv = window.visualViewport;
    if (!dialog || !vv) return;
    const settle = () => {
      const under = document.documentElement.clientHeight - vv.height - vv.offsetTop;
      dialog.style.setProperty("--kb", `${Math.max(0, under)}px`);
      dialog.style.setProperty("--vh", `${vv.height}px`);
    };
    settle();
    vv.addEventListener("resize", settle);
    vv.addEventListener("scroll", settle);
    return () => {
      vv.removeEventListener("resize", settle);
      vv.removeEventListener("scroll", settle);
    };
  }, []);
  // The newest message is at the bottom, in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new message is the trigger
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [chat.log, chat.on]);

  // A quick phrase or an emoji closes a player's sheet, so they see it pop by their name.
  const quick = (said: Said) => {
    chat.say(said);
    if (chat.you !== null) close();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (resting || !text.trim()) return;
    chat.say({ text });
    setText("");
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes the dialog natively; this only adds tap-outside
    <dialog
      ref={ref}
      className="zoom chat"
      tabIndex={-1}
      aria-labelledby="chat-title"
      data-testid="chat"
      // React bubbles `close` to the summary's dialog this one may sit in, which would close too.
      onClose={(e) => {
        e.stopPropagation();
        close();
      }}
      onClick={(e) => e.target === ref.current && close()}
    >
      <div className="sheet">
        <div className="sheet-head">
          <h2 id="chat-title">{t("chat")}</h2>
          <label className="auto">
            <span className="switch">
              <input
                type="checkbox"
                aria-label={t("chat")}
                checked={chat.on}
                onChange={chat.toggle}
              />
            </span>
          </label>
          <button type="button" className="btn" onClick={close}>
            {t("close")}
          </button>
        </div>
        {chat.on ? (
          <>
            <ol ref={list} className="chat-log" data-testid="chat-log">
              {chat.log.map((m) => (
                <li
                  key={m.id}
                  className={`chat-msg${m.from !== null && m.from === chat.you ? " mine" : ""}`}
                >
                  <b className="chat-name">{who(t, m)}</b> {words(t, m)}
                </li>
              ))}
              {!chat.log.length && <li className="chat-msg chat-empty">{t("chatEmpty")}</li>}
            </ol>
            {/* biome-ignore lint/a11y/useSemanticElements: a labelled row of buttons, not a form's fieldset */}
            <div className="chat-row" role="group" aria-label={t("chatPhrases")}>
              {CHAT_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="chat-chip"
                  disabled={resting}
                  onClick={() => quick({ preset })}
                >
                  {t(`chat_${preset}`)}
                </button>
              ))}
            </div>
            {/* biome-ignore lint/a11y/useSemanticElements: a labelled row of buttons, not a form's fieldset */}
            <div className="chat-row" role="group" aria-label={t("chatEmojis")}>
              {EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="chat-chip emoji"
                  disabled={resting}
                  onClick={() => quick({ text: emoji })}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <form className="join-row" onSubmit={submit}>
              <input
                className="name-input"
                value={text}
                maxLength={CHAT_MAX}
                enterKeyHint="send"
                autoComplete="off"
                aria-label={t("chatBox")}
                placeholder={t("chatBox")}
                onChange={(e) => setText(e.target.value)}
              />
              <button type="submit" className="btn primary" disabled={resting || !text.trim()}>
                {t("chatSend")}
              </button>
            </form>
          </>
        ) : (
          <p className="tagline">{t("chatOff")}</p>
        )}
      </div>
    </dialog>
  );
}

interface BubblesProps {
  /** The messages to pop now (Chat.said). */
  said: ChatMsg[];
  /** Where a seat is on screen, if it is; anyone else speaks from the chat button. */
  spot: (seat: number) => At | null;
  /** Drawn in place, inside a modal (the summary), which covers anything outside it. */
  inline?: boolean;
}

/** A speech bubble by each player who just spoke, over everything. Taps go through them. */
export function Bubbles({ said, spot, inline }: BubblesProps) {
  const { t } = useI18n();
  const latest = said.at(-1);
  const all = (
    <>
      {said.map((m) => (
        <Bubble key={m.id} msg={m} spot={spot} />
      ))}
      {/* Not role="status": the table has its own, which tests and readers look up by role. */}
      <span className="sr-only" aria-live="polite">
        {latest && t("chatSaid", { name: who(t, latest), text: words(t, latest) })}
      </span>
    </>
  );
  return inline ? all : createPortal(all, document.body);
}

function Bubble({ msg, spot }: { msg: ChatMsg; spot: (seat: number) => At | null }) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLSpanElement>(null);
  const seat = () => (msg.from === null ? null : spot(msg.from));
  const where = (): At | null => {
    const at = seat();
    if (at) return at;
    const r = document.querySelector("[data-testid=chat-button]")?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, below: true } : null;
  };
  // Where it is first drawn (`follow` moves it from there), and whether it needs its sender's
  // name: it does away from their seat. Found once the seats are on the page, before any paint.
  const [from, setFrom] = useState<(At & { named: boolean }) | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per bubble
  useLayoutEffect(() => {
    const at = where();
    setFrom(at && { ...at, named: seat() === null });
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per bubble, when placed
  useLayoutEffect(() => {
    if (!from) return;
    // The tail stays on its seat; the body slides sideways to stay on screen.
    const settle = (at: At) => {
      const half = (body.current?.offsetWidth ?? 0) / 2 + 8;
      const x = Math.min(Math.max(at.x, half), window.innerWidth - half);
      body.current?.style.setProperty("--shift", `${Math.round(x - at.x)}px`);
    };
    settle(from);
    // The strip scrolls to follow the turn: the bubble stays on its seat.
    return follow<At>(box.current, where, from, settle);
  }, [from]);
  if (!from) return null;
  return (
    <div
      ref={box}
      className={`bubble${from.below ? " below" : ""}`}
      style={{ left: from.x, top: from.y }}
      data-testid="bubble"
      data-from={msg.from ?? ""}
      aria-hidden="true"
    >
      <span ref={body} className="bubble-body">
        {from.named && <b className="bubble-name">{who(t, msg)} </b>}
        {words(t, msg)}
      </span>
    </div>
  );
}
