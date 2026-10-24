import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, Recover } from "./App";
import { I18nProvider } from "./i18n";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <Recover>
        <App />
      </Recover>
    </I18nProvider>
  </StrictMode>,
);
