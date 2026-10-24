import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import { preloadSounds, recoverAudio, unlockAudio } from "./sound";
import "./styles.css";

// Installable app + offline shell. Production only: in dev it would cache stale modules.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Not fatal: the game works without it, just not offline or as an installed app.
  });
}

// Browsers allow audio only inside a user gesture. pointerdown creates the context early so the
// first sound is decoded in time; it is not an activation on iOS (a touch's pointerdown never is),
// so the unlock itself happens on the events that are: touchend, click and keydown, the same list
// Howler uses. unlockAudio is cheap once the context runs.
for (const gesture of ["pointerdown", "touchend", "click", "keydown"]) {
  document.addEventListener(gesture, unlockAudio, true);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") recoverAudio();
});
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
