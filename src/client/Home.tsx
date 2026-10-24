import { type FormEvent, useState } from "react";
import { MAX_PLAYERS, MIN_PLAYERS } from "../engine/game";
import { CODE_LENGTH, isRoomCode } from "../protocol";
import { LOCALES, type Locale, useI18n } from "./i18n";
import { useOnline } from "./useOnline";

const NAMES_KEY = "skyjo:names";
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

/** Last hot-seat names, so a rematch after Quit doesn't mean retyping everyone. */
function loadNames(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(NAMES_KEY) ?? "null");
    const ok =
      Array.isArray(saved) &&
      saved.length >= MIN_PLAYERS &&
      saved.length <= MAX_PLAYERS &&
      saved.every((n) => typeof n === "string");
    return ok ? saved : ["", ""];
  } catch {
    return ["", ""];
  }
}

export function Home({ onStart }: { onStart: (names: string[]) => void }) {
  const { t, locale, setLocale } = useI18n();
  // Blank means "use the default name", so defaults follow the chosen language.
  const [names, setNames] = useState(loadNames);
  const defaultName = (i: number) => t("defaultName", { n: i + 1 });

  const setCount = (count: number) =>
    setNames((prev) => Array.from({ length: count }, (_, i) => prev[i] ?? ""));

  const [code, setCode] = useState("");
  const [iosHint, setIosHint] = useState(shouldShowIosHint);
  const online = useOnline();
  const dismissHint = () => {
    setIosHint(false);
    try {
      localStorage.setItem(IOS_HINT_KEY, "1");
    } catch {
      // Shown again next visit; harmless.
    }
  };
  const [creating, setCreating] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);

  const createRoom = async () => {
    setCreating(true);
    setCreateFailed(false);
    try {
      const res = await fetch("/api/rooms", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      const { code } = (await res.json()) as { code: string };
      window.location.assign(`/r/${code}`);
    } catch {
      setCreateFailed(true);
      setCreating(false);
    }
  };

  const joinRoom = (e: FormEvent) => {
    e.preventDefault();
    if (isRoomCode(code)) window.location.assign(`/r/${code}`);
  };

  const start = (e: FormEvent) => {
    e.preventDefault();
    try {
      localStorage.setItem(NAMES_KEY, JSON.stringify(names));
    } catch {
      // Names just won't be prefilled next time.
    }
    onStart(names.map((name, i) => name.trim() || defaultName(i)));
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
        {createFailed && (
          <p className="tagline" role="alert">
            {t("createFailed")}
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

      <form className="panel" onSubmit={start}>
        <h2>{t("playOnPhone")}</h2>
        <div className="stepper">
          <button
            type="button"
            className="btn"
            aria-label={t("fewerPlayers")}
            disabled={names.length <= MIN_PLAYERS}
            onClick={() => setCount(names.length - 1)}
          >
            −
          </button>
          <output aria-live="polite">{t("playersCount", { n: names.length })}</output>
          <button
            type="button"
            className="btn"
            aria-label={t("morePlayers")}
            disabled={names.length >= MAX_PLAYERS}
            onClick={() => setCount(names.length + 1)}
          >
            +
          </button>
        </div>
        {names.map((name, i) => (
          <input
            // Inputs are positional: a seat's name stays put when the count changes.
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here
            key={i}
            className="name-input"
            value={name}
            placeholder={defaultName(i)}
            name={`name-${i}`}
            maxLength={16}
            enterKeyHint={i < names.length - 1 ? "next" : "go"}
            aria-label={t("playerName", { n: i + 1 })}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || i === names.length - 1) return;
              e.preventDefault();
              const nextInput = e.currentTarget.form?.elements.namedItem(`name-${i + 1}`);
              if (nextInput instanceof HTMLInputElement) nextInput.focus();
            }}
            onChange={(e) => setNames(names.map((n, j) => (j === i ? e.target.value : n)))}
          />
        ))}
        <button type="submit" className="btn primary">
          {t("startGame")}
        </button>
      </form>

      <details className="panel rules">
        <summary>{t("howToPlay")}</summary>
        <ul>
          {(["rules1", "rules2", "rules3", "rules4", "rules5", "rules6"] as const).map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
      </details>
    </main>
  );
}
