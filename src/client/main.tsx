import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, Recover } from "./App";
import { I18nProvider } from "./i18n";
import { Online } from "./Online";
import "./styles.css";

/** Share links look like /r/ABCDE; anything else is the home screen. */
const roomCode = window.location.pathname.match(/^\/r\/([a-z0-9]{5})\/?$/i)?.[1]?.toUpperCase();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <Recover>{roomCode ? <Online code={roomCode} /> : <App />}</Recover>
    </I18nProvider>
  </StrictMode>,
);
