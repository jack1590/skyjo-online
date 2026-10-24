import { Component, type ComponentProps, type ReactNode } from "react";
import { Home } from "./Home";
import { useI18n } from "./i18n";
import { Online } from "./Online";
import { Table } from "./Table";

/** Share links look like /r/ABCDE; anything else is the home screen. */
const roomCode = window.location.pathname.match(/^\/r\/([a-z0-9]{5})\/?$/i)?.[1]?.toUpperCase();

/**
 * Test-only layout harness: e2e/table.spec.ts injects a table at any game state (2–8 players,
 * last turns, summaries) without playing up to it. Nothing a user can reach.
 */
const harness = (window as Window & { __SKYJO_TABLE__?: Partial<ComponentProps<typeof Table>> })
  .__SKYJO_TABLE__;
const noop = () => {};

export function App() {
  if (harness?.view) {
    return (
      <Table
        seat={null}
        lead={false}
        onAction={noop}
        onPlayAgain={noop}
        onExit={noop}
        {...harness}
        view={harness.view}
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
      <button type="button" className="btn primary" onClick={() => window.location.assign("/")}>
        {t("startOver")}
      </button>
    </main>
  );
}
