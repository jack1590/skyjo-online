import { type FormEvent, useEffect, useState } from "react";
import { MAX_PLAYERS } from "../engine/game";
import { type ClientMsg, type ErrorCode, NAME_MAX, type RoomView } from "../protocol";
import { type Key, useI18n } from "./i18n";
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
};

const goHome = () => window.location.assign("/");

export function Online({ code }: { code: string }) {
  const { t } = useI18n();
  const { room, status, error, clearError, send } = useRoom(code);
  const online = useOnline();

  useEffect(() => {
    if (!error) return;
    const id = setTimeout(clearError, 4_000);
    return () => clearTimeout(id);
  }, [error, clearError]);

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

  const notices = (
    <>
      {status === "reconnecting" && (
        <div className="toast" role="status">
          {t("reconnecting")}
        </div>
      )}
      {error && (
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
        <Lobby room={room} send={send} />
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
        wait={room.wait}
        onAction={(action) => send({ t: "act", action })}
        onPlayAgain={() => send({ t: "rematch" })}
        onExit={goHome}
      />
    </>
  );
}

function Lobby({ room, send }: { room: RoomView; send: (msg: ClientMsg) => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/r/${room.code}`;

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
        <ul className="seats" data-testid="seats">
          {room.seats.map((s, i) => (
            <li key={s.name} className={s.connected ? undefined : "away"}>
              <span>{s.name}</span>
              <span className="seat-tags">
                {i === room.host && <span className="tag">{t("host")}</span>}
                {i === room.you && <span className="tag">{t("you")}</span>}
                {!s.connected && <span className="tag">{t("offline")}</span>}
                {room.lead && !s.connected && i !== room.you && (
                  <button
                    type="button"
                    className="btn icon"
                    aria-label={t("removePlayer", { name: s.name })}
                    onClick={() => send({ t: "kick", seat: i })}
                  >
                    ✕
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
        {room.you === null ? (
          room.seats.length < MAX_PLAYERS ? (
            <JoinForm send={send} />
          ) : (
            <p className="tagline">{t("roomFull")}</p>
          )
        ) : (
          <button type="button" className="btn" onClick={() => send({ t: "leave" })}>
            {t("leaveSeat")}
          </button>
        )}
        {room.lead && (
          <button
            type="button"
            className="btn primary"
            disabled={room.seats.length < 2}
            onClick={() => send({ t: "start" })}
          >
            {t("startGame")}
          </button>
        )}
        {room.lead && room.seats.length < 2 && <p className="tagline">{t("needTwo")}</p>}
        {!room.lead && room.you !== null && <p className="tagline">{t("waitingHost")}</p>}
      </section>
    </main>
  );
}

const NAME_KEY = "skyjo:name";

function JoinForm({ send }: { send: (msg: ClientMsg) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      return "";
    }
  });

  const join = (e: FormEvent) => {
    e.preventDefault();
    try {
      localStorage.setItem(NAME_KEY, name.trim());
    } catch {
      // Not remembered next time; joining still works.
    }
    send({ t: "join", name });
  };

  return (
    <form className="join-row" onSubmit={join}>
      <input
        className="name-input"
        value={name}
        maxLength={NAME_MAX}
        required
        enterKeyHint="go"
        aria-label={t("yourName")}
        placeholder={t("yourName")}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" className="btn primary">
        {t("join")}
      </button>
    </form>
  );
}
