# SearXNG, pinned, with our settings baked in (see settings.yml for why they
# are not under /etc/searxng). Serves JSON on :8080 to the BFF only.
ARG SEARXNG_VERSION
FROM searxng/searxng:${SEARXNG_VERSION}
COPY settings.yml /usr/local/searxng/letta-settings.yml
# A private, portless instance: a per-image random secret is enough.
RUN sed -i "s/@BUILD_SECRET@/$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')/" \
      /usr/local/searxng/letta-settings.yml \
    && ! grep -q '@BUILD_SECRET@' /usr/local/searxng/letta-settings.yml
ENV SEARXNG_SETTINGS_PATH=/usr/local/searxng/letta-settings.yml
