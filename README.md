# pi-model-dock

[中文文档](README.zh-CN.md)

A better way to manage custom providers for Pi and Oh My Pi (OMP).

An interactive wizard (`/provider`) that adds, edits, and deletes custom
LLM providers — no hand-editing of config files required.

## Origin and independent maintenance

pi-model-dock is independently maintained from
[real-wudaoshi/better-custom](https://github.com/real-wudaoshi/better-custom),
which derives from
[ratatulieoi/better-custom](https://github.com/ratatulieoi/better-custom).
It was created with a full Git clone, preserving upstream history, without
using GitHub Fork. The imported baseline is
`84e9daff2b2211af71034187415fcd273721942e` (61 commits).
The original MIT license and the copyright notices for ratatulieoi and
real-wudaoshi are retained unchanged in [LICENSE](LICENSE).

The independent repository is configured as `origin`
(`git@github.com:sheauhuu/pi-model-dock.git`); the source repository is
`upstream` (`https://github.com/real-wudaoshi/better-custom.git`).
The package has not been published to npm. Its version `1.6.0` is inherited
from upstream and does not denote an independent npm release.

The initial import preserved upstream behavior. Independent development now
includes provider display names, capability provenance, exact thinking levels,
and persistent usage limits, with `/provider` as its own command entry. See the
[initial architecture review and proposed priorities](docs/INITIAL_REVIEW.md)
(Chinese) for the original baseline and deferred optimization proposals.

## Features

- **Add from the [models.dev](https://models.dev) catalog** — pick a known API
  site (OpenRouter, DeepSeek, Groq, xAI, ...); base URL, model list, and
  metadata all come from the catalog (one shared official SDK request/cache, with a bundled offline snapshot). No probing at all.
- **Add any custom endpoint** — OpenAI Chat Completions, OpenAI Responses,
  Anthropic Messages, Gemini, or Ollama. Auto-detect probes `/models` and every
  known metadata source, or enter models by hand (one id at a time, with a
  per-model metadata menu pre-filled from the resolved values).
- **Automatic metadata detection** — context window, max output tokens,
  image/video input, reasoning support and levels, learned from the gateway
  itself (LiteLLM `/model/info` + `/model_group/info`, site public catalogs,
  OpenAI `GET /models/{id}`, inline list metadata, Ollama native API) and from
  models.dev. See [How metadata is resolved](#how-metadata-is-resolved).
- **Re-probe to reconcile** — query `/models` again and review everything in
  one tri-state list: new models, metadata updates (`context 128000 ->
  1000000`, `image [+]`, `max-out 8192 -> 32000`), and vanished models flagged
  `unsupported`. `[x]` apply, `[-]` keep stored metadata, `[ ]` remove/skip.
- **Edit everything afterwards** — per-model fields (supported thinking levels, image
  input, context window, max output tokens, headers/endpoint override), bulk
  model delete, provider API flavor, endpoint, rename, delete.
- **Unknown is distinct from unsupported** — missing capability fields are
  filled individually from reference catalogs and local rules, with their
  source shown. Explicit gateway `false` values are retained in automatic
  resolution; fields with no evidence remain unknown.
- **Persistent usage limits** — choose a context preset such as 272K, a catalog
  reference, or a custom token limit. Refresh preserves manual choices; Auto
  restores the detected setting.
- **Developer-role probe** — endpoints that reject the OpenAI `developer` role
  (e.g. Kimi's subscription endpoint) get `compat.supportsDeveloperRole: false`
  automatically, so pi keeps sending `system` instead of failing with a 400.
- **Official-style storage** — API keys go to `~/.pi/agent/auth.json` (the same
  file `/login` writes), model declarations to `models.json`. Legacy inline
  `apiKey` entries migrate automatically. See [Storage](#storage).
- **Exact thinking levels** — automatic capability lookup or manual
  checkboxes define the supported set. Choose the active level in Pi with
  `/thinking`. Manual declarations survive refresh. Complete maps use `null`
  for unsupported levels; unknown metadata never automatically unlocks
  `xhigh` or `max`.
- **Model display names** — gateway, models.dev and local catalog names are
  preserved for display and search. Custom names survive refresh; API model
  ids always retain their exact spelling.
- **Path-adaptive probing** — if `/models` doesn't answer on the given base,
  the `/v1` variant is tried automatically; non-local `http://` falls back to
  `https://`. On failure you can retry or switch to manual entry.

## Install

```bash
pi install /path/to/pi-model-dock            # from this local checkout
```

After the independent repository is published, it can be installed with
`pi install https://github.com/sheauhuu/pi-model-dock`. The intended npm
package name is `pi-model-dock`; npm installation is not available from this
local preparation.

Prefer `pi install` over copying the folder into `~/.pi/agent/extensions/`
manually: `pi install` runs `npm install`, so the runtime dependencies
(`@opencode-ai/models`, `model-probe`, `yaml`) are present. A manual copy still starts, but YAML
configs degrade to JSON (a valid YAML subset).

## Usage

Run `/provider` in pi, then choose **Add provider**, **Edit provider**,
or **Delete provider**.

Provider names preserve your spelling: entering `AxonHub` uses `axonhub` as
the lowercase provider id and stores `name: "AxonHub"` for display. When the
name matches the id, no extra `name` field is needed. Lists show
`AxonHub (axonhub)` and accept searches by either name or id; older entries
without `name` continue to display their id.

Models also have an independent display `name`: for example,
`id: "gpt-6.1-sol"` with `name: "GPT-6.1-Sol"`. Model ids are sent to the API
unchanged, including case. **Display name** offers Auto, Custom, and Use model
id. Automatic names prefer gateway `display_name` / `displayName` / human
`name`, then reference catalogs. Lists display and search both name and id.
Existing entries receive an automatic name when you apply Refresh or choose
Auto in Display name; browsing does not silently rename them.

### Add

1. **From models.dev catalog** — pick a provider, name it, enter the API key
   (or none), multi-select models. Metadata comes from the catalog.
2. **Custom endpoint** — pick the provider style, enter the endpoint URL, name
   it, enter the API key, then:
   - **Auto-detect from the endpoint** — probe `/models` + metadata sources,
     multi-select models with metadata shown inline; or
   - **Add manually** — type an id, adjust its metadata menu (reasoning / image
     / context window / max output), confirm, next id; blank or esc finishes.

### Edit

Pick a provider, then: **Re-probe for models** (reconcile as above),
**Edit per model**, **Delete models**, **Add models manually**, **API flavor**,
**Endpoint**, **Rename provider**, or **Delete provider**.

Per-model edits change one field in place — untouched fields (cost, headers,
overrides) are preserved.

**Context window** opens a preset menu: Auto, detected/reference values,
common usage limits (including 272,000 tokens), and Custom. A manual selection
is retained across refresh and restarts. Auto removes that override. The menu
shows the configured budget separately from the detected capacity; changing
Pi's budget does not change a gateway's billing rules.

**Supported thinking levels** opens Auto or Manual. Manual opens
checkboxes: use Space to toggle and Enter to save at least one level; Escape
cancels. Known levels are preselected; an unknown model starts unchecked.
Selecting `low / high / max` writes a complete map with `off`, `minimal`,
`medium` and `xhigh` disabled. This is a manual declaration, not a live
capability test. Refresh updates observations but retains this declaration;
Auto removes it and uses the latest observed/reference data.

Choose the active thinking level in Pi with `/thinking`; the plugin does not
apply a separate thinking-level ceiling. Legacy ceiling preferences are ignored;
refresh or reselect supported levels to update an already saved restricted map.

**Refresh metadata** offers a gateway query with fallback references, an
explicit models.dev reference, or an installed Pi model reference. Each
update previews field and thinking-map differences before applying them.
Manual names, supported-level declarations and usage limits stay separate;
missing values never erase an existing field.
Older entries have no recorded manual preferences: refresh previews their
differences, and selecting a manual value records a persistent override.

**Rename provider** preserves spelling too. Changing only capitalization
updates the display name while keeping the id and credentials in place.
Changing the derived id retains the existing credential-migration behavior.

## How metadata is resolved

Every field is resolved independently, highest priority first:

1. **Gateway declarations** — inline `/models`, per-model details, and the
   gateway-wide metadata sources. Parsing accepts `modalities.input`, object
   and array capability formats, and both string and `{ effort }` reasoning
   lists. A partial gateway-wide response does not suppress missing details.
2. **models.dev** — matching endpoint data first, then exact normalized model
   matches across catalog providers, preferring the model maker's entry.
3. **Installed Pi model catalog** — matching models from the running host,
   with the source provider identified. Configured custom providers are
   excluded so an old custom setting cannot become its own reference.
4. **Local rules** — `model-probe` known-model rules, tagged as guesses.
5. **Unknown** — missing image/reasoning/limit/effort data is displayed as
   unknown. Newly created runtime entries conservatively use text-only input
   and no reasoning when those capabilities are unknown; this fallback is
   never recorded as evidence that the model lacks the capability.

An explicit Refresh source selection lets you review a chosen reference;
automatic filling never replaces an explicit gateway `false` with a lower
priority guess. Conflicting context values remain available as labeled
presets, within a known gateway limit. Exact thinking lists update even when
`reasoning` remains `true`; guesses do not overwrite existing values during
refresh. Video is retained as metadata, but Pi's config only receives its
supported text/image input fields.

### Cost estimation

When the gateway reports list prices (LiteLLM `input_cost_per_token` & co.,
OpenRouter inline `pricing`) or the model matches a models.dev catalog entry,
the extension writes pi's `cost` field (USD per 1M tokens: input / output /
cacheRead / cacheWrite) into each model entry — the same field built-in
providers carry — so pi's usage accounting can estimate session cost for
custom providers too. Cost is never guessed: no local rule, no default. Prices
for relay gateways are the maker's list prices, which may differ from what the
relay actually bills.

## Storage

Pi (official split, same as `/login`):

- `~/.pi/agent/auth.json` — credentials, keyed by provider id
  (`{"type": "api_key", "key": ...}`); `$ENV` / `!command` references work.
  pi resolves them for any provider id automatically. Selecting "none" writes
  a `"dummy"` / `"ollama"` placeholder so the provider still loads.
- `~/.pi/agent/models.json` — provider declarations (baseUrl, api, compat,
  models). pi only loads custom providers from `models.json`;
  `models-store.json` is pi's internal catalog cache for built-in providers
  and is not a place for custom models.
- `~/.pi/agent/pi-model-dock.json` — capability snapshots, field sources and
  explicit manual preferences, keyed by provider/model. No credentials,
  endpoints or headers are stored here. Manual model names and supported-level
  declarations are preferences; they do not replace stored observations. Provider/model deletion cleans up
  these records; changing a provider id migrates them.
- Legacy inline `apiKey` entries migrate to `auth.json` on the next save;
  deleting a provider removes its `auth.json` entry, renaming moves it.

### Built-in id collision

Naming a custom provider after one of pi's built-in provider ids (e.g.
`deepseek`, `openai`) does **not** replace the built-in — pi merges the two:
the built-in model catalog stays visible even if you delete those models here,
and `auth.json` is keyed by id, so `/login` and `/logout` for the built-in
also read/wipe your key. When you add or rename a provider to a colliding id
the extension offers a one-click rename to `<id>-custom` (keeping the
collision stays possible for deliberate built-in extension), and delete-model
confirms flag the merge behavior. Provider lists mark colliding ids with a
`⚠ built-in id` suffix. If you keep the collision on purpose, use
`/hide-models` (pi-hide-providers) to hide built-in catalog entries you don't
want.

OMP: providers and keys stay in `models.yml` / `models.yaml` (existing files
keep their format; a fresh config is created as `models.yml`). Saving YAML
rewrites formatting and drops comments.

## Development

Plain TypeScript loaded directly by pi — no build step. Gateway list/detail
parsing and capability/preferences logic live in this project; gateway-wide probes, limit normalization and known-model rules reuse
[model-probe](https://github.com/real-wudaoshi/model-probe). Dependencies in
`node_modules` are not patched.

```bash
npm install     # install runtime dependencies
npm run check   # inherited syntax checks plus the added feature modules
npm test        # isolated capability, preference, refresh and naming tests
```

The inherited `check` script currently omits `src/presets.ts`; it performs
syntax checking only. There is no project-wide type-check or CI configuration.
Tests use Node's TypeScript stripping and VM modules, with metadata fixtures,
in-memory host/UI adapters and temporary preference files; they never use
real credentials or generation endpoints. Node.js 24 is the tested development
baseline. The current baseline was checked with Node.js 24.12.0; the
declared Node.js minimum and syntax-check command need alignment (see the
initial review). An additional ad-hoc type-check against the installed host
reported only existing `model-probe/src/modelsdev.ts` type errors against its
models.dev SDK; dependencies were left unchanged.

Layout: `index.ts` (command entry) · `src/flows/` (add / edit / delete /
shared) · `src/ui/` (pickers, prompts) · `src/config.ts` (models.json +
auth.json I/O, migration) · `src/model-entry.ts` (model/provider config
builders) · `src/provider-name.ts` (display names and ids) · `src/api-key.ts`,
`src/url.ts`, `src/presets.ts` (helpers). Capability work is in
`src/gateway-metadata.ts`, `src/capabilities.ts`, `src/model-catalog.ts`,
`src/model-settings.ts` and `src/model-state.ts`; `src/model-name.ts` handles
model display labels. Provider lists, model names and capabilities share one official
`@opencode-ai/models` catalog cache, with its bundled snapshot as an offline fallback.

## License

MIT
