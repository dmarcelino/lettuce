import { useEffect, useMemo, useState } from "react";
import { AgentEditor } from "./components/AgentEditor.tsx";
import { ApprovalSheet } from "./components/ApprovalSheet.tsx";
import { AuthPill } from "./components/AuthPill.tsx";
import { Composer } from "./components/Composer.tsx";
import { Icon } from "./components/Icon.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { ModelPicker } from "./components/ModelPicker.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { applyFavicon } from "./lib/favicon.ts";
import { type FilterGroup, filterEntries } from "./lib/messages.ts";
import type { ConnectionState, RuntimeScope } from "./lib/protocol.ts";
import type { LinkState } from "./lib/session-client.ts";
import { useAgents } from "./state/use-agents.ts";
import { useConversation } from "./state/use-conversation.ts";
import { useSession } from "./state/use-session.ts";
import { FilesTab } from "./tabs/FilesTab.tsx";
import { MemoryTab } from "./tabs/MemoryTab.tsx";
import { SettingsTab } from "./tabs/SettingsTab.tsx";
import { TasksTab } from "./tabs/TasksTab.tsx";

interface Status {
  authenticated: boolean;
  auth_mode: "cf-access" | "dev-bypass" | "none";
  user: { email: string; name: string } | null;
  upstream: { state: ConnectionState; info: unknown };
}

const TABS = ["Chat", "Files", "Tasks", "Memory", "Settings"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    void fetch("/api/status")
      .then((response) => response.json() as Promise<Status>)
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  if (status === null) {
    return (
      <main className="shell center">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (!status.authenticated) return <SignIn status={status} />;
  return <Workspace status={status} />;
}

function SignIn({ status }: { status: Status }) {
  return (
    <main className="shell center">
      <h1>Letta</h1>
      {status.auth_mode === "dev-bypass" ? (
        <>
          <p className="warning">
            Developer sign-in is enabled. This does <strong>not</strong> authenticate anyone — any
            visitor becomes the configured user. Unset <code>DEV_BYPASS_EMAIL</code> in
            <code>docker/.env</code> once real sign-in is configured.
          </p>
          <a className="button" href="/auth/login">
            Continue without signing in
          </a>
        </>
      ) : status.auth_mode === "cf-access" ? (
        <p className="muted">
          Not signed in. This instance is reached through Cloudflare Access — if you're seeing this
          on the tunnel, try reloading; direct access without Access is not supported.
        </p>
      ) : (
        <p className="warning">
          Nothing is configured to sign anyone in. This instance is running in local mode with no{" "}
          <code>DEV_BYPASS_EMAIL</code> set — add one to <code>docker/.env</code> and restart, or
          switch to cloudflared mode for real sign-in. See <code>docker/README.md</code>.
        </p>
      )}
    </main>
  );
}

function Workspace({ status }: { status: Status }) {
  const session = useSession(true);
  const agents = useAgents(session);
  // /clear creates a new conversation server-side instead of clearing this one,
  // so the UI has to follow it there or it sits on a conversation the runtime
  // has already moved off.
  const conversation = useConversation(session, agents.agentId, agents.conversationId, () => {
    void agents.adoptNewConversation();
  });

  const [tab, setTab] = useState<Tab>("Chat");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showModels, setShowModels] = useState(false);
  /** `null` = closed; `{ id: null }` = create; `{ id }` = edit that agent. */
  const [agentEditor, setAgentEditor] = useState<{ id: string | null } | null>(null);
  const [filters, setFilters] = useState<Set<FilterGroup>>(new Set());

  const scope: RuntimeScope | null =
    agents.agentId && agents.conversationId
      ? { agent_id: agents.agentId, conversation_id: agents.conversationId }
      : null;

  const visibleEntries = useMemo(
    () => filterEntries(conversation.entries, filters),
    [conversation.entries, filters],
  );

  const title =
    agents.conversations.find((c) => c.id === agents.conversationId)?.summary ?? "Letta";

  const toggleFilter = (group: FilterGroup) => {
    setFilters((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const bypass = status.auth_mode === "dev-bypass";

  // The tab icon reports the link state, which matters most when this tab is
  // backgrounded on a phone — precisely when the socket tends to drop.
  useEffect(() => {
    applyFavicon(session.link);
  }, [session.link]);

  return (
    <div className="app">
      <Sidebar
        agents={agents}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNewAgent={() => setAgentEditor({ id: null })}
        onEditAgent={(id) => setAgentEditor({ id })}
      />

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="icon-button ghost"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label="Conversations"
          >
            <Icon name="menu" />
          </button>
          <h1 className="title">{title}</h1>
          {bypass ? <AuthPill email={status.user?.email} /> : null}
          <LinkPill link={session.link} />
        </header>

        <nav className="tabs">
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              className={name === tab ? "active" : ""}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </nav>

        {tab === "Chat" ? (
          <>
            {conversation.error ? <p className="warning small">{conversation.error}</p> : null}

            <MessageList
              entries={visibleEntries}
              processing={conversation.processing}
              cwd={conversation.cwd}
            />

            {conversation.queue.length > 0 ? (
              <div className="queue">
                <span className="tag">Queued</span>
                {conversation.queue.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="queued"
                    title="Remove from queue"
                    onClick={() => conversation.removeQueued(item.id)}
                    aria-label={`Remove queued message: ${item.content.slice(0, 40)}`}
                  >
                    {item.content.slice(0, 40)}
                    <Icon name="close" />
                  </button>
                ))}
              </div>
            ) : null}

            <Composer
              disabled={!scope || !session.ready}
              processing={conversation.processing}
              onSend={(text) => {
                void conversation.sendMessage(text);
                // Name the conversation after the first thing said in it. No-op
                // once it has a title, so a manual rename always wins.
                if (agents.conversationId) {
                  agents.autoTitleConversation(agents.conversationId, text);
                }
              }}
              onAbort={() => void conversation.abort()}
              stopping={conversation.stopping}
              filters={filters}
              onToggleFilter={toggleFilter}
              onClearFilters={() => setFilters(new Set())}
              permissionMode={conversation.permissionMode}
              onPermissionMode={conversation.setPermissionMode}
              commands={conversation.commands}
              onRunCommand={(id, args) => conversation.runCommand(id, args)}
              onOpenModels={() => setShowModels(true)}
              modelsDisabled={!scope}
            />
          </>
        ) : tab === "Files" ? (
          <FilesTab session={session} cwd={conversation.cwd} agentId={agents.agentId} />
        ) : tab === "Tasks" ? (
          <TasksTab
            session={session}
            agentId={agents.agentId}
            conversationId={agents.conversationId}
          />
        ) : tab === "Memory" ? (
          <MemoryTab session={session} agentId={agents.agentId} />
        ) : (
          <SettingsTab
            session={session}
            agentId={agents.agentId}
            skills={conversation.skills}
            skillsStale={conversation.skillsStale}
          />
        )}
      </div>

      {conversation.approvals.length > 0 ? (
        <ApprovalSheet
          // Keyed by request id so a fresh approval always mounts fresh —
          // without this, answering one question mid-form and moving straight
          // to the next queued approval reused the same component instance,
          // carrying over its denying/reason/selection state.
          key={conversation.approvals[0]!.requestId}
          approval={conversation.approvals[0]!}
          onRespond={conversation.respondToApproval}
          onAnswerQuestions={conversation.answerQuestions}
        />
      ) : null}

      {showModels ? (
        <ModelPicker session={session} scope={scope} onClose={() => setShowModels(false)} />
      ) : null}

      {agentEditor ? (
        <AgentEditor
          session={session}
          agents={agents}
          agentId={agentEditor.id}
          onClose={() => setAgentEditor(null)}
        />
      ) : null}
    </div>
  );
}

function LinkPill({ link }: { link: LinkState }) {
  const map: Record<LinkState, { label: string; tone: string }> = {
    live: { label: "Live", tone: "ok" },
    connecting: { label: "Connecting…", tone: "warn" },
    reconnecting: { label: "Reconnecting…", tone: "warn" },
    resyncing: { label: "Resyncing…", tone: "warn" },
    offline: { label: "Offline", tone: "bad" },
  };
  const { label, tone } = map[link];
  return <span className={`pill ${tone}`}>{label}</span>;
}
