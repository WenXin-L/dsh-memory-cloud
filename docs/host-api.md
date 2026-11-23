# Host API (`ctx.memoryCloud`)

The main plugin row provides one host-level Cordis service, `memoryCloud` (`MEMORY_CLOUD_SERVICE`). It carries the engine seam (`budgetFor`, `composer`, `scopeFor`, `isEnabled`, `notifyFallback`; used only by `lib/engine.js`) plus the API below for the settings page and other plugins. Types are exported from the package root (`MemoryCloudApi`, `MemoryCloudService`, `MemoryCloudStatus`, `TakeoverActionResult`, `SettingWriteResult`, …) and declared in `src/runtime/status.ts`.

Read it lazily, without `inject`: `ctx.get('memoryCloud')?.api`. Every method resolves (never rejects) with plain JSON data.

The browser reaches the same API through the Typert Remote namespace `memoryCloud` (`src/runtime/remote.ts`): the host provides a `memoryCloudRemote` service bound with `bindTypertRemote()` whose methods carry `@Remote` markers, which DSH's Typert Gateway discovers in SRC mode (no generated artifacts). Endpoints mirror the table below (`memoryCloud/status`, `setLevel`, `setMode`, `takeover`, `restore`) plus `getConfig`/`setConfig` (Remote only, see below); arguments are validated with the shared parsers in `src/client/contract.ts`, results are normalized to plain JSON (non-finite numbers become `null`), and `status()` without a session id describes the most recently active live session. The settings page mounts the matching contribution with `ctx.remote.$mount()` (strict codecs on every client-supplied field). Only owner peers may call it unless DSH's remote-access policy allows the action.

| Method | Result | Notes |
|---|---|---|
| `api.status(sessionId?)` | `MemoryCloudStatus` | See [Status fields](#status-fields). With the id of a live session it adds `agent`. |
| `api.setLevel(level)` | `SettingWriteResult` | `level` 1–5. Written through `ctx.settings.update('<row id>', …)`, else `ctx.configEditor.edit` on our row; applies live (volatile field). `{ok: false, message}` when neither service exists or the write is rejected (e.g. a higher layer overrides the row). |
| `api.setMode(mode)` | `SettingWriteResult` | `auto` \| `engine` \| `assist` \| `off`; same write path. Cached per-agent mode decisions are recomputed on next use. |
| `api.takeover(presetId = 'standard')` | `TakeoverActionResult` | Profiles with `agentPresets` (web/desktop): config-editor takeover of the preset's compaction group (new sessions only). Profiles without presets (headless/sdk): toggles the shipped-disabled `dsh-memory-cloud-brain-engine` row and `compaction-basic` through `ctx.pluginManager`; expect `restart-required`. |
| `api.restore(presetId = 'standard')` | `TakeoverActionResult` | Inverse of `takeover`. |
| `setSessionTags(sessionId, tags)` | `void` | On the service, not on `api` or the Remote. See [Session tags](#session-tags). |

## Status fields

`MemoryCloudStatus`:

| Field | Meaning |
|---|---|
| `storageRoot`, `profile?` | Resolved storage root and DSH profile name. |
| `configured` | `{level, compactionMode, unmatchedSessions}` as configured. |
| `firewall?` | The `unmatchedSessions` decision for sessions no scope rule matches, resolved against the chat bridges loaded right now: `{setting, mode: 'owner' \| 'isolated', bridges, reason}`. `bridges` lists the detected bridge plugins that made `auto` isolate; an unrecognized setting resolves to `isolated`. Rendered as its own line in `/memory status` and as the firewall row on the settings page. |
| `agent?` | Only with a live session: `{sessionId, subagent, scope, mode, capacity, budget, pressure}`. `scope` is that session's `ScopeDecision` (`scope`, `capture`, `private`, `reason`); `mode` the effective mode and reason; `capacity` the routed model, window and reserved output (`known: false` when the model reports no window and the 32K fallback is used, see below); `budget` the resolved level budget; `pressure` 0–1. |
| `scopes` | Episode counts per scope (`open`/`sealed`/`summarized`/`failed`, pinned, hidden, rollups). |
| `jobs` | Job-runner stats: queue, running job, daily quota, breaker, totals, last error. |
| `takeover` | Preset or host-engine takeover state. |
| `coexistence` | Detected memory, compaction and bridge plugins (`memoryPlugins`, `compactionPlugins`, `bridgePlugins`), tool-name conflicts, zh/en warnings. |
| `registrations` | Whether the recall tools and `/memory` registered, with problems such as name clashes. |
| `fallbacks` | Recent non-routine engine hand-backs to compaction-basic (`compose-error`, `compose-timeout`, `shrink-guard`, `empty`, `scope-error`, `budget-error`), newest last, at most 20. |
| `routineFallbacks?` | Counts per kind of routine hand-backs (`subagent`, `no-capture`, `region-too-small`), which are not listed in `fallbacks` and are logged at debug level only. |

**Fallback window.** When `ctx.llm.resolveModelInfo()` reports no `context.contextWindow` for the routed model (the field is optional in `LlmResolvedModelInfo`), or the lookup fails, the plugin assumes W = 32 768 (`FALLBACK_CONTEXT_WINDOW`, `src/runtime/budget.ts`) for the block, recall limit and status, and reports `capacity.known: false`. The engine maps no level thresholds for such a model and leaves compaction-basic's row config in charge.

## Session tags

`setSessionTags(sessionId, tags)` is for chat bridges: routing tags such as `qqbot:<bot>:group:<id>` that `scopeRules` match, next to the synthetic `preset:`, `cwd:` and `session:` tags (`preset:` names the preset the session runs now, see below). A subagent is resolved through the root session of its delegation chain, whatever its own tags: the resolver follows `parentSession` while the session is a subagent and stops at a parent it does not know.

- The call replaces the session's tags. Tags are trimmed; empty ones, ones longer than 1024 characters and any beyond 64 are dropped. An empty list clears them.
- Tags are kept per DSH app for the whole process, so they survive a reload of this plugin in the same process (an upgrade, a `storageRoot` edit, re-enabling it) while the session is live. They are dropped on `session/disposed`.
- The cached descriptor is dropped and the scope is resolved again. A session with no live agent is described from `ctx.sessions`, or else from its previous descriptor, so the comparison below still applies to it. If the session had been described before and its decision (scope and capture flag) is unchanged, nothing else happens.
- If the decision changed, the injector drops the session's cached block and pending pack (`injector.rescope`) but remembers which scope's block it showed, the composer forgets the session, and `capture.rescope(sessionId)` seals the open episode in the old scope (reason `end`); the next event is captured under the new scope. A tag set before the session was first described changes nothing else, because there is no earlier decision.
- The same path runs on `agent-preset/selected`: the session is described again with the preset it runs now (`agentPresets.presetForSession`, else the event's preset), and its cached compaction mode is recomputed.
- An owner memory block already in the context stays there until the next compaction; because the injector remembers which scope's block it showed, it logs a warning when the session no longer may read it.

Sessions that no rule matches follow `unmatchedSessions` (`auto` \| `owner` \| `isolated`, default `auto`): `owner` uses the private owner scope, `isolated` gives each session its own scope `session-<hash>` (a subagent shares the scope of its delegation chain's root session), and `auto` isolates while a known chat-bridge plugin (`dsh-qq-bridge`, `dsh-qqbot`, `dsh-qq-rooms`, `dsh-onebot-qq`, `dsh-wechat`) is loaded and uses owner otherwise. Only a decision that is `owner` **and** private may read owner memory (`canReadScope` / `mayUseOwnerMemory` in `src/scope/guard.ts`): a rule whose template is literally `owner`, or an owner decision of `unmatchedSessions`. A template that merely expands to `owner` gets `owner-<hash>`.

## Live settings (Remote only)

The Remote also serves the plugin's live (`.volatile()`) settings for the page's Advanced section. These two endpoints exist only on the Remote, not on `ctx.memoryCloud.api`:

| Remote endpoint | Result | Notes |
|---|---|---|
| `memoryCloud/getConfig()` | `ConfigView` | `{config, defaults}`: every live field as plain values (`level`, `compactionMode`, `idleMinutes`, `idleCompactRatio`, `halfLifeDays`, `maxEpisodeTokens`, `captureReasoning`, `summarizer.{provider, model, reasoningEffort}`, `overrides`, `scopeRules`, `unmatchedSessions`) and the schema defaults. |
| `memoryCloud/setConfig(patch)` | `SettingWriteResult` | `patch` (`ConfigPatch`) holds only the fields to change. `summarizer` lists just its changed fields; `overrides` and `scopeRules` replace the whole value (an override left out falls back to the level's own value). |

`setConfig` checks the patch before writing anything and answers `{ok: false, message}` for:
- unknown or non-volatile fields (e.g. `storageRoot`);
- values the Config schema rejects once merged with the live config;
- scope rules with an empty pattern or scope;
- scope rules whose template uses a `$n` beyond the number of wildcards (`*`, `?`) in the pattern.

Writes go through the same row as `setLevel`. With `ctx.settings`, object values use `settings.mutate()` set-path ops (`update()` deep-merges and could not drop an override), and other values use `update()`. Without `ctx.settings`, `ctx.configEditor.edit` sets each path inside the row's whole current `config`. Values apply live, and cached per-agent mode decisions are recomputed. Injection and recall resolve the scope on every step; capture resolves it again at the next turn start, and when it changed seals the open episode in the old scope.

## Takeover results

`TakeoverActionResult` is `{kind: 'preset', ok: true, action: 'applied' | 'unchanged' | 'restored', preset?, warning?}`, `{kind: 'preset', ok: false, code, message}` (`code` ∈ `no-config-editor`, `preset-not-found`, `no-compaction-group`, `overridden`, `edit-failed`), or `{kind: 'host', ok, outcome: HostEngineOutcome}`.

Takeover records live in `<storage root>/takeover.json`, keyed by DSH profile name; `refreshAfterUpgrade()` runs once, detached, about 10 s after the plugin starts.
