# DuckDuckGo web search as a shared MCP server (nickclyde/duckduckgo-mcp-server).
#
# A long-lived sidecar rather than a stdio command, because agents reach MCP
# through `letta mcp call`, which connects fresh on every call: a stdio server
# would cold-start Python each time and lose its in-process result cache and
# its per-minute rate limiter — the thing that keeps DuckDuckGo from blocking
# us. Pinned, never floated.
FROM python:3.12-slim

ARG DDG_MCP_VERSION
# The [browser] extra brings curl_cffi, which `--fetch-backend auto` falls back
# to when a site blocks the plain client.
RUN pip install --no-cache-dir "duckduckgo-mcp-server[browser]==${DDG_MCP_VERSION}"

# Reached only on the compose network, as http://ddg-mcp:8000/mcp. The
# DNS-rebinding guard stays on, so the Host header must be that name.
EXPOSE 8000
CMD ["duckduckgo-mcp-server", "--transport", "streamable-http", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--allowed-hosts", "ddg-mcp:8000", \
     "--fetch-backend", "auto"]
