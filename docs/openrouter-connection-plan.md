# Plan: endpoint and model picking for providers served by the app-server's own connection

Status: proposed, 2026-10-27. Rides the `openrouter` branch with the change it amends.

## Context

The first half of this branch fixed adding OpenRouter, which saved and then served nothing. It moved the
eight hosts whose model ids hold a `/` (OpenRouter, Together AI, Fireworks, Hugging Face, NVIDIA NIM,
Vercel AI Gateway, Baseten, Groq) onto the app-server's own connection (`connect_provider`). The reason:
letta-code's provider mod refuses any such id
([upstream-notes](upstream-notes.md#provider-mod-slash-ids)).

The operator's container test found that the change cost more than the one-connection limit it stated:

1. **No endpoint field.** The sheet sends only the key. Upstream's `connect_provider` accepts a `baseUrl`
   field for any provider and stores it with the connection (`connect-provider-service.ts`,
   `resolveProviderConnectionFields`). We just never send it.
2. **No model picking.** The connection serves its whole catalog, and upstream has no per-connection
   model filter.
3. **The count is not OpenRouter's live list.** The connection serves pi-ai's catalog bundled with
   letta-code (464 entries at 0.34.21; the row shows 398, cause not yet checked). It is a snapshot from
   the release: newer models arrive only with a letta-code upgrade.

Decided by the operator: **keep one connection per host**, restore the endpoint field and model picking,
and show the count as **"N of M selected"**. The live list (3) stays out of scope. It would need a
translating proxy in the BFF, which was weighed and declined for now.

## Approach

### 1. Endpoint field
- `parseProviderBody` (`bff/src/providers/registry.ts`): a connection type also takes `baseUrl`,
  normalised with the existing `normalizeBaseUrl` and defaulting to the type's catalog URL.
- `POST /api/providers` (`routes.ts`) passes it as `fields.baseUrl` to `connect`. In `index.ts`,
  `connect(providerId, fields)` takes the fields object, not just the key.
- `ProviderFormSheet.tsx` shows Base URL for a connection type again, prefilled. Test probes that URL.
- The `Connected · <url>` meta line on the row already renders `connected.base_url` once upstream
  stores one.

### 2. Model allowlist, enforced in the BFF
- **Store**: `ModelCapsStore` (`store.ts`) gains `connectionModels: Record<prefix, string[]>`. It is a
  separate key from `endpoints`, because `buildProviderModGroups` renders every `endpoints` entry as a
  mod registration, and a connection must never become one. No entry means everything served is shown,
  which is today's behaviour. `removeProvider`/disconnect clears it.
- **Filter**: a pure `filterServedModels(frame, allowlists)` in `bff/src/providers/`, applied in
  `index.ts` `onFrame` **after** `providerSight.observe(frame)` and **before**
  `registry.handleUpstreamFrame(frame)`. The BFF's own mirror keeps the full list (the render and the
  409 checks need it). Browsers get `list_models_response` with `entries` and `available_handles`
  trimmed to the allowlist for that prefix.
  - Only that frame type is touched. Upstream stays unpatched, and this is the same kind of frame
    filtering the BFF already does by agent id.
  - It is presentation, not enforcement: an agent already set to a hidden model keeps working. Say so
    in the docs.
- **Routes**:
  - `PUT /api/providers/connection-models {prefix, models}` stores the allowlist and triggers a
    `list_models` refresh, so open pickers update.
  - `GET /api/providers` adds `connections: { [prefix]: { selected: string[] } }`.

### 3. The sheet and the row (UI: mockups first)
- **Add, for a connection type**: Type, the short explanation, Base URL, API key, then **Connect**. On
  success the sheet stays open and turns into the model picker. It lists what the connection now
  serves (`list_models` for that prefix, from `use-models`), all ticked, with Save. The picker has to
  come after Connect, because the served list exists only once connected.
- **Edit on a connection row whose provider id matches a connection type** opens the same sheet in edit
  mode: Base URL, key (blank keeps the stored one), and the picker with the stored allowlist ticked.
  Other app-server rows keep `ConnectionSheet`.
- **Row count**: `Models (N of M)` when an allowlist exists, `Models (M)` otherwise. M is the served
  count from the BFF's mirror (unfiltered), N is the allowlist entries still served.
- The picker gets a filter box, since 400 rows is unusable without one. This overlaps follow-up fix 5,
  and the same component serves both.
- Mock at 390 and 1280 and get **Approve?** before any `web/` code (`lettuce-ui-verification`).
  Surfaces: the add flow before and after Connect, the edit sheet, and the row with "N of M".

### 4. The 398 vs 464 gap
Before writing the docs, find which upstream filter drops 66 catalog entries from `available_handles`
(for example, models without tool calling, or image-only output). Document the rule, or link it.

## Tests (each written failing first)
- `parseProviderBody`: a connection type keeps a typed `baseUrl` and defaults to the catalog one.
- `POST /api/providers`: `connect` receives `{apiKey, baseUrl}`.
- `filterServedModels`:
  - It trims `entries` and `available_handles` for an allowlisted prefix only.
  - It leaves other prefixes and other frame types untouched.
  - With no allowlist it is the identity.
  - It never mutates the frame the mirror saw.
- `ModelCapsStore`: `connectionModels` round-trips through the file, never shows up in `endpoints()`,
  and never reaches `buildProviderModGroups`.
- `PUT /api/providers/connection-models`: it refuses a prefix with no live connection and a malformed
  body.
- `GET /api/providers`: it reports `selected` per connection.

## Docs
- `docs/CONFIGURATION.md`, "Providers that name models `vendor/model`": the endpoint field, the picker
  (presentation only), the bundled-catalog limit with how to get newer models (upgrade letta-code), and
  the outcome of item 4.
- `CHANGELOG.md`: fold into this branch's existing `### Changed` entry.
- The PR's "Why one connection per type" section adds the live-list trade-off and the declined proxy
  alternative.

## Verification
- `bun run verify`.
- Yeager, using the deploy recipe (check the shared `:local` images first, because the last deploy
  recreated app-server).
- Probes:
  - Connect OpenRouter with a non-default base URL: the row's meta line shows it.
  - Untick models: the agent model picker and the row show only the selection, with "N of M".
  - An agent on an unticked model still answers.
  - Disconnect clears the allowlist.
  - Reconnect shows everything.
- Operator click-through, then **Verified?**.

## Out of scope
- The live OpenRouter list (the BFF translating proxy). Revisit if models newer than the installed
  letta-code become a need.
- Follow-up fix 4: flagging agents whose provider is gone.
