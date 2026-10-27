import { Component, type ComponentProps, type ReactNode, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Home } from "./Home";
import { useI18n } from "./i18n";
import { Online } from "./Online";
import { Table } from "./Table";

/** Share links look like /r/ABCDE; anything else is the home screen. */
const roomCode = window.location.pathname.match(/^\/r\/([a-z0-9]{5})\/?$/i)?.[1]?.toUpperCase();

type Harness = Partial<ComponentProps<typeof Table>>;
/**
 * Test-only layout harness: e2e/table.spec.ts injects a table at any game state (2–8 players,
 * last turns, summaries) without playing up to it. A "skyjo:table" event moves it on to the next
 * view at once, so e2e/motion.spec.ts can catch the flights between two views. Nothing a user can
 * reach.
 */
const harness = (window as Window & { __SKYJO_TABLE__?: Harness }).__SKYJO_TABLE__;
const noop = () => undefined;

export function App() {
  const [table, setTable] = useState(harness);
  // A layout effect, so it listens as soon as the table is on the page: a passive one could run
  // after a test's first event, when CI's WebKit takes long to paint (a flake, M20 probe).
  useLayoutEffect(() => {
    if (!harness) return;
    const next = (e: Event) =>
      flushSync(() => setTable((t) => ({ ...t, ...(e as CustomEvent<Harness>).detail })));
    window.addEventListener("skyjo:table", next);
    return () => window.removeEventListener("skyjo:table", next);
  }, []);
  if (table?.view) {
    return (
      <Table
        seat={null}
        lead={false}
        onAction={noop}
        onToss={noop}
        onPlayAgain={noop}
        onExit={noop}
        {...table}
        view={table.view}
      />
    );
  }
  return <Recover>{roomCode ? <Online code={roomCode} /> : <Home />}</Recover>;
}

/** A render crash shows a way out instead of a blank page. */
class Recover extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <Crashed /> : this.props.children;
  }
}

function Crashed() {
  const { t } = useI18n();
  return (
    <main className="home">
      <p>{t("crashed")}</p>
      {/* Reload, not Home: a reload reconnects an online player to their seat. */}
      <button type="button" className="btn primary" onClick={() => window.location.reload()}>
        {t("reload")}
      </button>
    </main>
  );
}
