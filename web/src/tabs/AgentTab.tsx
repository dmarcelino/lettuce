import { useState } from "react";
import { AgentGeneralSection } from "../components/AgentGeneralSection.tsx";
import { AgentToolsSection } from "../components/AgentToolsSection.tsx";
import { ReflectionSection } from "../components/ReflectionSection.tsx";
import { SecretsSection } from "../components/SecretsSection.tsx";
import { AgentSkills } from "../components/SkillsSections.tsx";
import { type FeatureFlags, featureEnabled } from "../lib/features.ts";
import type { AgentsApi } from "../state/use-agents.ts";
import type { SessionApi } from "../state/use-session.ts";

interface Props {
  session: SessionApi;
  agents: AgentsApi;
  /** Reflection settings resolve against the conversation's working directory. */
  conversationId: string | null;
  /** The conversation's working directory — where project-scope skills live. */
  cwd: string | null;
  /** Changes whenever the app-server reports a skill enabled or disabled. */
  skillsVersion: number;
  /** Profile-gated features: with Google, Codex and Claude all off, Tools has nothing to narrow. */
  features?: FeatureFlags;
  /** Settings shared by every agent live behind the top bar's gear. */
  onOpenGlobalSettings: (section?: "skills") => void;
}

export type AgentSection = "general" | "tools" | "secrets" | "reflection" | "skills";

const SECTION_LABELS: Record<AgentSection, string> = {
  general: "General",
  tools: "Tools",
  secrets: "Secrets",
  reflection: "Reflection",
  skills: "Skills",
};

/**
 * Everything that belongs to the selected agent, and nothing else. Settings
 * shared by every agent (providers, web, MCP, Google, Codex, global skills) and
 * this device's notifications are in the global Settings screen — this tab used
 * to hold both, told apart only by a grey line under the chips.
 */
export function AgentTab({
  session,
  agents,
  conversationId,
  cwd,
  skillsVersion,
  features,
  onOpenGlobalSettings,
}: Props) {
  const [section, setSection] = useState<AgentSection>("general");
  const agentId = agents.agentId;
  const agentName = agents.agents.find((agent) => agent.id === agentId)?.name ?? null;

  // Secrets need upstream's agent management; the chip is pointless without it.
  const agentManagement = session.appServerInfo?.capabilities.agent_management ?? false;
  // Per-agent Tools narrows Google, Codex and Claude only — with all three
  // profile tokens off there is nothing left to narrow, so no chip either.
  const anyToolFamily =
    featureEnabled(features, "google") ||
    featureEnabled(features, "codex") ||
    featureEnabled(features, "claude");
  const visibleSections = (Object.keys(SECTION_LABELS) as AgentSection[]).filter(
    (name) => (name !== "secrets" || agentManagement) && (name !== "tools" || anyToolFamily),
  );

  if (!agentId) {
    return (
      <div className="pane">
        <p className="muted pad">No agent selected. Create one, or pick one to see its settings.</p>
      </div>
    );
  }

  return (
    <div className="pane">
      <div className="pane-bar section-tabs">
        {visibleSections.map((name) => (
          <button
            key={name}
            type="button"
            className={section === name ? "active" : undefined}
            onClick={() => setSection(name)}
          >
            {SECTION_LABELS[name]}
          </button>
        ))}
      </div>
      <p className="scope-line small">
        Settings for <strong>{agentName ?? "this agent"}</strong> only.{" "}
        <button type="button" className="link inline" onClick={() => onOpenGlobalSettings()}>
          Settings for every agent
        </button>
      </p>

      {section === "general" ? (
        <AgentGeneralSection key={agentId} session={session} agents={agents} agentId={agentId} />
      ) : null}
      {section === "tools" ? (
        <AgentToolsSection
          agentId={agentId}
          features={features}
          onOpenGlobalSettings={() => onOpenGlobalSettings()}
        />
      ) : null}
      {section === "secrets" ? <SecretsSection session={session} agentId={agentId} /> : null}
      {section === "reflection" ? (
        <ReflectionSection session={session} agentId={agentId} conversationId={conversationId} />
      ) : null}
      {section === "skills" ? (
        <AgentSkills
          session={session}
          agentId={agentId}
          cwd={cwd}
          version={skillsVersion}
          onOpenGlobal={() => onOpenGlobalSettings("skills")}
        />
      ) : null}
    </div>
  );
}
