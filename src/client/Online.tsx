import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { MAX_PLAYERS } from "../engine/game";
import {
  CHARACTERS,
  type ChatMsg,
  type ClientMsg,
  cutName,
  type ErrorCode,
  type RoomView,
} from "../protocol";
import { Avatar, CharacterPicker } from "./Character";
import { Bubbles, ChatButton, useChat } from "./Chat";
import { type Key, useI18n } from "./i18n";
import { friendlyName } from "./names";
import { Table } from "./Table";
import { useOnline } from "./useOnline";
import { useRoom } from "./useRoom";

const ERRORS: Record<ErrorCode, Key> = {
  "bad-message": "errBadMessage",
  "not-allowed": "errNotAllowed",
  "room-full": "errRoomFull",
  "bad-name": "errBadName",
  "name-taken": "errNameTaken",
  "illegal-move": "errIllegalMove",
  "too-many-public": "errTooManyPublic",
};

const goHome = () => window.location.assign("/");

export function Online({ code }: { code: string }) {
  const { t } = useI18n();
  const { room, status, error, clearError, send, toss, react, chat, waiting, late } = useRoom(code);
  const talk = useChat(room, chat);
  const online = useOnline();

  useEffect(() => {
    if (!error) return;
    const id = setTimeout(clearError, 4_000);
    return () => clearTimeout(id);
  }, [error, clearError]);

  // The host removed you from a public lobby (M24): back to Home, which says so.
  const removed = room?.removed === true;
  useEffect(() => {
    if (removed) window.location.assign("/?removed");
  }, [removed]);

  if (status === "missing" || status === "full") {
    return (
      <main className="home">
        <p>{t(status === "full" ? "roomCrowded" : "roomNotFound", { code })}</p>
        <button type="button" className="btn primary" onClick={goHome}>
          {t("home")}
        </button>
      </main>
    );
  }
  if (!room) {
    return (
      <main className="home">
        <p className="tagline">{online ? t("connecting") : t("offlineRoom")}</p>
        {!online && (
          <button type="button" className="btn primary" onClick={goHome}>
            {t("home")}
          </button>
        )}
      </main>
    );
  }

  // A tap that lands just after the server moved for you on the clock isn't your mistake.
  const lostToClock = error === "illegal-move" && room.you !== null && room.seats[room.you]?.auto;
  const notices = (
    <>
      {/* Also as soon as the phone goes offline, or the server is slow to answer (UX-5). */}
      {(status === "reconnecting" || !online || late) && (
        <div className="toast" role="status">
          {t("reconnecting")}
        </div>
      )}
      {error && !lostToClock && (
        <div className="toast error" role="alert">
          {t(ERRORS[error])}
        </div>
      )}
    </>
  );

  if (!room.game) {
    return (
      <>
        {notices}
        <Lobby room={room} send={send} chat={<ChatButton chat={talk} />} said={talk.said} />
      </>
    );
  }

  return (
    <>
      {notices}
      <Table
        view={room.game}
        seat={room.you}
        lead={room.lead}
        connected={room.seats.map((s) => s.connected)}
        auto={room.seats.map((s) => s.auto)}
        chars={room.seats.map((s) => s.char)}
        wait={room.clocks}
        toss={room.toss}
        onToss={toss}
        reaction={room.reaction}
        onReact={react}
        chat={<ChatButton chat={talk} />}
        said={talk.said}
        waiting={waiting}
        onAction={(action) => send({ t: "act", action })}
        onAuto={(on) => send({ t: "auto", on })}
        onPlayAgain={() => send({ t: "rematch" })}
        onExit={goHome}
      />
    </>
  );
}

interface LobbyProps {
  room: RoomView;
  send: (msg: ClientMsg) => void;
  /** The chat button, and the messages to pop now (M29). */
  chat: ReactNode;
  said: ChatMsg[];
}

function Lobby({ room, send, chat, said }: LobbyProps) {
  const { t } = useI18n();
  // A bubble points at its sender's name in the list (M26's `Seats`).
  const spot = (seat: number) => {
    const row = document.querySelector('[data-testid="seats"]')?.children[seat];
    const r = row?.getBoundingClientRect();
    return r ? { x: r.left + Math.min(r.width / 2, 120), y: r.top + r.height / 2 } : null;
  };
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/r/${room.code}`;
  const chars = room.seats.map((s) => s.char);

  const share = async () => {
    if (navigator.share) {
      // Rejects when the user closes the share sheet; nothing to do.
      await navigator.share({ text: t("invite"), url: link }).catch(() => {});
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // No clipboard (e.g. plain-http self-host): the link is shown below to copy by hand.
    }
  };

  return (
    <main className="home">
      <div className="bar">
        <button type="button" className="btn icon" aria-label={t("quit")} onClick={goHome}>
          ←
        </button>
        {chat}
      </div>
      <p className="tagline">{t("roomCode")}</p>
      <h1 className="room-code" data-testid="room-code">
        {room.code}
      </h1>
      <button type="button" className="btn" onClick={share}>
        {copied ? t("copied") : t("shareLink")}
      </button>
      <p className="tagline link">{link}</p>

      <section className="panel">
        <h2>
          {room.seats.length === 1 ? t("playersOne") : t("playersCount", { n: room.seats.length })}
        </h2>
        <Seats room={room} send={send} />
        {room.you === null ? (
          room.seats.length < MAX_PLAYERS ? (
            <JoinForm send={send} taken={chars} />
          ) : (
            <p className="tagline">{t("roomFull")}</p>
          )
        ) : room.lead ? (
          <>
            <button
              type="button"
              className="btn primary"
              disabled={room.seats.length < 2}
              onClick={() => send({ t: "start" })}
            >
              {t("startGame")}
            </button>
            {room.seats.length < 2 && <p className="tagline">{t("needTwo")}</p>}
          </>
        ) : (
          <p className="tagline">{t("waitingHost")}</p>
        )}
        {/* Everyone sees the rule before the deal; whoever may start may change it (R16). */}
        <label className="option">
          <span>
            {t("knockout")}
            <span className="option-help" id="knockout-help">
              {t("knockoutHelp")}
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              aria-label={t("knockout")}
              aria-describedby="knockout-help"
              checked={room.knockout}
              disabled={!room.lead}
              onChange={(e) => send({ t: "knockout", on: e.target.checked })}
            />
          </span>
        </label>
        {/* Everyone sees whether strangers can find the room; only the host decides (M24). */}
        <label className="option">
          <span>
            {t("publicRoom")}
            <span className="option-help" id="public-help">
              {t("publicRoomHelp")}
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              aria-label={t("publicRoom")}
              aria-describedby="public-help"
              checked={room.public}
              disabled={room.you !== room.host}
              onChange={(e) => send({ t: "public", on: e.target.checked })}
            />
          </span>
        </label>
        {/* Folded away: the lobby is for starting, and most keep the face they joined with. */}
        {room.you !== null && (
          <details className="option-more">
            <summary>{t("changeCharacter")}</summary>
            <CharacterPicker
              value={chars[room.you]}
              taken={chars}
              onPick={(char) => {
                remember(CHAR_KEY, String(char));
                send({ t: "char", char });
              }}
            />
          </details>
        )}
        {/* Last and quiet, away from Start: a mistaken tap made the next seat host (UX-13). */}
        {room.you !== null && (
          <button type="button" className="btn quiet" onClick={() => send({ t: "leave" })}>
            {t("leaveSeat")}
          </button>
        )}
      </section>
      {/* After the list, whose names the bubbles point at. */}
      <Bubbles said={said} spot={spot} />
    </main>
  );
}

/** A row being dragged: where it started, how far it is from there (px), and where it would land. */
interface Drag {
  from: number;
  dy: number;
  to: number;
  /** Let go: the row rests at `to` until the server's view has the new order. */
  dropped: boolean;
}

/** A drag's geometry: row heights at pickup, and the pointer then (page y) and now (client y). */
interface Grip {
  from: number;
  heights: number[];
  startY: number;
  y: number;
}

/** The dragged row's offset now, and the seat it is over: past another row's middle, it takes its place. */
function over({ from, heights, startY, y }: Grip) {
  const dy = y + window.scrollY - startY;
  const tops = heights.map((_, i) => heights.slice(0, i).reduce((a, b) => a + b, 0));
  const mid = tops[from] + heights[from] / 2 + dy;
  const to = heights.filter((h, i) => i !== from && tops[i] + h / 2 < mid).length;
  return { dy, to };
}

/**
 * The seat list. Seat order is turn order (R5), so whoever may lead drags a row by its handle to
 * arrange who plays after whom (M26); the rows between slide to make room. Arrow Up and Down on a
 * focused handle move it one seat.
 */
function Seats({ room, send }: { room: RoomView; send: (msg: ClientMsg) => void }) {
  const { t } = useI18n();
  const list = useRef<HTMLUListElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const grip = useRef<Grip>({ from: 0, heights: [], startY: 0, y: 0 });
  const sortable = room.lead && room.seats.length > 1;

  /** The seat an arrow key moved a row to: its handle gets the focus back, which moving the row can drop. */
  const keyed = useRef<number | null>(null);

  // Any change of who sits where ends a drag: the server's answer to a drop, or someone leaving.
  // So does losing the lead, which takes the handles away mid-drag.
  const names = room.seats.map((s) => s.name).join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `names` and `sortable` are the triggers.
  useEffect(() => {
    setDrag(null);
    if (keyed.current === null) return;
    list.current?.children[keyed.current]?.querySelector<HTMLElement>(".grip")?.focus();
    keyed.current = null;
  }, [names, sortable]);

  const dragging = drag !== null && !drag.dropped;
  useEffect(() => {
    if (!drag?.dropped) return;
    // A refused or lost move: back to the server's order.
    const id = setTimeout(() => setDrag(null), 1_000);
    return () => clearTimeout(id);
  }, [drag]);
  useEffect(() => {
    if (!dragging) return;
    // Held near the screen's edge, the page scrolls: 8 seats are taller than a phone.
    let frame = requestAnimationFrame(function step() {
      const { y } = grip.current;
      const by = y < 60 ? -8 : y > window.innerHeight - 60 ? 8 : 0;
      if (by) {
        window.scrollBy(0, by);
        setDrag((d) => d && { ...d, ...over(grip.current) });
      }
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [dragging]);

  const drop = (name: string) => {
    if (!dragging) return;
    const { from, heights } = grip.current;
    const { to } = over(grip.current);
    if (to === from) return setDrag(null);
    navigator.vibrate?.(10);
    send({ t: "move", name, to });
    const passed = heights.slice(Math.min(from, to), Math.max(from, to) + 1);
    const dy = passed.reduce((a, b) => a + b, 0) - heights[from];
    setDrag({ from, to, dy: to > from ? dy : -dy, dropped: true });
  };

  /** How far row `i` is from its place: the dragged row follows the finger, those it passed step aside. */
  const shift = (i: number) => {
    if (!drag) return 0;
    const { from, to, dy } = drag;
    if (i === from) return dy;
    const own = grip.current.heights[from];
    return from < i && i <= to ? -own : to <= i && i < from ? own : 0;
  };

  return (
    <ul className={drag ? "seats sorting" : "seats"} data-testid="seats" ref={list}>
      {room.seats.map((s, i) => (
        <li
          key={s.name}
          className={[
            !s.connected && "away",
            drag?.from === i && (drag.dropped ? "dropped" : "dragging"),
          ]
            .filter(Boolean)
            .join(" ")}
          style={drag ? { transform: `translateY(${shift(i)}px)` } : undefined}
        >
          <span className="seat-name">
            <Avatar seat={i} name={s.name} char={s.char} />
            {s.name}
          </span>
          <span className="seat-tags">
            {i === room.host && <span className="tag">{t("host")}</span>}
            {i === room.you && <span className="tag">{t("you")}</span>}
            {!s.connected && <span className="tag">{t("offline")}</span>}
            {/* A leader clears ghosts; a public room's host may also remove who is there (M24). */}
            {i !== room.you &&
              (s.connected ? room.public && room.you === room.host : room.lead) && (
                <button
                  type="button"
                  className="btn icon"
                  aria-label={t("removePlayer", { name: s.name })}
                  onClick={() =>
                    (!s.connected || window.confirm(t("confirmRemove", { name: s.name }))) &&
                    send({ t: "kick", seat: i, name: s.name })
                  }
                >
                  ✕
                </button>
              )}
            {sortable && (
              <button
                type="button"
                className="btn icon grip"
                aria-label={t("reorderSeat", { name: s.name })}
                onPointerDown={(e) => {
                  if (e.button !== 0 || !list.current) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const heights = [...list.current.children].map(
                    (li) => li.getBoundingClientRect().height,
                  );
                  grip.current = {
                    from: i,
                    heights,
                    startY: e.clientY + window.scrollY,
                    y: e.clientY,
                  };
                  navigator.vibrate?.(10);
                  setDrag({ from: i, to: i, dy: 0, dropped: false });
                }}
                onPointerMove={(e) => {
                  if (!dragging) return;
                  grip.current.y = e.clientY;
                  setDrag((d) => d && { ...d, ...over(grip.current) });
                }}
                onPointerUp={() => drop(s.name)}
                onPointerCancel={() => setDrag(null)}
                onKeyDown={(e) => {
                  const to = i + (e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0);
                  if (to === i) return;
                  e.preventDefault();
                  if (!room.seats[to]) return;
                  keyed.current = to;
                  send({ t: "move", name: s.name, to });
                }}
              >
                ≡
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

const NAME_KEY = "skyjo:name";
const CHAR_KEY = "skyjo:char";

function recall(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered next time; joining still works.
  }
}

/** The name, with a dice that suggests one, and the character to join as (M32). */
function JoinForm({
  send,
  taken,
}: {
  send: (msg: ClientMsg) => void;
  taken: (number | undefined)[];
}) {
  const { t } = useI18n();
  const [name, setName] = useState(() => recall(NAME_KEY));
  // The one from last time, or any: a first visit still gets a face.
  const [wanted, setWanted] = useState(() => {
    const saved = recall(CHAR_KEY);
    return /^\d+$/.test(saved) && Number(saved) < CHARACTERS
      ? Number(saved)
      : Math.floor(Math.random() * CHARACTERS);
  });
  // Someone sat down with it meanwhile: the next free one, as the server would give.
  const free = (from: number) => {
    let char = from;
    while (taken.includes(char)) char = (char + 1) % CHARACTERS;
    return char;
  };
  const char = free(wanted);

  const join = (e: FormEvent) => {
    e.preventDefault();
    remember(NAME_KEY, name.trim());
    remember(CHAR_KEY, String(char));
    send({ t: "join", name, char });
  };

  return (
    <form className="join" onSubmit={join}>
      <CharacterPicker value={char} taken={taken} onPick={setWanted} />
      <div className="join-row">
        <input
          className="name-input"
          value={name}
          required
          enterKeyHint="go"
          aria-label={t("yourName")}
          placeholder={t("yourName")}
          // Not mid-composition (an IME, a dead key): rewriting the text under it cancels it. The
          // server cuts again.
          onChange={({ target, nativeEvent }) =>
            setName((nativeEvent as InputEvent).isComposing ? target.value : cutName(target.value))
          }
        />
        <button
          type="button"
          className="btn icon"
          aria-label={t("diceName")}
          onClick={() => {
            // A name and the face that goes with it.
            const dice = friendlyName(t);
            setName(dice.name);
            setWanted(dice.char);
          }}
        >
          🎲
        </button>
        <button type="submit" className="btn primary">
          {t("join")}
        </button>
      </div>
    </form>
  );
}
