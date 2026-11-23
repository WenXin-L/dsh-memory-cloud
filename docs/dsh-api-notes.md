# DSH API notes (Phase 0 compatibility spike)

Verified against the **installed** DeepSeek Harness `0.2.2-rc.5` (npm `latest`, Node 26.3, macOS) on 2026-11-23. Every `@deepseek-ai/*` package ships its TypeScript `src/` beside `lib/`, so the paths below are package-relative (`<pkg>/src/<file>.ts:<line>`). Packages this repo depends on are browsable under `node_modules/@deepseek-ai/`; the others (`dsh-web-app`, `dsh-agent-preset`, `dsh-settings`, `dsh-plugin-manager`, `dsh-client-ui-plugin-manager`, …) live in the GitHub monorepo (`deepseek-ai/deepseek-harness`, `packages/...`) or in `node_modules/@deepseek-ai/dsh/node_modules` of a full `@deepseek-ai/dsh` install. The `dsh` package also ships `docs/` (subsystem references) and `@deepseek-ai/dsh-agent-preset/skills/dsh-doc/references/*.md` (the official plugin-authoring guide); both were read.

Legend: **[runtime]** = observed in the spike below; **[source]** = read from shipped source/`.d.ts` only.

## 0. Decisions and their consequences (read this first)

| Topic | Verified fact | Decision |
|---|---|---|
| Engine hook | `BasicCompactionEngine` is the default export and a named export of `@deepseek-ai/dsh-compaction-basic`. `protected summarize(input, agent, signal?) => Promise<SummaryResult>` may return **any text blocks** [runtime]. | Engine mode is viable. Our text is wrapped by DSH in a fixed preamble + `<compacted-summary>` tags and must be **smaller than the replaced span** under DSH's 4-chars/token heuristic. |
| Level thresholds | Engine config only has `thresholdRatio` (of W, capped at `W − O − headroomTokens`) and `retainRatio`/`retainTokens`, plus exact-route `modelPolicies`; `this.config` is re-read on every call and can be replaced per call [runtime]. | Before delegating to `super.compactIfNeeded`, the engine subclass converts the level's absolute threshold into `thresholdRatio = T / W` for the routed model and records it as that model's `modelPolicies` entry (with `headroomTokens`, `retainTokens`, `maxTokens`), merged under the row's own `modelPolicies`; the row's top-level fields are never rewritten (§1.2). It lowers `headroomTokens` because the default 65 536 caps the threshold hard. |
| Web takeover | A bundle patch **cannot** reach the nested `compaction` group of `preset-standard` by id (silent no-op or "not found") [runtime]. `ctx.configEditor.edit(presetStandardEntry, change)` rewrites that row's full `config` in the profile patch, the preset remounts with our engine, and `edit(entry, (_, inherited) => inherited)` restores it [runtime]. | **Chosen path: one-click takeover through `ctx.configEditor`** (settings button + `/memory takeover`), reversible, re-derived on upgrade. Default install runs in assist mode on Web. |
| Top-level engine row | In preset profiles the host-level `compaction-basic` is disabled by `dsh-web-app`; a host-level engine with `auto` listeners would also see preset agents (global listeners receive every agent). | Do **not** ship an enabled top-level engine row. For headless/sdk, ship it `disabled: true` and toggle via `ctx.pluginManager.setPluginEnabled` (runtime-verified in §8). |
| Settings form | `ctx.settings` / client `ctx.configForms.get(ns)` expose **only `.volatile()` fields**, `ns` = Loader row id [runtime]. | All user-tunable fields are volatile; `storageRoot` is ordinary (restart). Row id = package name = `dsh-memory-cloud-brain`. |

## 1. Compaction engine

### 1.1 Export, class, signature

`@deepseek-ai/dsh-compaction-basic` (`lib/types/index.d.ts`; `src/index.ts:112`), exports `{ BasicCompactionEngine, default }` and types `BasicCompactionConfig, CompactionPolicyConfig, ModelCompactPolicyConfig, ResolvedCompactSpec, ResolvedConfig, ResolvedRetention, ResolvedTargetPolicy`. It extends `CompactionEngine` from `@deepseek-ai/dsh-compaction` (a Cordis `Service` named `compaction`).

```ts
// dsh-compaction-basic/src/index.ts:112-140, 270-280
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']
  static Config: z<BasicCompactionConfig> = z.object({ thresholdRatio, headroomTokens, retainRatio, retainTokens,
    summarizationProvider, summarizationModel, maxTokens, compactionRetries, maxOverflowRetries, modelPolicies, auto })
  readonly config: ResolvedConfig
  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomaticCompaction()
  }
  /** `summarize()` is the sole subclass customization hook */
  protected async summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult>
```

`SummarizationInput` / `SummaryResult` are **not** re-exported from the package root. Type them with a deep type-only import (works under TS 7, verified with `tsc`): `import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'` (package exports `"./src/*"`), or `Parameters<BasicCompactionEngine['summarize']>[0]` (also compiles despite `protected`).

```ts
// dsh-compaction-basic/src/summarizer.ts:79-107
export interface SummarizationInput {
  readonly tools?: readonly ToolSchema[]          // request header tools, for prefix-cache alignment
  readonly messages: readonly Message[]           // system head (surface node 0) + shadowed region, surface order
}
export type SummaryResult = {
  summary: ContentBlock[]; provider: string; model: string; maxTokens?: number; usage?: TokenUsage
} & ( { rawOutput: ContentBlock[]; llmStreamCall: true }        // exactly one ctx.llm.stream() call
    | { rawOutput?: ContentBlock[]; llmStreamCall?: never } )   // template/remote/other summarizer
```

With `exactOptionalPropertyTypes` (on in this repo) a custom result must **omit** `rawOutput`/`llmStreamCall`, not set them to `undefined`.

What DSH does with the result (`dsh-compaction-basic/src/region.ts:387-428`, `summarizer.ts:70,188-194`):
- `frameSummary(summary)` → `[{text: CHECKPOINT_PREAMBLE + '\n\n<compacted-summary>'}, ...summary, {text: '</compacted-summary>'}]`, appended as a `user/message` with source `{kind: 'compact-checkpoint', compactionId}` and `surfaceOp: {op:'replace', startSeq, endSeq}` [runtime]. The preamble says "This is an automatically generated checkpoint condensing an earlier span… Continue the task directly…". We cannot change the framing; our `<memory-cloud>` block nests inside it.
- **Shrink guard**: `if (meter.estimateMessage(checkpointMessage) >= shadowedRouteTokenCount) throw new Error('summary is not smaller than the shadowed content …')`. Both sides use the 4-chars/token heuristic (`dsh-token-meter/src/estimate.ts:13`). An idle `compactNow` over a small span plus a large memory block will fail this check.
- `summary` must contain non-empty text (the default summarizer enforces it; a custom one should too). Images are rejected.
- Throwing from `summarize()` → `compaction/summary-error` waterfall (default: no recovery) → `compaction/end {error}`; pressure path logs a warning and the turn continues uncompacted; `compactNow` rejects `ManualCompactionError('summary')` [runtime, `spikeMode: throw`]. DSH did not crash.
- `super.summarize(input, agent, signal)` is a working fallback: one `ctx.llm.stream` call with `purpose: 'compaction'`, `sessionId`, `toolHistory`, the replayed prefix and the coding-oriented instruction as the last user message; returns `llmStreamCall: true` [runtime, `spikeMode: fallback`].

Default summarizer call (`summarizer.ts:120-181`): target = `summarizationProvider/Model` if set, else the session's latest routed request (`agent.session.requestHeader()?.config`), else `agent.options`. Streams through `BlockAssembler`; `max-tokens`/`error`/`aborted` finishes throw.

### 1.2 Configuration (how a subclass gets it)

`BasicCompactionConfig` (`types.ts:16-51`): `thresholdRatio` (0,1], default 0.8; `headroomTokens` default 65 536; `retainRatio` default 0.16 **xor** `retainTokens`; `summarizationProvider`+`summarizationModel` (set as a pair); `maxTokens` (summary cap, default = `headroomTokens`); `compactionRetries` 1; `maxOverflowRetries` 1; `modelPolicies: [{provider, model, …same fields}]` exact-route overrides; `auto` default true.

- `resolveConfig` (`config.ts:68-110`) **rejects unknown keys** (`validateKeys`, `config.ts:330`). A subclass with its own options must strip them before `super(ctx, basicOnly)` [runtime: subclass `static Config = z.intersect([BasicCompactionEngine.Config, z.object({spikeMode})])` + destructuring worked].
- Spec per routed model (`config.ts:153-217`): `messageBudget = W − O` (O = header `maxTokens` ?? adapter `defaultMaxTokens` ?? 0); `thresholdTokens = floor(min(W × thresholdRatio, W − O − headroomTokens))`; `retainTokens = retainTokens ?? floor((W − O) × retainRatio)`; throws `TargetPressureConfigError` if `retainTokens ≥ thresholdTokens` or budgets ≤ 0 (logged once per target, compaction skipped).
- `this.config` is a plain class field (`lib/index.js:820`), re-read by `resolveTargetPolicy(this.config, target)` on every pressure check. Overriding `compactIfNeeded` to compute `{...this.config, thresholdRatio: T / W}` before `super.compactIfNeeded` changed the live threshold (0.8 → 0.45) [runtime, spike]. Swapping the top-level fields is wrong once one engine serves several agents or models: the model-switch check and the `super.summarize()` fallback would price with whichever agent compacted last.
- **What the engine does instead** (`src/engine/engine.ts` `applyPolicy`): it keeps the row's resolved config as `baseConfig` and sets `this.config = {...baseConfig, modelPolicies}`. There is one `modelPolicies` entry per routed `provider/model` it has mapped (`thresholdRatio`, `headroomTokens`, `retainTokens`, `maxTokens`), merged under the row's own entries: for a model the row also lists, the row's fields win field by field, and a row retention form (`retainRatio` or `retainTokens`) drops the mapped `retainTokens`. Models only we mapped are appended. When a model cannot be mapped (no `memoryCloud` host, the session is not in engine mode, a subagent, no reported window), its entry is removed, and with no entries left `this.config` is `baseConfig` again.
- Consequence for §3.7: with the default `headroomTokens` 65 536, a 128K-window model with O = 32K gets `threshold ≤ 32K` regardless of ratio. The engine should pass a small `headroomTokens` (≈ our summary `maxTokens`) so level thresholds are reachable.

### 1.3 Entry points and how they are called

| Method | Caller | Semantics |
|---|---|---|
| `compactIfNeeded(agent, 'pressure' \| 'context-overflow', signal)` | The engine's own `agent/pre-step` listener (`index.ts:157-175`) and `agent/request-error` listener on `CONTEXT_WINDOW_EXCEEDED` (`index.ts:213-257`), both registered by the constructor when `auto`; also an `agent/request` model-switch listener. | Needs a routed request header; pressure compacts while above threshold (up to `compactionRetries + 1` times); overflow prunes tool results then compacts with retain 0. Returns `CompactionResult \| null`. |
| `compactNow(agent, signal, sourceCommandId?)` | `/compact` (`dsh-command-compact`), our idle logic. | Runs as `agent.runMaintenance` (throws synchronously → `ManualCompactionError('busy')` if not idle), selects the whole compactable range (retain 0) even below pressure, writes `compaction/start {turn: null}` … `end`, then `ctx.sessions.flush`. [runtime] calling it synchronously inside an `agent/status` `'idle'` listener worked and headless waited for it (`whenIdle` follows maintenance). |
| `compactRegion(start, end, agent, signal?)` | explicit ranges | Balanced tool-pairing edges required. |

Getting the engine: host-level profiles → `ctx.get('compaction')` (lazy: it was `undefined` at our `apply()` time and present later; a bare `ctx.compaction` without `inject` throws "cannot get property "compaction" without inject") [runtime]. Preset profiles → `ctx.agentPresets.serviceFor(agent, 'compaction')` (`dsh-agent-preset-registry/src/index.ts:340`) [source].

### 1.4 `compaction/*` session events (`dsh-compaction/src/types.ts:17-91`)

```ts
'compaction/start':   { compactionId; sourceCommandId?; turn: number | null }      // null = standalone manual/idle
'compaction/summary': { compactionId; sourceCommandId?; summary: ContentBlock[];
                        shadowedRange: { start; end }  // surface-POSITION span, start may be > end
                        shadowedSeqs: SessionSeq[]      // authoritative, surface order
                        shadowedTokenCount: number      // fixed 4-char heuristic
                        provider; model; maxTokens?; usage? } & ({rawOutput; llmStreamCall: true} | {rawOutput?; llmStreamCall?: never})
'compaction/end':     { compactionId; sourceCommandId?; turn: number | null; error?: string }
'compaction/prune':   { shadowedRange; shadowedSeqs; shadowedTokenCount }          // tool-result pruner
```

Order [runtime]: `compaction/start` → `compaction/summary` → `user/message` (source `compact-checkpoint`, `surfaceOp.replace`, `sourceEventSeqs: [startSeq, summarySeq, ...shadowedSeqs]`) → `compaction/end`. Example: `shadowedSeqs [8,9,10,15,18]`; a later compaction's `shadowedSeqs [32,21,23,26,28]` begins with the previous checkpoint (seq 32), i.e. **compaction regions include earlier checkpoints and any injected memory message** — episode capture must exclude `compact-checkpoint` and our own source kinds. Also `compaction/summary-error` (waterfall, `dsh-compaction/src/index.ts:88-108`), `ManualCompactionErrorCode = 'busy'|'cancelled'|'changed'|'summary'|'commit'|'persistence'`.

`purpose: 'compaction'` makes the DeepSeek adapter add header `x-deepseek-harness-compact: 1` (`dsh-llm-deepseek/src/adapter.ts:152`); our own purpose will not carry it (server-side effect unknown).

## 2. Web Standard preset takeover

### 2.1 Facts

- Composition = bundle layers in `dsh.profile.bundles` order → profile `cordis.patch.yml` → home `$DSH_HOME/cordis.patch.yml` → `--patch` overlays (`dsh-app-boot/src/profile.ts:5-20`, `profile-context.ts` `readProfilePatches`). `dsh plugin --profile web add <pkg>` appends the bundle after `@deepseek-ai/dsh-web-app` [runtime].
- Patch dialect (`cordis-plugin-include/src/patch.ts:47-109`): id lookup only descends into rows with `group: true`; a non-insert patch replaces top-level row fields wholesale (`config` is never deep-merged); `insert` with an `id` appends into that **group** row.
- `preset-standard` (`dsh-web-app/presets/standard.patch.yml`) is an ordinary row (`@deepseek-ai/dsh-agent-preset`, an `EntryGroup` plugin that registers `config.plugins` with `ctx.agentPresets`); its `compaction` group (lines 72-87, `isolate: {compaction: true, toolResultPruner: true}`) lives inside `config.plugins`, mounted by the registry in its own in-memory `PresetTree` whose `commit()` is a no-op (`dsh-agent-preset-registry/src/mount.ts:9-24`).
- `dsh-web-app/cordis.patch.yml:576-583` disables the host-level `compaction-basic`, `command-compact`, `tool-result-pruner`.

Composition test (`composeEntries([dsh-base, dsh-web-app, patch])`) [runtime]:

| Patch | Result |
|---|---|
| `- id: compaction-basic` + `disabled: true` | Matches the **host-level** row (already disabled), no warning; the preset's nested `compaction-basic` is untouched. Silent no-op. |
| `- id: compaction` + `insert: [...]` | Warning `patch insert: entry "compaction" not found`; nothing inserted. |
| `- id: preset-standard` + full `config` | Works: the nested group becomes whatever we wrote. This is the official way ("Change a shipped preset", `dsh-doc/references/compositions.md`) but restates the whole preset. |

So a bundle can only take over by restating the entire standard preset (stale on every DSH upgrade, last bundle wins, noisy "not found" warnings in profiles without the preset).

### 2.2 `ctx.configEditor` (chosen)

`@deepseek-ai/dsh-config-editor` (row `config-editor` in `dsh-base`, enabled whenever `profileContext` exists, i.e. every `dsh --profile` launch incl. headless). API (`src/index.ts`): `entries(): Entry[]` (top-level rows with unique ids, includes `preset-standard`), `configuration()` (inherited vs override per entry), `edit(entry, (current, inherited) => nextConfig)` — validates with the row's schema, writes `- id/name/config` into the profile patch under the profile file lock and HMR queue, reloads the entry, rolls back on failure, and **removes the override when `next` deep-equals `inherited`**. The official settings service and `dsh-cua` use it to edit other plugins' rows.

[runtime, web profile, HMR on] Takeover probe:
1. `entries().find(e => e.options.id === 'preset-standard')` → found.
2. `edit(entry, current => takeOver(current))` wrote the override below; `agentPresets.inspectCompositions()` for `standard` then listed our engine module instead of `dsh-compaction-basic`; the engine constructed inside the isolated group; roster not broken; no restart.
3. `edit(entry, (_c, inherited) => inherited)` → profile patch back to `[]`.

```ts
function takeOver(config) {
  const plugins = config.plugins.map(row => row.id !== 'compaction' || !Array.isArray(row.config) ? row : {
    ...row,
    config: [
      { id: 'dsh-memory-cloud-brain:engine', name: 'dsh-memory-cloud-brain/engine' },
      ...row.config.filter(c => c.id !== 'dsh-memory-cloud-brain:engine')
        .map(c => c.id === 'compaction-basic' ? { ...c, disabled: true } : c),
    ],
  })
  return { ...config, plugins }
}
```

Exact YAML written to `<profile>/cordis.patch.yml` (abridged; every other shipped row is restated verbatim, including `!!js` expressions):

```yaml
- id: preset-standard
  name: "@deepseek-ai/dsh-agent-preset"
  config:
    id: standard
    order: 1
    plugins:
      - id: persona
        name: "@deepseek-ai/dsh-persona"
        config:
          prefix: You are a coding agent powered by the {{model}} model.
      # … unchanged shipped rows …
      - id: compaction
        name: cordis:group
        group: true
        isolate:
          compaction: true
          toolResultPruner: true
        config:
          - id: dsh-memory-cloud-brain:engine
            name: dsh-memory-cloud-brain/engine
          - id: compaction-basic
            name: "@deepseek-ai/dsh-compaction-basic"
            disabled: true
          - id: command-compact
            name: "@deepseek-ai/dsh-command-compact"
          - id: tool-result-pruner
            name: "@deepseek-ai/dsh-compaction-tool-result-pruner"
            config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
      # … unchanged shipped rows …
```

Rules for the implementation:
- Transform `current` (keeps user edits); restore with `inherited`. Record the inherited config hash at takeover time in `state.json`; on startup, if the override equals `takeOver(storedInherited)` but the current inherited differs, re-apply `takeOver(newInherited)` (keeps up with DSH upgrades); otherwise report "customized/stale" in `/memory status`.
- Only new sessions use the new preset revision; existing sessions keep theirs. Other presets (`ptc`, `minimal`, `cordis`) have their own compaction groups and need the same treatment if desired.
- The engine row needs a package export `./engine` (and a tsdown entry `lib/engine.js`); in the spike an absolute file path was used. Preset rows resolve from the profile directory (`baseUrl file://…/profiles/web/`) [runtime], and the preset realm isolates only `compaction`/`toolResultPruner`, so the engine can `inject` a host-level memory service [source, not run].
- Subagents join their parent's preset revision (`composeFrom`), so the engine also compacts subagent sessions: fall back to `super.summarize()` when `agent.session.header.origin === 'subagent'`.
- `configEditor.edit` rejects values overridden by a higher layer (home patch, `--patch`) — surface that error.

### 2.3 Rejected / secondary paths

- **Bundle override of `preset-standard`** (§2.1 row 3): works but freezes a copy of DSH's preset inside our package; fragile across upgrades and conflicts with other preset-editing bundles. Rejected.
- **Bundle-inserted preset row** (`- insert: [{id: preset-memory-cloud, name: '@deepseek-ai/dsh-agent-preset', config: {id: memory-cloud, …}}]`): supported (`compositions.md`), selectable per session or as default via the registry's volatile `selectedDefault`, but must restate the full plugin list too and users must switch presets. Keep as an option, not default.
- **Instance hook** (replace `summarize` on the preset's `BasicCompactionEngine` instance from `agentPresets.serviceFor`): would work technically (the hook is dynamically dispatched) but is monkeypatching and cannot apply level thresholds. Rejected.
- **Host-level (headless/sdk) takeover**: base inserts host-level `compaction-basic`. A bundle may ship `- insert: [{id: dsh-memory-cloud-brain-engine, name: dsh-memory-cloud-brain/engine, disabled: true}]` (no `:` in a top-level id: `EntryTree.resolve()` splits ids on `:`, `cordis-plugin-loader/src/config/tree.ts:88-116` [source]) and the takeover action toggles rows with `ctx.pluginManager.setPluginEnabled('compaction-basic', false)` + `('dsh-memory-cloud-brain-engine', true)` (`dsh-plugin-manager/src/index.ts:929`; headless has no HMR, so expect `restart-required`) [source only]. Do **not** ship the engine row enabled: in preset profiles its global `agent/pre-step` listener would also compact preset agents. A `disabled: !!js` guard is evaluated at mount decisions only (`cordis-plugin-loader/src/config/entry.ts:91`), so it cannot reliably wait for `agentPresets`.

## 3. Events (`@deepseek-ai/dsh-session/src/index.ts:43-88`, `@deepseek-ai/dsh-agent/src/runtime-types.ts:275-431`)

All agent/session events use scope-filtered dispatch: listeners registered on a host (global) context receive every agent/session; listeners registered inside a preset or on `agent.ctx` receive only theirs [source; host-level probe saw all events at runtime].

| Event | Mode | Payload |
|---|---|---|
| `session/created` | emit | `(session)`; `session.header` = `{version: 4, id, createdAt, cwd?, parentSession?, isSeeded, origin?: 'subagent', delegationDepth?, agentPreset?}` (`dsh-session/src/types.ts:95-136`). Headless header had no `agentPreset` [runtime]. |
| `session/event` | emit, post-commit, failures contained | `(session, event)`; `event = {type, seq, time, data, surfaceOp?, sourceEventSeqs?, ignorable?}` (`types.ts:506-529`). Seen types include `permission/preset`, `sandbox/mode`, `approval/policy`, `agent/inbox/spliced`, `turn/start`, `step/start`, `system/message`, `user/message`, `request/header`, `request/context`, `assistant/message`, `assistant/attempt`, `tool/call`, `tool/result`, `step/end`, `compaction/*`, `session/title`, `session/title-llm-request`, `turn/end` [runtime]. |
| `turn/end` (event type) | — | `{turn, reason}`; `reason.kind ∈ completed \| aborted{reason: user\|parent\|hook\|disposed\|legacy} \| blocked \| error{error} \| max-tokens \| interrupted \| forked` (`types.ts:206-238`). Normal run: `{kind:'completed'}`; process killed: `{kind:'aborted', reason:{kind:'disposed'}}` [runtime]. |
| `session/flush` | parallel, awaited | `(session)`. Fires **very often** (per request checkpoint; ~3 per step observed) — keep handlers cheap/idempotent. |
| `session/disposed` | emit | `(session)`; fired at shutdown [runtime]. |
| `agent/created` | serial, awaited | `{agent, source: 'startup' \| 'resume' \| 'clear' \| 'compact', signal?}`. Must not await `agent.whenIdle()`. |
| `agent/status` | emit | `{agent, status: 'idle' \| 'running'}` — `idle` after `turn/end` [runtime]. Do not poll it. |
| `agent/pre-step` | waterfall | `({agent, messages, turn, step, signal, modelSelection}, next) => Promise<PreStepDecision>`; `PreStepDecision = {kind:'reject'} \| {kind:'enter', messages: UserMessage[], startsRequestSeries?: true}` (`runtime-types.ts:139-146`). Always `await next()` and spread: `{...decision, messages}`. |
| `agent/turn-stopping` | serial | `{agent, turn, signal}`; awaited before the turn closes; `agent.steer()` reopens. |
| `agent/request-error` | waterfall | `({agent, turn, step, provider, failure: LlmFailure, retryPolicy, signal}, next) => Promise<{kind:'retry'} \| undefined>`; must return `next()` when not owning recovery. |
| `agent/disposed`, `agent/error`, `agent/assistant-stream`, `agent/inbox/*` | emit | see `runtime-types.ts`. |
| `agent-preset/selected` | emit | `(sessionId, agentPreset)`; emitted by `dsh-agent-preset-registry` when a session commits a different preset (§8 fact 11) [source]. |

There is no "session ended" event (confirmed). Subagent detection: `session.header.origin === 'subagent'` (plus `delegationDepth`, `parentSession`); ordinary forks have no `origin`.

**Appending a memory message with a custom source** [runtime]:

```ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'memory-cloud': { kind: 'memory-cloud' } & ContextFormed }
}
ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
  const decision = await next()
  if (decision.kind !== 'enter' || decision.messages.length === 0) return decision
  const memory = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'memory-cloud', form: 'recall' } })
  const at = decision.messages.findLastIndex(m => messages.includes(m))
  return { ...decision, messages: decision.messages.toSpliced(at + 1, 0, memory) }
})
```

`Session.append` only requires a non-empty `source.kind` for user messages. `ContextForm` (`dsh-llm/src/message.ts:55`) values: `instructions | catalog | snapshot | notice | relay | recall`. Placement after the claimed batch mirrors `dsh-agent-instructions` (prompt first, our block, then the driver-appended `runtime-context`). Detect presence with `agent.session.surface.nodes` + `session.eventAt(seq)`; the block is shadowed by the next compaction (it falls inside the replaced region) and our spike re-injected it on the following step [runtime]. `agent.inject(message)` is the alternative channel (logged as `agent/inbox/spliced`, does not wake the agent).

## 4. Other host APIs

**System prompt** (`dsh-system-prompt/src/index.ts:53-90, 485, 520`): `ctx.systemPrompt.section({name, order, text: string | (ctx) => string, interpolate?: boolean /*default true*/, complete?})`; `ctx.systemPrompt.context({name, order, text, interpolate?, required? /*kept when runtime context is suppressed*/})`. Contexts are materialized by the loop as one `user/message` with source `{kind:'runtime-context', form:'snapshot', sections}` that is **re-sent whole whenever any section changes**, and re-sent after a compaction shadows it (`dsh-agent-loop/src/runtime-context.ts:125-180`). A section change re-renders the system prompt (routes declaring `systemPromptUpdate: 'in-history'` append a new system node, others rewrite node 0 — `runtime-context.ts:74-114`), costing the prefix cache. Use a byte-stable `section()` with `interpolate: false` for usage text (registration verified at runtime; literal braces preserved per source). `getSectionOrder/getContextOrder(name)` give the central placements.

**Tools** (`dsh-tools`): `ctx.tools.register(definition, {when?})` throws unless `output: {schema, render, presentationMeta?}` is present (`src/index.ts:128-136`). `defineTool({name, description, parameters: {field: {type, required, description, …}}, output: {schema: {type:'object', additionalProperties:false, properties:{…}}, render(args, value): ContentBlock[]}, execute(args, exec) => value, timeoutMs?, isConcurrencySafe?, presentCall?, presentResult?})` (`src/schema.ts:555`). Registered at host level the tool appeared in requests (24 tools incl. `spike_echo`) and executed [runtime]. `ctx.tools.restrict({allow?, deny?})` on an agent's context masks global tools for that agent, so host-registered tools like ours are subject to a room plugin's restriction [source; qq-rooms itself not inspected].

**Commands** (`dsh-commands/src/index.ts:41-78`): `ctx.commands.register({definitionId?: CommandDefinitionId(…), name: 'memory', description, input?: {hint}, recordInput?, handler: ({commandId, agent, rawInput, attachments, signal}) => CommandResult})`, `CommandResult = {kind:'success', text?, sourceEventSeq?} | {kind:'error', text}`. Wrap in `ctx.effect` and drain in-flight handlers on dispose (pattern: `dsh-command-compact/src/index.ts`). Registration verified [runtime]; invocation not exercised (headless has no slash-command input).

**LLM** (`dsh-llm`): `ctx.llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>` (`src/index.ts:1185`, wrapped by the `llm/stream` waterfall, adapter errors become a terminal `finish`). `GenerateOptions` (`src/types.ts:564-606`): `provider, model, reasoningEffort?, messages: RequestMessage[] /* Message | {role:'user', content} */, system?, tools?, toolHistory?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose?`. Read results with `new BlockAssembler()`: `push(chunk)` per chunk, then `.finish` (`{kind:'stop'|'tool-calls'|'max-tokens'|'error'|'aborted', failure?}`), `.blocks()`, `.usage`. Purpose: `declare module '@deepseek-ai/dsh-llm/types' { interface LlmRequestPurposeMap { 'memory-cloud-summarize': true } }` (same as `session-title`, `auto-review`). [runtime] side call with `system`, one user message, `maxTokens`, `purpose` returned text via the assembler. `ctx.llm.resolveModelInfo(provider, model, signal?)` → `{provider, id, name, context?: {contextWindow}, defaultMaxTokens?, reasoning?: {efforts, defaultEffort?}, …}` (`src/index.ts:775`). Adapters: `ctx.llm.registerAdapter(['fake'], new (class extends LlmAdapter { resolveModel(); stream(); listModels() }))` (`src/index.ts:416`) — used for the spike's fake model.

**Token meter** (`dsh-token-meter/src/index.ts:122-221`): `measure(session, header?) → {totalTokens, surfaceTokens, nodes: [{seq, tokens, heuristicTokens}], baseline: none|estimated|usage}` (provider usage anchor + 4-char heuristic deltas); `contextPressure(session) → {pressureTokens?, contextWindow?}` from logged usage/request context (`{}` before the first request, `{contextWindow}` after, `pressureTokens` only once an adapter reports usage) [runtime]; `estimateMessage(message)`. CJK is underestimated by the 4-char rule.

**Session-log upload exclusion** (`dsh-session-log-deepseek/src/index.ts:187-280`): `ctx.sessionLogDeepSeek.registerExclusion(req => req.purpose === 'memory-cloud-summarize')` returns an effect disposer (inject optionally: `ctx.inject(['sessionLogDeepSeek'], …)`) [runtime: registered]. Upload only happens for requests carrying `sessionId`; a summarizer call without `sessionId` uploads nothing.

**Default model / paths / profile**: `ctx.agentDefaultModel.currentSelection() → {provider, model, reasoningEffort?}` (volatile config) [runtime]; `resolveDshHome()`, `dshHomePath(...segments)` from `@deepseek-ai/dsh-home-paths` (`$DSH_HOME` → `~/.dsh`); `ctx.get('profileContext')` → `{name, dir, patchPath, installAnchor, cwd, home, startedBundles, overlays, …}` (`dsh-app-boot/src/profile-context.ts:15`; `home` = DSH home [runtime]). `!!js dshHomePath('…')` is valid inside row config.

**Volatile config** (`cordis-plugin-loader/src/config/entry.ts:156-210`, cookbook `adding-a-settings-card.md`): `z.x().volatile()` fields arrive as `Volatile<T>` (`.get()`); a change touching only volatile fields updates refs in place and emits `loader/volatile-update(paths)` to the owning fiber; anything else restarts the plugin. Volatile detection uses `Symbol.for('cosmokit.volatile.write')`, so our own `@deepseek-ai/schemastery` copy interoperates. [runtime, web] `ctx.settings.update('dsh-memory-cloud-brain', {level: 5})` → same fiber uid, `level.get() === 5`, profile patch `config: {level: 5}`.

**Other useful host services**: `@deepseek-ai/dsh-atomic-write` `writeFileAtomic(path, content, {mode})` + `withFileLock(path, op, {waitMs, signal})` (cross-process `<file>.lock`, PID takeover) for the store; `ctx.sessionQuery.readSession(id)` / `listEvents(id)` (`dsh-session-query/src/index.ts:196, 281`) for `/memory backfill` — persisted logs are multi-frame zstd JSONL (`sessions/<cwd>/<id>/session.v4.jsonl.zstd`); Node's `zlib` only decoded the first frame, so do not parse them directly.

## 5. Client settings form

- Package manifest: `dsh.client: {platform: 'web', inject: [...]}` + `exports["./client"]`; the browser half attaches to the Loader row whose name is the bare package name. Bundle file format: `window.__ModuleLoader__.load({id: '<package name>', factory(require) { …; return exports }})`, externals resolved by `require('react')`, `require('react/jsx-runtime')`, etc. [runtime: the web index lists `dsh-memory-cloud-brain/client.js` and the served combo contains our factory].
- Slots (`dsh-client-ui-plugin-manager/src/client/slot-contract.ts:126-180`): `plugins.bundle.config` (keyed by package name, `view: 'page'` only, owner props `{view, form?}`; bundle pages get **no** host form) and `plugins.row.config` (keyed `<package>#<row id>`, host supplies `form.state` / `form.mutate(ops, expectedRevision)` when the row has volatile fields).
- Injected services used by DSH's own registrants: `slots`, `locale`, `configForms`, `remote` (`dsh-experimental-client-ui-cot-translation/src/client/mount.ts`): `ctx.configForms.get<T>('<row id>')` returns the host-backed form scope; `ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({name: 'plugins.bundle.config', key: '<package name>', locale: NS, inject: () => face}, Component))`; `ctx.locale.register(NS, {en, zh, …})`.
- Host side (`dsh-settings/src/index.ts:302-424`): descriptors include only volatile fields (`volatileForm(schema)`), `ns` = row id; writes go through `configEditor.edit`. Our row's descriptor value [runtime]: `{level, compactionMode, idleMinutes, idleCompactRatio, halfLifeDays, maxEpisodeTokens, captureReasoning, summarizer:{…}, overrides, scopeRules}` (`storageRoot` excluded as non-volatile). An auto-generated form is shown unless the plugin calls `ctx.settings.configure({auto: false})`.
- Guidance (`dsh-doc/references/practices.md`): do not `require('@deepseek-ai/dsh-client-ui-primitives')` from third-party plugins; style with `--dsw-alias-*` tokens; React components in slots only.
- **No auto form in the Web UI** [runtime, 0.2.2-rc.5]: `autoGenerate` reaches the settings descriptor, but no client package renders it. The Plugins page gives a row a configure control only when something registers `plugins.row.config` for `<package>#<row id>`; our row showed none.
- **Remote (browser → host)** [runtime]: host `@deepseek-ai/dsh-api-gateway` (`ctx.typertGateway`) claims `/api/<namespace>/<method>`. Strict endpoints come from generated `typert.host`/`remote` artifacts (`dsh-typert-generator`, not available to third parties); otherwise **SRC mode** scans services whose value has a `typertRemote` binding (`bindTypertRemote(obj, serviceKey, {namespace})` or `TypertRemoteService`, `@deepseek-ai/dsh-typert-protocol`) and `@Remote` markers on the prototype, reads parameter names from `Function.prototype.toString` (plain identifiers only; a final `signal` is the cancellation slot; names equal to a lookup's `parameter` — `session`, `agent`, `workspaceFileScope` — become lookups), checks JSON safety only, and calls the method. A plain object given to `ctx.provide()` works. Our tsdown cannot lower standard decorator syntax, so `Remote` is applied through the decorator protocol by hand (`src/runtime/remote.ts`). Client: `ctx.remote.$mount({package, descriptors})` (`dsh-api-gateway/client`) accepts hand-written descriptors; every client-supplied parameter needs `codec: {mode: 'strict', typeSymbol, create: () => ({parse})}` (`TypertSchema` is structural; no zod needed), results may stay `{mode: 'src-json'}`; methods return `RemoteResult` and are reached via `ctx.inject(['remote.<namespace>'])`. Non-owner peers go through `remoteAccess.decide`. Linked plugins resolve imports of their declared **peer** names from the DSH runtime table, so `@deepseek-ai/dsh-typert-protocol` is a peer (shares DSH's Cordis).

## 6. Runtime spike

Setup: `npm install @deepseek-ai/dsh@0.2.2-rc.5` into `/tmp`, throwaway `DSH_HOME`, fake `HOME`, `env -i` (no inherited credentials), `DSH_TELEMETRY_DISABLED=1`. Test plugins were inserted with `--patch overlay.yml` (relative `name: ./x.mjs` resolves beside the overlay). All `/tmp` material was deleted afterwards.

1. **Fake LLM adapter**: `registerAdapter(['fake'], adapter)` with `resolveModel → {context: {contextWindow: 20000}, defaultMaxTokens: 1000}` and a scripted `stream` (6 `spike_echo` tool calls, then text); `agent-default-model` overridden to `fake/fake-1`.
2. **Probe plugin** (host level): logged services and every event listed in §3; registered a tool, `/memory` command, `interpolate:false` section, upload exclusion; injected a `memory-cloud` message at pre-step; called `compactNow` on idle; made a `purpose` side call at `turn-stopping`.
3. **Engine subclass** replacing the headless `compaction-basic` row (`- id: compaction-basic, disabled: true` + insert), config `{headroomTokens: 1000, retainTokens: 1500, maxTokens: 1000, spikeMode}`, overriding `compactIfNeeded` (threshold swap) and `summarize`.

Results (`dsh --profile headless --patch … "please run the echo tool"`):
- `ok`: three automatic pressure compactions (`turn: 1`) and one idle `compactNow` (`turn: null`) all called our `summarize()`; checkpoints carried our text; exit 0, answer printed.
- `fallback`: `super.summarize()` produced the DSH summary through a `purpose: 'compaction'` call.
- `throw`: `compaction/end {error}` four times, turn completed, `compactNow` → `ManualCompactionError` code `summary`; exit 0.
- Built package: `dsh plugin --profile headless add <repo>` and `--profile web add <repo>` (pnpm link) → bundle accepted (engines range OK), row `dsh-memory-cloud-brain` ACTIVE with schema defaults; web settings update applied live; browser half served.
- Web: configEditor takeover/restore (§2.2).

Not verified: real DeepSeek requests, `prompt_cache_hit_tokens` behaviour of the injected block, Desktop profile composition (closed `app.asar`), QQ/WeChat bridge session metadata (no bridge plugins installed; `SessionHeader` itself has no tag field), `/memory` invocation through a UI, `pluginManager.setPluginEnabled` takeover for headless, the engine as a profile-installed `dsh-memory-cloud-brain/engine` export inside a preset (spike used an absolute path). The last two, and `/memory` through `ctx.commands.execute`, were verified later (§8).

Spike engine (reproduction reference):

```js
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import z from '@deepseek-ai/schemastery'
export default class SpikeMemoryEngine extends BasicCompactionEngine {
  static Config = z.intersect([BasicCompactionEngine.Config, z.object({ spikeMode: z.union(['ok', 'fallback', 'throw']).default('ok') })])
  constructor(ctx, config = {}) { const { spikeMode, ...basic } = config; super(ctx, basic); this.spikeMode = spikeMode }
  async compactIfNeeded(agent, trigger, signal) {
    const header = agent.session.requestHeader()
    if (header) {
      const info = await this.ctx.llm.resolveModelInfo(header.config.provider, header.config.model, signal)
      this.config = { ...this.config, thresholdRatio: Math.min(1, 9000 / info.context.contextWindow) }
    }
    return super.compactIfNeeded(agent, trigger, signal)
  }
  async summarize(input, agent, signal) {
    if (this.spikeMode === 'throw') throw new Error('spike summarizer failure')
    if (this.spikeMode === 'fallback') return super.summarize(input, agent, signal)
    return { summary: [{ type: 'text', text: '<memory-cloud>…</memory-cloud>' }], provider: 'fake', model: 'fake-1' }
  }
}
```

## 7. Design adjustments forced by these facts

1. **Checkpoint size** (§3.4/§3.1A): the engine-mode memory block must satisfy DSH's shrink guard — cap the checkpoint at a fraction (e.g. ≤ 50%) of the replaced region's character length / 4, in addition to M. Idle `compactNow` over a short tail with a 24K block would otherwise fail every time. When the cap is below a useful block, fall back to a compact "ongoing + pointers" checkpoint or skip the idle compaction (gate on `idleCompactRatio` before calling `compactNow`).
2. **Checkpoint framing**: DSH always wraps our text in its English preamble and `<compacted-summary>` tags; the `<memory-cloud>` block nests inside. Engine mode cannot emit a bare memory block.
3. **Absolute thresholds** (§3.7): convert per routed model at call time (`thresholdRatio = T/W`), and pass a small `headroomTokens`; validate `retainTokens < thresholdTokens` ourselves to avoid `TargetPressureConfigError` (which silently disables pressure compaction for that model). Level 1 maps to the host defaults.
4. **Web engine mode is opt-in**: it needs the configEditor takeover (explicit user action, new sessions only, preset copy refreshed on upgrade). `compactionMode: auto` therefore resolves to assist mode on a fresh Web install; `/memory status` should offer the takeover.
5. **No host-level engine row by default**; headless/sdk takeover toggles rows via the plugin manager.
6. **Capture filters**: compaction regions contain earlier `compact-checkpoint` messages, `runtime-context` snapshots, and our own injected block; capture/summaries must skip those source kinds (plus subagent sessions by `header.origin`).
7. **Assist-mode refill** works as designed: the injected block is shadowed by compaction and can be re-appended at the next `agent/pre-step`.
8. **Settings page** can only edit volatile fields; `storageRoot` (ordinary) changes need the profile patch and a restart. Takeover/restore needs a host Remote or command, not the config form.
9. **Privacy**: either omit `sessionId` from summarizer calls (no upload at all) or keep it and register the purpose exclusion; omitting `sessionId` also drops DeepSeek's session header (cache/routing effect unknown — measure in phase 6).
10. **Backfill** must read old sessions via `ctx.sessionQuery`, not by decoding `*.jsonl.zstd` files.

## 8. Runtime verification (E2E)

Run on 2026-11-23 against an npm install of `@deepseek-ai/dsh@0.2.2-rc.5` (Node 26, macOS), with the built package installed by `dsh plugin --profile headless|web add <repo>` (a pnpm `link:`), `env -i` + fake `HOME` + throwaway `DSH_HOME` + `DSH_TELEMETRY_DISABLED=1`, and a scripted fake adapter loaded with `--patch`. Repeat it with `node scripts/e2e/run-e2e.mjs` (see `scripts/e2e/README.md`).

| Scenario | Result |
|---|---|
| 1 Headless engine mode | Pass after fixes. `api.takeover()` → plugin manager `restart-required` (`no-hmr`), profile patch `{ id: compaction-basic, disabled: true }` + `{ id: dsh-memory-cloud-brain-engine, disabled: false }`. On a 32K window a 16-step turn gets 2–3 pressure compactions plus idle `compactNow`; every checkpoint in the session log is a `<memory-cloud>` block; compaction episodes have `raw.jsonl`/`summary.md`/`gist.md`, `summarizer.jsonl` shows `checkpoint-summary` + `checkpoint` and no `episode` entry for them (one replay call per compaction, no second call); the turn and later resumed turns continue. Before the fix, pressure compaction never fired (see fact 2). |
| 2 New session | Pass. One `memory-cloud` message per request; distant episodes as one-line gists, the `recentSummaryCount` newest as summaries (only once stored memory exceeds the block budget — below it the packer upgrades everything to summaries); `memory_read #id` → summary, `level: raw` → original prompt text, `memory_search` finds the id. |
| 3 Level change | Pass after fix (`setLevel` was rejected, fact 1). `api.setLevel(5)` → `ctx.settings.update`, live in the running process (also headless) and persisted as `config: {level: 5}`. 128K window: threshold 104 857 → 32 768 (level 3 now inherits level 1's `0.8W` through the monotonic ladder; the first run measured 120 880 = `W − O − H` before the ladder existed), M 24 576 → 6 144; the same 14-step turn compacts only at level 5. The new-session block sizes of the first run (23 219 → 6 856 chars) predate the ladder and the prompt changes and were not re-measured here. The level-5-block-larger-than-level-3 anomaly on ≤ 48K windows no longer exists: every value is capped by the level below (`src/pack/budget.ts`). |
| 4 Summarizer failure | Pass. `throw` and `garbage` (one stricter retry): compose-error → `super.summarize()` (`purpose: compaction`), checkpoint is compaction-basic's text, turn completes, exit 0; episode `failed`, `attempts: 1`, re-queued 30 s later and summarized on a later run. |
| 5 Assist mode | Pass. After `api.restore()` compaction-basic compacts; the shadowed block is re-injected (`refill`) at the next pre-step; compaction episodes are summarized in the background (`episode` entries). |
| 6 Web | Pass. Bundle accepted, `dsh-memory-cloud-brain/client.js` listed in the web index; preset sessions are assist (`BasicCompactionEngine`); `api.takeover()` (configEditor) mounts `dsh-memory-cloud-brain/engine` in the new `standard` generation; a new session compacts through it with memory checkpoints and no second call; `api.restore()` removes the override. |
| 7 Shutdown | Pass after fixes. SIGINT exits in ~1 s (code 130); open episodes sealed `end` and queued with `attempts: 0`; no store locks left; no unhandled rejections. |

Not exercised: real DeepSeek requests and `prompt_cache_hit_tokens`, the Desktop profile, the settings page UI (the client bundle is served, but the page was never rendered in a browser), a packed-tarball install (peers resolved from the profile rather than the linked repo), `refreshAfterUpgrade` against a real DSH upgrade.

Bugs found and fixed: (1) settings namespace used `entry.id`; (2) level retain exceeded the meter's heuristic surface so no range was ever selected; (3) jobs run during shutdown failed (`no provider/model route`), burning retries and tripping the breaker; (4) detached `onSealed` writes were cut off by the process exit, leaving an empty `state.json.lock` that dsh-atomic-write never takes over — every later state write timed out; (5) episode ids carried the constant tag `session-`.

Newly verified or corrected facts:

1. **Row ids.** A bundle-inserted row's fiber has `entry.id === 'include:<id>'` (nested tree path) and `entry.options.id === '<id>'`. `ctx.settings.update(ns)` and `configEditor.entries()` key rows by `options.id`; `pluginManager.listPlugins()` reports `entryId: 'include:<id>'`, `patchId: '<id>'`.
2. **Retention vs pressure (corrects §1.2).** `tokenMeter.measure()` returns `totalTokens` = provider-usage baseline + heuristic deltas, but `nodes[].tokens` are the fixed 4-chars/token heuristic, and `selectCompactableRange` keeps nodes until their *heuristic* sum reaches `retainTokens`. Chinese is priced at ~0.4× its usage size, so a real-token retain can exceed the whole priced surface: the range is `null` and pressure compaction silently never runs (no warning). The engine now rescales retain into meter prices and caps it so M + tail + request overhead (system prompt + tools, ≈ 10K tokens in headless) stays under 0.6 T. Stock compaction-basic shows the same gap in assist mode: with CJK and default `retainRatio` it compacts one step at a time and logs `summary is not smaller than the shadowed content` on the next attempt. Right after a compaction `measure()` overstates pressure until the next usage report (the anchored delta subtracts heuristic, not real, tokens).
3. **Shutdown order.** `session/disposed` fires first with all services alive; then the tree is torn down and `ctx.get(name)` (strict) returns `undefined` for services whose fibers are disposing (e.g. `agentDefaultModel`) while our disposer runs; DSH awaits plugin disposers and exits ~20–30 ms later, cutting off any detached promise. Headless disposes the session at the end of every task, so each headless process seals one `end` episode.
4. **dsh-atomic-write.** `withFileLock` takes over a lock only when it holds `<pid>\n` of an exited process; an empty or partial record is "being written" forever. A writer killed between creating `<file>.lock` and writing its PID therefore blocks the file until the lock is deleted by hand. `writeFileAtomic` leaves `<file>.<hash>.tmp` behind when interrupted (harmless). Our store now clears partial lock records older than 5 s before locking.
5. **Commands without a UI.** `ctx.commands.execute(agent, '/memory status', [], signal)` runs a slash command host-side and returns `{result: CommandResult}` (verified `/memory status`, `/memory rebuild`).
6. **Headless takeover** through `pluginManager.setPluginEnabled` works as documented in §2.3 (`restart-required`, flow-style patch entries); restore removes the entries again.
7. **Preset engine resolution.** `dsh-memory-cloud-brain/engine` resolves from the profile inside the preset realm. `agentPresets.inspectCompositions()` returns one `{id, modules: [{moduleName, baseUrl?, useHostBase}]}` per live generation; generations used by existing sessions stay listed after takeover and restore.
8. **Web preset sessions** add another synthetic user message (a time sample whose `source.kind` is not `user`) and record `header.agentPreset: 'standard'`. `sessionController.create({cwd})` and `.prompt({requestId, sessionId, mode: 'queue', content: [{type: 'text', text}]}, signal)` can be called host-side to drive sessions.
9. **Misc.** `ctx.on('ready')` registered by a plugin mounted after startup never fires. Plugin loggers print nothing to headless stderr; `ctx.root.logger.exporters` is the place to capture them. `zstd -dc` decodes the multi-frame `session.v4.jsonl.zstd` fully; in-process, `session.eventAt(seq)` for `0 ≤ seq < session.seq` reads every logged event, shadowed ones included. DSH session ids all start with `session-`. On web shutdown DSH logs `agent/disposed listener threw: TypeError: … reading 'catch'` with or without this plugin (DSH-internal).
10. **Known limitations.** A resumed headless session's compaction region spans earlier `end`-sealed episodes, so the checkpoint summary is not stored for the open episode (a background summary runs for it instead) and the checkpoint's fresh entry repeats facts already in those episodes' summaries. The archive still stores `runtime-context` reminders, but `memory_read level: raw` no longer shows them by default: it lists only user messages whose source kind is `user` (or missing), assistant messages and tool results, and reports the rest as `hiddenRecords`. `includeSystem: true` shows every stored record (`user[runtime-context]`, checkpoints, injected blocks, log events), and offsets then count every record.
11. **`agent-preset/selected` event** [source, `dsh-agent-preset-registry/src/types.ts:66`, `index.ts:77`]. It is an emit event, `(sessionId, agentPreset)`. The registry re-emits it from the `agent-preset/selected` session event, which `agentPresets.select(agent, id)` appends once it has recomposed the agent's preset; `select` is refused once the session has started a turn. We use it to recompute the cached compaction mode of that session, because its compaction service may have changed.
12. **Unknown context window** [source, `dsh-llm/src/types.ts:454`]. `LlmResolvedModelInfo.context` is optional ("when known"). When it is missing or `resolveModelInfo` fails, the plugin assumes W = 32 768 (`FALLBACK_CONTEXT_WINDOW`) for the block, recall limit and status, and reports `capacity.known: false`. Failed lookups are retried after 30 s; successful ones are cached for 10 min. The engine maps no thresholds for such a model, so compaction-basic's own row config applies.
