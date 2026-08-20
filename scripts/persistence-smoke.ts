/**
 * Acceptance test for the invariant the whole architecture rests on:
 * a browser session disappearing must NOT disturb the app-server.
 *
 * See CLAUDE.md — the app-server cancels in-flight turns, drops queued messages
 * and rejects pending approvals for a connection that closes. Browser sockets
 * close constantly (tab switch, phone sleep), so they must never be the
 * connection the app-server knows about.
 *
 * Usage: bun scripts/persistence-smoke.ts [bffOrigin]
 */

const ORIGIN = process.argv[2] ?? "http://127.0.0.1:8090";
const WS_ORIGIN = ORIGIN.replace(/^http/, "ws");

let failures = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

async function login(): Promise<string> {
  const response = await fetch(`${ORIGIN}/auth/dev-login`, { redirect: "manual" });
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error(`No session cookie (status ${response.status})`);
  return cookie.split(";")[0]!;
}

async function status(): Promise<Record<string, any>> {
  return (await fetch(`${ORIGIN}/api/status`)).json() as Promise<Record<string, any>>;
}

interface Session {
  socket: WebSocket;
  frames: any[];
  waitFor: (predicate: (frame: any) => boolean, timeoutMs?: number) => Promise<any>;
  send: (command: Record<string, unknown>) => void;
  close: () => void;
}

function openSession(cookie: string): Promise<Session> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${WS_ORIGIN}/ws`, { headers: { cookie } } as any);
    const frames: any[] = [];
    const waiters: { predicate: (f: any) => boolean; resolve: (f: any) => void }[] = [];

    socket.addEventListener("message", (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data));
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i]!.predicate(frame)) {
          waiters.splice(i, 1)[0]!.resolve(frame);
        }
      }
    });

    socket.addEventListener("error", reject);
    socket.addEventListener("open", () =>
      resolve({
        socket,
        frames,
        waitFor: (predicate, timeoutMs = 10_000) =>
          new Promise((res, rej) => {
            const existing = frames.find(predicate);
            if (existing) return res(existing);
            const timer = setTimeout(
              () => rej(new Error(`Timed out; saw: ${frames.map((f) => f.type).join(", ")}`)),
              timeoutMs,
            );
            waiters.push({
              predicate,
              resolve: (f) => {
                clearTimeout(timer);
                res(f);
              },
            });
          }),
        send: (command) => socket.send(JSON.stringify(command)),
        close: () => socket.close(),
      }),
    );
  });
}

const cookie = await login();
console.log(`Authenticated: ${cookie.split("=")[0]}`);

// ── 1. A session can drive the app-server ────────────────────────────────────
section("1. Session routing");
const a = await openSession(cookie);
const hello = await a.waitFor((f) => f.type === "__bff_hello");
check("receives __bff_hello", Boolean(hello.session_id));
check("upstream is connected", hello.upstream === "connected", hello.upstream);

a.send({ type: "agent_list", request_id: "web-1", query: { limit: 5 } });
const agentList = await a.waitFor((f) => f.type === "agent_list_response");
check("agent_list round trip succeeds", agentList.success === true, agentList);
check(
  "request_id is translated back to the browser's own id",
  agentList.request_id === "web-1",
  agentList.request_id,
);

// ── 2. Two sessions are isolated in request space ────────────────────────────
section("2. Concurrent sessions");
const b = await openSession(cookie);
await b.waitFor((f) => f.type === "__bff_hello");

// Both use the same client-side id; each must get its own response back.
a.send({ type: "agent_list", request_id: "dup", query: { limit: 1 } });
b.send({ type: "conversation_list", request_id: "dup", query: { limit: 1 } });
const aResp = await a.waitFor((f) => f.request_id === "dup" && f.type === "agent_list_response");
const bResp = await b.waitFor((f) => f.request_id === "dup" && f.type === "conversation_list_response");
check("session A got its own response despite a colliding id", aResp.type === "agent_list_response");
check("session B got its own response despite a colliding id", bResp.type === "conversation_list_response");
check(
  "responses did not leak across sessions",
  !a.frames.some((f) => f.type === "conversation_list_response") &&
    !b.frames.some((f) => f.type === "agent_list_response"),
);

const before = await status();
check("two sessions registered", before.sessions === 2, before.sessions);

// ── 3. The command allowlist holds ───────────────────────────────────────────
section("3. Command allowlist");
a.send({ type: "terminal_spawn", request_id: "web-term", terminal_id: "t1", cols: 80, rows: 24 });
const denied = await a.waitFor((f) => f.type === "__bff_error" && f.request_id === "web-term");
check("terminal_spawn is refused from a browser session", denied.message.includes("not permitted"), denied);

// ── 4. THE INVARIANT: dropping browser sockets must not touch upstream ───────
section("4. Browser disconnect does not reach the app-server");
const generationBefore = before.upstream.generation;
a.close();
b.close();
await new Promise((r) => setTimeout(r, 600));

const after = await status();
check("all sessions were unregistered", after.sessions === 0, after.sessions);
check("upstream is still connected", after.upstream.state === "connected", after.upstream.state);
check(
  "upstream socket was never re-established",
  after.upstream.generation === generationBefore && after.upstream.generation === 1,
  { before: generationBefore, after: after.upstream.generation },
);

// ── 5. Resume replays exactly what was missed ────────────────────────────────
section("5. Session resume");
const c = await openSession(cookie);
const helloC = await c.waitFor((f) => f.type === "__bff_hello");
const seqAtReconnect = helloC.latest_seq;

c.send({ type: "__bff_resume", from_seq: seqAtReconnect, scopes: [] });
const resumed = await c.waitFor((f) => f.type === "__bff_resume_result");
check("resume from the live head needs no resync", resumed.resync_required === false, resumed);
check("resume from the live head replays nothing", resumed.replayed === 0, resumed);

// The buffer has not wrapped in this short run, so a cursor at the very
// beginning must be served by replay rather than forcing a resync.
c.send({ type: "__bff_resume", from_seq: 0, scopes: [] });
const stale = await c.waitFor(
  (f) => f.type === "__bff_resume_result" && f.from_seq === 0,
);
check("an unwrapped buffer serves an old cursor without a resync", stale.resync_required === false, stale);
check(
  "replay covers every buffered frame",
  stale.replayed === stale.latest_seq,
  { replayed: stale.replayed, latest_seq: stale.latest_seq },
);

const ahead = 999_999;
c.send({ type: "__bff_resume", from_seq: ahead, scopes: [] });
const impossible = await c.waitFor(
  (f) => f.type === "__bff_resume_result" && f.from_seq === ahead,
);
check(
  "a cursor ahead of the buffer forces a resync",
  impossible.resync_required === true,
  impossible,
);

c.close();

// ── 6. Unauthenticated access is refused ─────────────────────────────────────
section("6. Authentication");
const anon = await fetch(`${ORIGIN}/ws`, {
  headers: { connection: "Upgrade", upgrade: "websocket" },
});
check("unauthenticated /ws upgrade is rejected", anon.status === 401, anon.status);

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
