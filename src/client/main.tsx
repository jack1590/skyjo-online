import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, Recover } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

createRoot(root).render(
  <StrictMode>
    <Recover>
      <App />
    </Recover>
  </StrictMode>,
);
