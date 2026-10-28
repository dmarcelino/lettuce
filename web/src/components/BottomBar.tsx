import { useState } from "react";
import { initialOf, tintFor } from "../lib/agent-tint.ts";
import type { Tab } from "../lib/tabs.ts";
import type { IconName } from "./Icon.tsx";
import { Icon } from "./Icon.tsx";
import { Sheet } from "./Sheet.tsx";

interface Props {
  /** The open agent, for the merged Chat slot's avatar. */
  agentName: string | null;
  agentId: string | null;
  /** Any conversation of this agent is responding. */
  responding: boolean;
  tab: Tab;
  onSelectPane: (tab: Tab) => void;
  /** The switcher: agents and conversations in one full-screen menu. */
  onOpenSwitcher: () => void;
  onOpenSettings: () => void;
  runsEnabled: boolean;
  /** Shown on the More row so a running worker is visible from the bar. */
  runsRunning: number;
}

/**
 * The phone's navigation: one bar under the composer, replacing the top tab
 * strip that used to squeeze six labels onto 390px.
 *
 * The first slot is the one the old composer glyph was trying to be: the open
 * agent's avatar above the Chat pane's icon and label, so "which agent am I
 * talking to" and "go back to the chat" are the same object, one tap apart. The
 * three secondary panes that earn a slot on their own sit next to it, and what is
 * left — the agent's own settings, the coding workers, this device's Settings —
 * is three rows in one sheet.
 */
export function BottomBar({
  agentName,
  agentId,
  responding,
  tab,
  onSelectPane,
  onOpenSwitcher,
  onOpenSettings,
  runsEnabled,
  runsRunning,
}: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const inMore = tab === "Agent" || tab === "Runs";

  const secondary: { tab: Tab; label: string; icon: IconName }[] = [
    { tab: "Files", label: "Files", icon: "folder" },
    { tab: "Tasks", label: "Tasks", icon: "task" },
    { tab: "Tools", label: "Tools", icon: "model" },
  ];

  return (
    <>
      <nav className="bottombar" aria-label="Sections">
        {/* One slot, two targets: the avatar opens agents and conversations, the
            icon and label open the Chat pane. They are stacked, so neither can
            steal the other's tap. */}
        <div className={`bb-chat${tab === "Chat" ? " active" : ""}`}>
          <span className="bb-sizer" aria-hidden="true" />
          <button
            type="button"
            className="bb-switch"
            onClick={onOpenSwitcher}
            aria-label={
              responding
                ? `${agentName ?? "Agent"}: agents and conversations, responding`
                : `${agentName ?? "Agent"}: agents and conversations`
            }
            title="Agents and conversations"
          >
            <span className="bb-avatar" style={{ background: tintFor(agentId ?? "") }}>
              {agentName ? initialOf(agentName) : "?"}
              {responding ? <span className="activity-dot" /> : null}
            </span>
          </button>
          <button
            type="button"
            className="bb-pane"
            onClick={() => onSelectPane("Chat")}
            aria-current={tab === "Chat" ? "page" : undefined}
          >
            <Icon name="chats" />
            Chat
          </button>
        </div>

        {secondary.map((pane) => (
          <button
            key={pane.tab}
            type="button"
            className={tab === pane.tab ? "active" : ""}
            aria-current={tab === pane.tab ? "page" : undefined}
            onClick={() => onSelectPane(pane.tab)}
          >
            <Icon name={pane.icon} />
            {pane.label}
          </button>
        ))}

        <button
          type="button"
          className={inMore ? "active" : ""}
          aria-current={inMore ? "page" : undefined}
          onClick={() => setMoreOpen(true)}
        >
          <Icon name="menu" />
          More
        </button>
      </nav>

      {moreOpen ? (
        <Sheet title="More" onClose={() => setMoreOpen(false)}>
          <p className="menu-section">This agent</p>
          <ul className="menu-list">
            <li>
              <button
                type="button"
                className={`menu-row${tab === "Agent" ? " selected" : ""}`}
                onClick={() => {
                  setMoreOpen(false);
                  onSelectPane("Agent");
                }}
              >
                <Icon name="shield" />
                <span className="menu-row-text">
                  <span className="menu-row-title">Agent</span>
                  <span className="menu-row-desc">
                    {agentName ?? "No agent"} — model, secrets, reflection, skills
                  </span>
                </span>
              </button>
            </li>
            {runsEnabled ? (
              <li>
                <button
                  type="button"
                  className={`menu-row${tab === "Runs" ? " selected" : ""}`}
                  onClick={() => {
                    setMoreOpen(false);
                    onSelectPane("Runs");
                  }}
                >
                  <Icon name="terminal" />
                  <span className="menu-row-text">
                    <span className="menu-row-title">Runs</span>
                    <span className="menu-row-desc">Coding workers</span>
                  </span>
                  {runsRunning > 0 ? (
                    <span className="menu-row-count">{runsRunning} running</span>
                  ) : null}
                </button>
              </li>
            ) : null}
          </ul>

          <p className="menu-section">This device</p>
          <ul className="menu-list">
            <li>
              <button
                type="button"
                className="menu-row"
                onClick={() => {
                  setMoreOpen(false);
                  onOpenSettings();
                }}
              >
                <Icon name="settings" />
                <span className="menu-row-text">
                  <span className="menu-row-title">Settings</span>
                  <span className="menu-row-desc">Providers, search, MCP, Google, workers</span>
                </span>
              </button>
            </li>
          </ul>
        </Sheet>
      ) : null}
    </>
  );
}
