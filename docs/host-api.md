# Host API (`ctx.memoryCloud`)

[中文](host-api.zh.md) · [English user guide](reference.en.md)

Look up the service when you need it. The main plugin row provides one host-level Cordis service, `memoryCloud` (`MEMORY_CLOUD_SERVICE`). Use `ctx.get('memoryCloud')?.api` without declaring `inject`. Every method on `api` resolves its promise with plain JSON, even on failure. A failed write gets a perfectly good result of its own, `{ok: false, message}`.

The settings page and other plugins use the API below. The same service carries `budgetFor`, `composer`, `scopeFor`, `isEnabled` and `notifyFallback` for `lib/engine.js` alone. Import the public types from the package root. `src/runtime/status.ts` declares `MemoryCloudApi`, `MemoryCloudService`, `MemoryCloudStatus` and `TakeoverActionResult`. `SettingWriteResult` is declared in `src/runtime/settings.ts`.

In the browser, these calls travel through the Typert Remote namespace `memoryCloud`. On the host, `src/runtime/remote.ts` provides `memoryCloudRemote` with a `bindTypertRemote()` binding and `@Remote` method markers. DSH's Typert Gateway discovers these in SRC mode without generating artifacts. The settings page mounts the matching contribution with `ctx.remote.$mount()` and uses strict codecs for every field the client supplies. Owner peers have access by default. Other peers need DSH's remote-access policy to allow the action.

The namespace exposes `memoryCloud/status`, `setLevel`, `setMode`, `takeover` and `restore`, plus the Remote-only `getConfig` and `setConfig` described below. The client codecs and the host's write methods share the argument parsers in `src/client/contract.ts`. Responses go over the wire as plain JSON, with non-finite numbers converted to `null`. Call the Remote's `status()` without an id and it picks the most recently active live non-subagent session, if there is one. On the host, supply a live session id to `api.status()` for that session's details.

| Method | Result | What happens |
|---|---|---|
| `api.status(sessionId?)` | `MemoryCloudStatus` | Returns a host snapshot. With a live session id it can include `agent`. See [Status fields](#status-fields). |
| `api.setLevel(level)` | `SettingWriteResult` | Saves a level from 1–5 through `ctx.settings.update('<row id>', …)`, or through `ctx.configEditor.edit` on the plugin row when the settings service is absent. This volatile field applies live. If neither writer is available or the write fails, the result is `{ok: false, message}`. A higher layer overriding the row is one such failure. |
| `api.setMode(mode)` | `SettingWriteResult` | Takes `auto`, `engine`, `assist` or `off` through the same write path. Each agent's cached mode decision is recomputed on its next use. |
| `api.takeover(presetId = 'standard')` | `TakeoverActionResult` | With `agentPresets` (Web/Desktop), the config editor changes the preset's compaction group for new sessions only. Without presets (headless/SDK), `ctx.pluginManager` switches on the normally disabled `dsh-memory-cloud-brain-engine` row and switches off `compaction-basic` if present. Check `outcome.application` to see whether DSH needs a restart. |
| `api.restore(presetId = 'standard')` | `TakeoverActionResult` | Undoes takeover on the corresponding preset or host rows. |
| `setSessionTags(sessionId, tags)` | `void` | A synchronous bridge method. Call it as `ctx.get('memoryCloud')?.setSessionTags(sessionId, tags)`. See [Session tags](#session-tags). |

## Status fields

Start with `configured` for the settings someone asked for. Read `agent` for the mode and budget a particular session actually got. Both have a place in `MemoryCloudStatus`.

| Field | What it tells you |
|---|---|
| `storageRoot`, `profile?` | The resolved storage directory and, when known, the DSH profile name. |
| `configured` | The configured `{level, compactionMode, unmatchedSessions}`. |
| `firewall?` | What happens now if no scope rule matches. `unmatchedSessions` is resolved against the recognized bridges currently loaded as `{setting, mode: 'owner' \| 'isolated', bridges, reason}`. `bridges` names the detected plugins that led `auto` to isolate sessions. An unrecognized setting resolves to `isolated`. `/memory status` gives this field its own line, and the settings page shows it in the firewall row. |
| `agent?` | A live session's `{sessionId, subagent, scope, mode, capacity, budget, pressure}`. `scope` holds its `ScopeDecision` (`scope`, `capture`, `private`, `reason`). `mode` gives the effective mode and reason. `capacity` identifies the routed model, context window and reserved output, with `known: false` for the 32K estimate below. `budget` holds the resolved level budget. `pressure` ranges from 0 to 1. |
| `scopes` | Episode counts for each scope (`open` / `sealed` / `summarized` / `failed`), plus counts of pinned episodes, hidden episodes and rollups. |
| `jobs` | Queue, running job, daily quota, circuit breaker, totals and last error from the job runner. |
| `takeover` | The current preset or host-engine takeover state. |
| `coexistence` | Detected `memoryPlugins`, `compactionPlugins` and `bridgePlugins`, tool-name conflicts, and warnings in Chinese and English. |
| `registrations` | Whether the recall tools and `/memory` registered, with reasons for any problems, including name clashes. |
| `fallbacks` | Up to 20 non-routine hand-backs to compaction-basic, newest last. The kinds are `compose-error`, `compose-timeout`, `shrink-guard`, `empty`, `scope-error` and `budget-error`. |
| `routineFallbacks?` | Counts the routine hand-backs by kind (`subagent`, `no-capture`, `region-too-small`). These go in the debug log and stay out of `fallbacks`. |

**For an unknown window, the estimate is 32K.** `context.contextWindow` is optional in `LlmResolvedModelInfo`. If `ctx.llm.resolveModelInfo()` omits it for the routed model, or the lookup fails, the plugin assumes W = 32 768 (`FALLBACK_CONTEXT_WINDOW` in `src/runtime/budget.ts`). It uses that estimate for the memory block, recall limit and status, and reports `capacity.known: false`. The engine skips level-threshold mapping for that model. Compaction-basic's row configuration still decides when to compact.

## Session tags

A chat bridge calls `setSessionTags(sessionId, tags)` on the service with its routing tags, for example `qqbot:<bot>:group:<id>`. Send the whole set you want the session to have. `scopeRules` can match those tags alongside the synthetic `preset:`, `cwd:` and `session:` tags. `preset:` names the preset in use now. For a subagent, the resolver follows `parentSession` up the delegation chain while the current session is a subagent. The root session determines the scope regardless of the child's tags. The lookup stops if it reaches an unknown parent.

- **Replacing tags.** Each call replaces the session's previous bridge tags. Entries are trimmed and empty entries discarded. Tags over 1024 characters are dropped. The session keeps at most 64 distinct tags. An empty list clears them.
- **Keeping tags.** Tags belong to the DSH app for this process. A live session keeps them across a plugin reload, including an upgrade, a `storageRoot` edit or re-enabling the plugin. `session/disposed` removes them.
- **Checking the new decision.** The plugin discards the cached descriptor and resolves the scope again. With no live agent it uses `ctx.sessions`, then the previous descriptor if needed. If both the scope and capture flag match the previous decision, the check ends there. Setting tags before the first description gives it no previous decision to act on.
- **Moving to another decision.** `injector.rescope` drops the cached block and pending pack but remembers which scope's block it showed. The composer forgets the session, and `capture.rescope(sessionId)` seals the open episode in the old scope with reason `end`. The next captured event uses the new scope.
- **Switching presets.** `agent-preset/selected` takes the same path. The descriptor uses the current preset from `agentPresets.presetForSession`, or the preset in the event. The plugin also recomputes the cached compaction mode.
- **Reading an existing context.** An owner block already in context stays until the next compaction. If the new decision removes access, the injector remembers that it showed the block and logs a warning.

When no rule matches, `unmatchedSessions` chooses a scope. `owner` uses the private owner scope. `isolated` gives each session a `session-<hash>` scope, shared by subagents of that delegation root. The default, `auto`, isolates sessions while it detects any of `dsh-qq-bridge`, `dsh-qqbot`, `dsh-qq-rooms`, `dsh-onebot-qq` or `dsh-wechat`. Otherwise it chooses owner.

Reading owner memory requires a decision that is both `owner` and private. A rule whose template literally says `owner` can grant it, as can an owner decision from `unmatchedSessions`. If a template only expands to `owner`, the resolver assigns `owner-<hash>`. `canReadScope` and `mayUseOwnerMemory` in `src/scope/guard.ts` enforce these checks.

## Live settings (Remote only)

The settings page's Advanced section uses two extra endpoints for `.volatile()` fields. Call them on the Remote. `ctx.memoryCloud.api` exposes the host methods in the first table.

| Remote endpoint | Result | What to send or expect |
|---|---|---|
| `memoryCloud/getConfig()` | `ConfigView` | Returns `{config, defaults}` with current values and schema defaults. The live fields are `level`, `compactionMode`, `idleMinutes`, `idleCompactRatio`, `halfLifeDays`, `maxEpisodeTokens`, `captureReasoning`, `summarizer.{provider, model, reasoningEffort}`, `overrides`, `scopeRules` and `unmatchedSessions`. |
| `memoryCloud/setConfig(patch)` | `SettingWriteResult` | Send the fields you want to change in `patch` (`ConfigPatch`). Within `summarizer`, send just the changed fields. Supplying `overrides` or `scopeRules` replaces that whole value. Leave an override out of its replacement and that field goes back to the level's own value. |

`setConfig` checks the entire patch before writing. It returns `{ok: false, message}` if any of the following checks fail.

- Every field must be a known live setting. For example, `storageRoot` takes effect at startup.
- After the patch is merged with the live config, the values must satisfy the Config schema.
- A scope rule needs both a nonempty pattern and a nonempty scope.
- A `$n` in the scope template must refer to a wildcard (`*` or `?`) that exists in the pattern.

Writes use the same row as `setLevel`. Where `ctx.settings` supports `settings.mutate()`, a patch with an object value uses set-path operations. A deep merge with `update()` would keep an override the caller meant to remove. Other writes use `update()`. Without `ctx.settings`, `ctx.configEditor.edit` sets each path in the row's whole current `config`.

A saved setting is live. Its readers pick it up at their own times. Cached per-agent mode decisions are recomputed. Injection and recall check the scope at every step. Capture checks it at the next turn start and seals any open episode in the old scope if the decision moved.

## Takeover results

Read `kind` first. A preset can already be in the requested state, which counts as a successful answer. `TakeoverActionResult` has three shapes.

- Preset success returns `{kind: 'preset', ok: true, action: 'applied' | 'unchanged' | 'restored', preset?, warning?}`.
- Preset failure returns `{kind: 'preset', ok: false, code, message}`. The `code` is one of `no-config-editor`, `preset-not-found`, `no-compaction-group`, `overridden` or `edit-failed`.
- A host-engine action returns `{kind: 'host', ok, outcome: HostEngineOutcome}`.

The plugin files its takeover records by DSH profile name in `<storage root>/takeover.json`. About 10 s after startup it runs `refreshAfterUpgrade()` once in the background.
