import { type FormEvent, useState } from "react";
import { CODE_LENGTH, isRoomCode } from "../protocol";
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

export function Home() {
  const { t, locale, setLocale } = useI18n();
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
