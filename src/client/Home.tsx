import { type FormEvent, useState } from "react";
import { MAX_PLAYERS, MIN_PLAYERS } from "../engine/game";
import { LOCALES, type Locale, useI18n } from "./i18n";

export function Home({ onStart }: { onStart: (names: string[]) => void }) {
  const { t, locale, setLocale } = useI18n();
  // Blank means "use the default name", so defaults follow the chosen language.
  const [names, setNames] = useState(["", ""]);
  const defaultName = (i: number) => t("defaultName", { n: i + 1 });

  const setCount = (count: number) =>
    setNames((prev) => Array.from({ length: count }, (_, i) => prev[i] ?? ""));

  const start = (e: FormEvent) => {
    e.preventDefault();
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
