import { type ReactNode, useEffect, useState } from "react";
import type { LinkState } from "../lib/session-client.ts";
import { defaultStorage } from "../lib/storage.ts";
import { useBackToClose } from "../state/use-back-to-close.ts";
import type { SessionApi } from "../state/use-session.ts";
import { CodexSection } from "./CodexSection.tsx";
import { ConnectionSection } from "./ConnectionSection.tsx";
import { GoogleSection } from "./GoogleSection.tsx";
import { Icon } from "./Icon.tsx";
import { McpEditor } from "./McpEditor.tsx";
import { MenuRow } from "./MenuRow.tsx";
import { NotificationsSection } from "./NotificationsSection.tsx";
import { GlobalSkills } from "./SkillsSections.tsx";
import { WebToolsSection } from "./WebToolsSection.tsx";

export type GlobalSection =
  | "providers"
  | "web"
  | "mcp"
  | "google"
  | "codex"
  | "skills"
  | "notifications"
  | "about";

interface SectionInfo {
  id: GlobalSection;
  label: string;
  description: string;
}

/** The sections, grouped as the list shows them. */
export const GLOBAL_SECTION_GROUPS: { label: string; sections: SectionInfo[] }[] = [
  {
    label: "Model",
    sections: [
      {
        id: "providers",
        label: "Providers & models",
        description: "The endpoints every agent's models come from",
      },
    ],
  },
  {
    label: "Tools & integrations",
    sections: [
      { id: "web", label: "Web search", description: "web_search and fetch_webpage" },
      { id: "mcp", label: "MCP servers", description: "The shared server list" },
      { id: "google", label: "Google", description: "Gmail, Calendar and Tasks access" },
      { id: "codex", label: "Codex workers", description: "Coding subagents and their provider" },
    ],
  },
  {
    label: "Skills",
    sections: [
      { id: "skills", label: "Global skills", description: "Skills every agent can load" },
    ],
  },
  {
    label: "This device",
    sections: [
      {
        id: "notifications",
        label: "Notifications",
        description: "Push notifications to this browser",
      },
    ],
  },
  {
    label: "App",
    sections: [{ id: "about", label: "About", description: "Version, sign-in and connection" }],
  },
];

const ALL_SECTIONS = GLOBAL_SECTION_GROUPS.flatMap((group) => group.sections);
const LAST_SECTION_KEY = "letta-ui:settings-section";
const WIDE_QUERY = "(min-width: 900px)";

function isSection(value: string | null): value is GlobalSection {
  return ALL_SECTIONS.some((section) => section.id === value);
}

function readLastSection(): GlobalSection | null {
  try {
    const value = defaultStorage()?.getItem(LAST_SECTION_KEY) ?? null;
    return isSection(value) ? value : null;
  } catch {
    return null;
  }
}

function writeLastSection(section: GlobalSection): void {
  try {
    defaultStorage()?.setItem(LAST_SECTION_KEY, section);
  } catch {
    // A convenience only: the list still opens, just on the first section.
  }
}

/** Two panes at the desktop breakpoint, list → detail below it. */
function useWide(): boolean {
  const [wide, setWide] = useState(() => globalThis.matchMedia?.(WIDE_QUERY).matches ?? false);
  useEffect(() => {
    const query = globalThis.matchMedia?.(WIDE_QUERY);
    if (!query) return;
    const onChange = () => setWide(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return wide;
}

interface Props {
  session: SessionApi;
  /** Global skills are listed through one agent's view; any agent will do. */
  agentId: string | null;
  cwd: string | null;
  skillsVersion: number;
  user: { email: string } | null;
  authMode: "cf-access" | "dev-bypass" | "none";
  /** Open straight on a section, e.g. from the Agent tab's Skills link. */
  initialSection?: GlobalSection;
  onClose: () => void;
}

/**
 * Settings shared by every agent, plus this device's. Full screen like the
 * Switcher, opened from the top bar's gear: it has nothing to do with which
 * agent is selected, so it is not a tab beside the agent's own. Per-agent
 * settings are the Agent tab.
 */
export function GlobalSettings({
  session,
  agentId,
  cwd,
  skillsVersion,
  user,
  authMode,
  initialSection,
  onClose,
}: Props) {
  const wide = useWide();
  // A phone opens on the list, unless sent to a section; a desktop always has
  // one open beside the list, so it resumes where it was.
  const [picked, setPicked] = useState<GlobalSection | null>(initialSection ?? null);
  const section: GlobalSection | null = wide
    ? (picked ?? readLastSection() ?? "providers")
    : picked;

  const pick = (next: GlobalSection) => {
    setPicked(next);
    writeLastSection(next);
  };

  // Back steps from a section to the list on a phone, then closes.
  useBackToClose(onClose);
  useBackToClose(() => setPicked(null), !wide && picked !== null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A sheet opened from a section (a provider's fields) handles its own.
      if (document.querySelector(".sheet")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const info = ALL_SECTIONS.find((candidate) => candidate.id === section) ?? null;
  const showList = wide || section === null;

  const content: Record<GlobalSection, () => ReactNode> = {
    providers: () => <ConnectionSection session={session} />,
    web: () => <WebToolsSection />,
    mcp: () => <McpEditor session={session} />,
    google: () => <GoogleSection />,
    codex: () => <CodexSection />,
    skills: () => (
      <GlobalSkills session={session} agentId={agentId} cwd={cwd} version={skillsVersion} />
    ),
    notifications: () => <NotificationsSection />,
    about: () => <AboutSection session={session} user={user} authMode={authMode} />,
  };

  return (
    <div className="switcher settings-screen" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="switcher-panel settings-panel">
        <header className="switcher-bar">
          {!wide && section !== null ? (
            <button
              type="button"
              className="sheet-close"
              onClick={() => setPicked(null)}
              aria-label="Back to settings"
            >
              <Icon name="back" />
            </button>
          ) : null}
          <h2>{!wide && info ? info.label : "Settings"}</h2>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>

        <div className="settings-body">
          {showList ? (
            <nav className="settings-nav" aria-label="Settings sections">
              <p className="settings-nav-note small muted">
                Shared by every agent. An agent's own settings are in its Agent tab.
              </p>
              {GLOBAL_SECTION_GROUPS.map((group) => (
                <section key={group.label}>
                  <h3 className="switcher-group">{group.label}</h3>
                  <ul className="menu-list">
                    {group.sections.map((item) => (
                      <MenuRow
                        key={item.id}
                        title={item.label}
                        description={wide ? undefined : item.description}
                        mark={wide ? "check" : undefined}
                        selected={wide && item.id === section}
                        onClick={() => pick(item.id)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </nav>
          ) : null}

          {section !== null ? (
            <div className="pane settings-content">
              {wide && info ? <h3 className="settings-content-title">{info.label}</h3> : null}
              {content[section]()}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const LINK_LABELS: Record<LinkState, string> = {
  live: "Live",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  resyncing: "Resyncing…",
  offline: "Offline",
  "signed-out": "Signed out",
};

const AUTH_LABELS: Record<Props["authMode"], string> = {
  "cf-access": "Cloudflare Access",
  "dev-bypass": "Developer bypass (not authenticated)",
  none: "None configured",
};

function AboutSection({
  session,
  user,
  authMode,
}: {
  session: SessionApi;
  user: Props["user"];
  authMode: Props["authMode"];
}) {
  const info = session.appServerInfo;
  const rows: [string, ReactNode][] = [
    ["Signed in as", user?.email ?? "—"],
    ["Sign-in", AUTH_LABELS[authMode]],
    ["Connection", LINK_LABELS[session.link]],
    ["letta-code", info ? `v${info.letta_code_version}` : "—"],
    ["Backend", info?.backend ?? "—"],
  ];
  return (
    <ul className="list">
      {rows.map(([label, value]) => (
        <li key={label} className="row-between pad">
          <span className="muted">{label}</span>
          <span>{value}</span>
        </li>
      ))}
    </ul>
  );
}
