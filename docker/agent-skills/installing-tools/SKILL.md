---
name: installing-tools
description: Load this BEFORE installing any command-line tool, binary, package or language toolchain (npm -g, pip, uv, cargo, rustup, go, a downloaded binary, apt) — it says where an install survives container restarts (/opt/agent-tools), which commands land there on their own, and why /usr/local, ~/.local and apt do not last.
---

# Installing tools

You run inside a Docker container that is **recreated** from time to time (updates,
redeploys). A recreate starts again from the image, so anything installed into the
container itself — `/usr/local`, `/usr/bin`, `~/.local`, `~/.cargo`, `~/go` — is gone
afterwards. Only three places survive: your workspace under `/work`, `/root/.letta`, and
**`/opt/agent-tools`**, which is where tools go.

The usual install commands already land there, because the container points each package
manager at it:

| Command | Lands in |
|---|---|
| `npm install -g <pkg>` | `/opt/agent-tools/bin`, `/opt/agent-tools/lib/node_modules` |
| `cargo-binstall <crate>` (rule 4) | `/opt/agent-tools/cargo/bin` |
| `go install <module>@latest` | `/opt/agent-tools/bin` |
| uv's installer, `uv tool install <pkg>`, `uv python install` | `/opt/agent-tools/bin`, `/opt/agent-tools/uv` |

Those directories are on `PATH`, **after** the system ones.

## Rules

1. **Check before installing.** The folder is shared by every agent here, so a tool may
   already be there: `command -v <tool>; ls /opt/agent-tools/bin`.

2. **Use the normal command, unchanged.** Do not add `--prefix`, `--root`, `--user` or
   `sudo`, and do not set `NPM_CONFIG_PREFIX`, `CARGO_HOME`, `GOBIN` or the `UV_*`
   variables yourself: they are already right.

3. **A downloaded binary goes into `/opt/agent-tools/bin`:**

   ```bash
   install -m 0755 ./<tool> /opt/agent-tools/bin/<tool>
   ```

   Never into `/usr/local/bin`: it works now and is gone after the next restart.

4. **Toolchains install into the folder too:**

   ```bash
   # Go -> /opt/agent-tools/go (its bin is already on PATH); then `go install` works
   v=$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1)
   curl -fsSL "https://go.dev/dl/$v.linux-$(dpkg --print-architecture).tar.gz" | tar -xz -C /opt/agent-tools

   # uv, for Python -> /opt/agent-tools/bin/uv
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

   **Rust tools come prebuilt.** There is no C linker here, so `cargo install` and
   `cargo build` fail at the link step. Take the project's release binary (rule 3), or use
   cargo-binstall, which fetches it for you into `/opt/agent-tools/cargo/bin`:

   ```bash
   curl -L --proto '=https' --tlsv1.2 -sSf https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash
   cargo-binstall -y <crate>
   ```

   Go needs no C compiler: `go install` turns cgo off on its own when none is found.

5. **Python: use uv, never pip.** There is no pip here, and the system Python refuses
   package installs. A command-line tool: `uv tool install <pkg>` (or `uvx <pkg>` to run it
   once). A script's dependencies: `uv run --with <pkg> script.py`. A project: `uv venv`
   inside its directory in your workspace. Never `uv pip install --system`.

6. **No apt.** `apt-get install` writes to system directories, so the package is gone after
   the next restart. Prefer a static binary from the project's releases, or the npm,
   cargo-binstall, go or uv route. If nothing else exists, use apt but tell the user it will
   not last.

7. **Leave other agents' tools alone.** Do not remove or upgrade something in
   `/opt/agent-tools` that you did not install unless the user asks.

## Things to tell the user when relevant

- **System commands win.** Because the folder comes last on `PATH`, a tool can never replace
  `node`, `npm`, `git`, `gh` or the commands this container itself runs. If you install
  something whose name clashes, call it by its full path, `/opt/agent-tools/bin/<tool>`.
- **An update can break a tool.** A tool built against one Node.js or system library version
  may stop working after an update changes it. Reinstalling it fixes that.
- **Tools installed elsewhere earlier** (in `/usr/local` or `~/.local`) disappear on the next
  restart; reinstall them with the rules above so they last.
