import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useI18n } from "./i18n";

/** The two looks (M28): Polished casual, the default, and Classic (M27). Chosen per device. */
export type Theme = "casual" | "classic";

const KEY = "skyjo:theme";
/** The browser's bar over the page, in each look's top colour. */
const BAR: Record<Theme, string> = { casual: "#2a1f7a", classic: "#0f2234" };

function stored(): Theme {
  try {
    return localStorage.getItem(KEY) === "classic" ? "classic" : "casual";
  } catch {
    return "casual";
  }
}

let theme = stored();
const listeners = new Set<() => void>();

/**
 * styles.css reads the look from `<html data-theme>`: every screen follows at once, no reload.
 * main.tsx calls it before the first render. index.html's inline script has already set a Classic
 * player's look before the first paint; this also sets the browser bar's colour.
 */
export function applyTheme() {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BAR[theme]);
}

function setTheme(next: Theme) {
  theme = next;
  applyTheme();
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Not remembered next visit; still applies now.
  }
  for (const tell of listeners) tell();
}

const subscribe = (tell: () => void) => {
  listeners.add(tell);
  return () => listeners.delete(tell);
};

/**
 * The look's switch: two small previews, a card in each look, not a bare toggle. It only changes
 * this device: everyone at a table keeps their own.
 */
export function LookPicker() {
  const { t } = useI18n();
  const current = useSyncExternalStore(subscribe, () => theme);
  return (
    <fieldset className="looks" data-testid="looks">
      <legend>{t("look")}</legend>
      {(["casual", "classic"] as const).map((look) => (
        <button
          type="button"
          key={look}
          className="look"
          aria-pressed={current === look}
          onClick={() => setTheme(look)}
        >
          <span className={`look-card ${look}`} aria-hidden="true">
            7
          </span>
          {t(look === "casual" ? "lookCasual" : "lookClassic")}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * The table's way to the looks without leaving the game: the header's round label is the button.
 * A native modal <dialog>, like the zoom: Escape and a tap outside close it.
 */
export function LookButton({ label, short }: { label: string; short?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) ref.current?.showModal();
  }, [open]);
  // Focus goes back to the round label: WebKit doesn't focus a button it taps, so the browser has
  // nothing to return to.
  const closed = () => {
    setOpen(false);
    opener.current?.focus();
  };
  return (
    <>
      <button
        ref={opener}
        type="button"
        className={short ? "round short" : "round"}
        aria-label={`${label}. ${t("look")}`}
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3A3.7 3.7 0 0 0 21 10.700C21 6.400 17 3 12 3zM7 12.500a1.500 1.500 0 1 1 0-3 1.500 1.500 0 0 1 0 3zm3-4a1.500 1.500 0 1 1 0-3 1.500 1.500 0 0 1 0 3zm4 0a1.500 1.500 0 1 1 0-3 1.500 1.500 0 0 1 0 3zm3 4a1.500 1.500 0 1 1 0-3 1.500 1.500 0 0 1 0 3z" />
        </svg>
        {short ?? label}
      </button>
      {open && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes the dialog natively; this only adds tap-outside
        <dialog
          ref={ref}
          className="zoom"
          aria-label={t("look")}
          data-testid="look-sheet"
          onClose={closed}
          onClick={(e) => e.target === ref.current && ref.current.close()}
        >
          <div className="sheet">
            <LookPicker />
            <button type="button" className="btn" onClick={() => ref.current?.close()}>
              {t("close")}
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}
