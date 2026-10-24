import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, Recover } from "./App";
import { I18nProvider } from "./i18n";
import { Online } from "./Online";
import "./styles.css";

/** Share links look like /r/ABCDE; anything else is the home screen. */
const roomCode = window.location.pathname.match(/^\/r\/([a-z0-9]{5})\/?$/i)?.[1]?.toUpperCase();

// Installable app + offline shell. Production only: in dev it would cache stale modules.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Not fatal: the game works without it, just not offline or as an installed app.
  });
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <Recover>{roomCode ? <Online code={roomCode} /> : <App />}</Recover>
    </I18nProvider>
  </StrictMode>,
);
