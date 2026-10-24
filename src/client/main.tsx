import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import { preloadSounds, unlockAudio } from "./sound";
import "./styles.css";

// Installable app + offline shell. Production only: in dev it would cache stale modules.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Not fatal: the game works without it, just not offline or as an installed app.
  });
}

// Browsers allow audio only inside a user gesture. iOS Safari is strict about which events count,
// so listen to all of the reliable ones; unlockAudio is cheap after the first call.
for (const gesture of ["pointerdown", "pointerup", "click", "keydown"]) {
  document.addEventListener(gesture, unlockAudio, true);
}
preloadSounds();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
