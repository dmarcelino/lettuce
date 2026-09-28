# Gmail, Calendar and Tasks for agents (taylorwilsdon/google_workspace_mcp),
# under a supervisor that runs it only as Settings → Google says.
#
# A sidecar, not a process in the app-server, because the app-server is where
# agent shells run and they can write anything there: the OAuth token and the
# permission levels have to live where no agent can reach them. See
# supervisor.py and bff/src/google/.
#
# Pinned, never floated: the BFF mirrors this version's level → scope table
# (bff/src/google/policy.ts) and its credential file format.
FROM python:3.12-slim

ARG WORKSPACE_MCP_VERSION
RUN pip install --no-cache-dir "workspace-mcp==${WORKSPACE_MCP_VERSION}"

COPY supervisor.py /usr/local/lib/google-mcp/supervisor.py

# Reached only on the compose network, as http://google-mcp:8000/mcp.
EXPOSE 8000
CMD ["python", "/usr/local/lib/google-mcp/supervisor.py"]
