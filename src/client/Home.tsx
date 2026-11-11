import { type FormEvent, useEffect, useState } from "react";
import { MAX_PLAYERS } from "../engine/game";
import { CODE_LENGTH, isRoomCode, type PublicRoom } from "../protocol";
import { LOCALES, type Locale, useI18n } from "./i18n";
import { useOnline } from "./useOnline";

const IOS_HINT_KEY = "skyjo:ios-hint-dismissed";

/** iOS Safari has no install prompt, so say how; once dismissed (or installed), never again. */
function shouldShowIosHint(): boolean {
  try {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const installed =
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;
    return ios && !installed && !localStorage.getItem(IOS_HINT_KEY);
  } catch {
    return false;
  }
}

/** Home asks for the public list this often while its page is visible... */
const POLL_MS = 15_000;
/** ...and this many times (5 min): each one is a Worker request, and a forgotten tab must stop. */
const POLLS = 20;

/**
 * The public rooms (M24), null until the first answer, and a way to ask again. Polls only while
 * the page is visible; coming back to it, or asking again, starts over.
 */
function usePublicRooms(online: boolean) {
  const [rooms, setRooms] = useState<PublicRoom[] | null>(null);
  const [asked, setAsked] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked` restarts the polling
  useEffect(() => {
    if (!online) return;
    let left = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (left-- <= 0 || document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/public");
        if (res.ok) setRooms((await res.json()) as PublicRoom[]);
      } catch {
        // Offline or limited: the last list stays, and the next poll tries again.
      }
      timer = setTimeout(load, POLL_MS);
    };
    const start = () => {
      clearTimeout(timer);
      left = POLLS;
      void load();
    };
    start();
    document.addEventListener("visibilitychange", start);
    return () => {
      left = 0;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", start);
    };
  }, [online, asked]);
  return [rooms, () => setAsked((n) => n + 1)] as const;
}

export function Home() {
  const { t, locale, setLocale } = useI18n();
  const [code, setCode] = useState("");
  const [iosHint, setIosHint] = useState(shouldShowIosHint);
  const online = useOnline();
  const [rooms, refresh] = usePublicRooms(online);
  const dismissHint = () => {
    setIosHint(false);
    try {
      localStorage.setItem(IOS_HINT_KEY, "1");
    } catch {
      // Shown again next visit; harmless.
    }
  };
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<"createFailed" | "tooManyRequests" | null>(null);

  const createRoom = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/rooms", { method: "POST" });
      if (res.ok) {
        const { code } = (await res.json()) as { code: string };
        window.location.assign(`/r/${code}`);
        return;
      }
      // 429: this network hit the server's per-IP limit, not a connection problem.
      setCreateError(res.status === 429 ? "tooManyRequests" : "createFailed");
    } catch {
      setCreateError("createFailed");
    }
    setCreating(false);
  };

  const joinRoom = (e: FormEvent) => {
    e.preventDefault();
    if (isRoomCode(code)) window.location.assign(`/r/${code}`);
  };

  return (
    <main className="home">
      <select
        className="lang"
        aria-label={t("language")}
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
      >
        {Object.entries(LOCALES).map(([code, { name }]) => (
          <option key={code} value={code}>
            {name}
          </option>
        ))}
      </select>
      <h1 className="logo">
        Skyjo <span>Online</span>
      </h1>
      <p className="tagline">{t("tagline")}</p>

      {iosHint && (
        <div className="panel hint" role="note">
          <p>{t("installHint")}</p>
          <button type="button" className="btn" onClick={dismissHint}>
            {t("gotIt")}
          </button>
        </div>
      )}

      <section className="panel">
        <h2>{t("playOnline")}</h2>
        {!online && (
          <p className="tagline" role="status">
            {t("offlineHome")}
          </p>
        )}
        <button
          type="button"
          className="btn primary"
          disabled={creating || !online}
          onClick={createRoom}
        >
          {t("createRoom")}
        </button>
        {createError && (
          <p className="tagline" role="alert">
            {t(createError)}
          </p>
        )}
        <form className="join-row" onSubmit={joinRoom}>
          <input
            className="name-input code-input"
            value={code}
            maxLength={CODE_LENGTH}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="go"
            aria-label={t("roomCode")}
            placeholder={t("roomCode")}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          />
          <button type="submit" className="btn" disabled={!isRoomCode(code)}>
            {t("join")}
          </button>
        </form>
      </section>

      {online && (
        <section className="panel">
          <div className="panel-head">
            <h2>{t("publicRooms")}</h2>
            <button type="button" className="btn icon" aria-label={t("refresh")} onClick={refresh}>
              ↻
            </button>
          </div>
          {rooms?.length === 0 && <p className="tagline">{t("publicRoomsNone")}</p>}
          <ul className="seats" data-testid="public-rooms">
            {rooms?.map((r) => (
              <li key={r.code}>
                <a className="public-room" href={`/r/${r.code}`}>
                  <span>{t("publicRoomOf", { name: r.host })}</span>
                  <span className="seat-tags">
                    {r.knockout && <span className="tag">{t("knockoutTag")}</span>}
                    <span>
                      {r.players}/{MAX_PLAYERS}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="panel rules">
        <summary>{t("howToPlay")}</summary>
        <ul>
          {(
            [
              "rules1",
              "rules2",
              "rules3",
              "rules4",
              "rules5",
              "rules6",
              "rules7",
              "rules8",
            ] as const
          ).map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
      </details>
      <a className="version" href="https://github.com/jack1590/skyjo-online/releases">
        v{__APP_VERSION__} · {t("whatsNew")}
      </a>
    </main>
  );
}
