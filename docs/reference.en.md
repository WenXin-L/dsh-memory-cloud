# Memory Cloud: usage and configuration

[Back to project overview](../README.en.md) · [中文手册](reference.md)

Brain-like layered long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that can also act as DSH's context compaction engine. It is built for long-running companion agents, such as the 大肥鱼 ("big fat fish") scenario: a persistent persona that lives in a home session and in chat rooms.

- **Lossless raw archive**: session events are appended to local files. They are never rewritten or deleted.
- **A gist and a summary per episode**: conversations are cut into *episodes*. Each episode gets a highly compressed **gist** ("this happened") and a normally compressed **summary** ("what happened").
- **Distant as gists, recent as summaries**: at session start and after every compaction, a `<memory-cloud>` block is injected. It holds the profile, distant gists and recent summaries.
- **Originals on demand**: the model looks things up with `memory_search` / `memory_read` and pages through the raw transcript when it needs exact words.
- **Doubles as the compaction engine**: once it takes over, DSH's compaction checkpoint *is* the memory block, and the replaced span is sealed as an episode at the same time.
- **Adjustable compression**: five levels that you can switch at any time; changes apply live.

> Current source version: `0.1.0` (preview); see the [changelog](../CHANGELOG.md) (in Chinese). It is not on npm yet, and DSH itself is still a developer preview. It has been tested end-to-end only on DSH `0.2.2-rc.5` with a fake model. See [Limitations and what is not verified](#limitations-and-what-is-not-verified).

## Contents

- [How it works](#how-it-works)
- [Install](#install)
- [Enabling engine mode (compaction takeover)](#enabling-engine-mode-compaction-takeover)
- [Settings](#settings)
- [Tools and commands](#tools-and-commands)
- [Storage on disk](#storage-on-disk)
- [Privacy](#privacy)
- [Coexistence with other memory and compaction plugins](#coexistence-with-other-memory-and-compaction-plugins)
- [Limitations and what is not verified](#limitations-and-what-is-not-verified)
- [Development](#development)
- [License](#license)

## How it works

### Tiers and data flow

```
                 ┌──────────── context (working memory) ────────────┐
 session events ▶│ system prompt · <memory-cloud> block · recent raw │
   │             └──────────────────▲─────────────────────┬────────┘
   │ capture                         │ inject at session    │ compaction, idle, session end, size
   ▼                                 │ start / after compaction
 raw.jsonl (append-only)        packer (budgeted) ◀──── episode sealed
   │                                 ▲                     │
   │ memory_read level:raw           │                     ▼ one model call
   │                       profile.md (hand-written)  summary.md (recent tier)
   │                       rollups/ (week → month) ◀── gist.md (distant tier)
   ▼
 model recalls on demand
```

| Brain analogy | In the plugin |
|---|---|
| Working memory | The recent raw text kept in context |
| Recent memory | **Summaries** of the latest episodes |
| Distant memory | **Gists** of older episodes, plus week/month **rollups** |
| Recallable archive | The raw `raw.jsonl` files |
| Lasting impressions | An optional hand-written `profile.md` (names, preferences, agreements) and preferences saved with `memory_note` in a private owner chat |

The unit of memory is the **episode**, not the DSH session, because a companion's home session may never end. The open episode is sealed when any of these happens:
- a compaction replaces it;
- the session has been idle for `idleMinutes` (default 30);
- the session is disposed;
- its raw text exceeds `maxEpisodeTokens` (default 32768; 0 turns size-based sealing off).

A sealed episode is summarized in the background (prompt version `memory-cloud-summary/2`):
- the summary keeps names, dates, numbers, preferences, negations, state changes and either side's promises, in sections "what happened / promises and to-dos / key facts / emotions and relationship" (empty sections are left out);
- transcript timestamps carry the Chinese weekday, and relative dates ("next Wednesday") are converted to absolute dates from the time they were said;
- the episode also gets an importance from 1 to 10 and keywords, and `summary.md`'s frontmatter records people, dates and promises;
- list entries where the model copied a template placeholder (`…`, `<…>`, "(one item per line…)" and the like) are dropped.

**Packing** the memory block is pure computation, with no model call:
- **Tier quotas**: profile 10% → recent summaries 55% → distant gists 35%. Unused quota rolls forward to the next tier. Compaction checkpoints also get a small "ongoing items" budget.
- **Agenda in the profile section (相处档案)**: after the hand-written profile lines and saved preferences come the still-open promises and upcoming dates, taken from the promises and dates in each episode's `summary.md` frontmatter, at most 8, soonest first. They share the profile quota with `profile.md`, and the agenda is admitted first:
  - promises with a due date of today or later;
  - promises without a due date, while their episode is at most 30 days old;
  - dates from today to 90 days ahead.

  Each line carries the Chinese weekday and the episode id, e.g. `- 约定（AI，截止 2026-11-25 周三）：提醒小林打包 #…`.
- **Who gets a summary**: the newest `recentSummaryCount` episodes go first. The rest are ordered by pin, then by retention score. Each gets a summary while the recent tier has room; otherwise it drops to a one-line gist.
- **When the distant tier overflows**: rollups replace gists first. If it still does not fit, the lowest-scoring entries are dropped and one line remains: "N earlier episodes, search with memory_search". A single entry is never truncated.
- **Format**: every entry carries a date and an episode id (`#20261120-2130_ab12cd34_1`). The block is labelled as historical data, not instructions.

### Engine mode and assist mode

| | Engine mode `engine` | Assist mode `assist` |
|---|---|---|
| Who compacts | This plugin's `MemoryCompactionEngine`. It extends DSH's `BasicCompactionEngine`, so selection, locking, commit and overflow retry are the host's own code | DSH's `compaction-basic` or another compaction plugin |
| Checkpoint | Memory block + the fresh episode summary + ongoing items | The host's own (coding-oriented) summary, left untouched |
| Memory after compaction | The checkpoint is the memory block; nothing extra is appended | The memory block is re-appended on the next step |
| What the level controls | Compaction threshold, retained raw tail, block size, recall limit | Only block size and recall limit; the host decides when to compact |
| Model calls | One call per compaction. It replays the replaced span the way the host does, to share the prefix cache, and the result is also stored as that episode's gist and summary | Background summary after the episode is sealed |

In engine mode, the plugin falls back to `compaction-basic`'s default summary when any step fails, when it times out (`composeTimeoutMs`, default 120 s), or when the block would exceed half of the replaced span. (DSH rejects checkpoints that are not smaller than the span; the plugin keeps a margin.) The episode is then summarized in the background, and DSH keeps running. Subagent sessions always get the default summary and are never captured.

`compactionMode`:

- `auto` (default): engine mode when this agent's compaction service is our engine **and** no other compaction plugin is detected; assist mode otherwise. A fresh Web/Desktop install lands in assist mode until you [take over compaction](#enabling-engine-mode-compaction-takeover).
- `engine`: asks for engine mode. It falls back to assist mode, with the reason shown, while the engine does not own compaction.
- `assist`: always assist mode.
- `off`: no memory injection, no memory checkpoints, no idle consolidation. Capture, background summaries and the recall tools keep working.

`/memory status` and the settings page show the effective mode per session and why it was chosen. The mode is decided again after a settings change, a takeover or restore, and when a session switches agent preset.

### Idle consolidation ("sleep")

When an agent has been idle for 20 s (any status change restarts the wait) and its context pressure is above `idleCompactRatio` (default 0.5), the plugin calls that agent's compaction engine's `compactNow()`. This moves compaction to a moment when nobody is waiting. Conditions:
- at most one attempt per agent every two minutes, and none within two minutes after any compaction finished;
- skipped when the compactable span is too short;
- never for subagents or in `off` mode.

It works in both modes: engine mode produces a memory checkpoint, assist mode the host summary. Separately, after `idleMinutes` the uncompacted tail is sealed as an episode without touching the context, so every complete conversation gets its gist and summary.

### Forgetting and recall reinforcement

Each episode has a retention score:

```
T = 0.5^(Δt / (h·S)) × (0.5 + I/20)
```

- Δt: days since the episode was last recalled (or since it ended);
- h: `halfLifeDays` (default 14);
- S: 1 + the number of recalls;
- I: importance (1–10).

Low scores slide from summary to gist, then into a rollup or out of the block. Reading an episode with `memory_read` (its summary, or raw records from the first page; later pages do not count again) adds 1 to S and refreshes the recall time, so the episode "warms up" in the next block. Forgetting only changes the injected tier; **no file is ever deleted**. `memory_pin` keeps an episode prominent, and `memory_hide` removes it from view (reversibly).

### Rollups

When the distant tier (gists plus rollups) exceeds its quota, a background job merges:
1. finished ISO weeks older than 7 days into week rollups (`rollups/2026-W47.md`);
2. months where at least two weeks have rollups into month rollups (`rollups/2026-11.md`).

Pinned, hidden and last-7-days episodes are never merged. When an episode is hidden after it was merged, the rollup that contains it and every month or year rollup built on top of it are no longer injected; the episodes in it that are still visible are packed one by one as usual instead. Rollups are never generated on the compaction path; compaction only reads the ones that already exist.

Background job limits:
- 5-minute timeout per attempt;
- exponential backoff from 30 s up to 30 min, at most 8 attempts. After that, an episode is left failed and a rollup is recorded as given up (`exhaustedRollups` in `state.json`); neither is re-queued automatically, and `/memory summarize-now` retries them;
- a circuit breaker for 30 min after 5 consecutive failures;
- a daily quota of 200 jobs.

## Install

**Requirements**:
- Node.js ≥ 24.9;
- DSH `>=0.2.2-rc.5 <0.3.0-0` (verified on `0.2.2-rc.5`);
- `pnpm` on `PATH`, because `dsh plugin add` uses it.

### Web / headless profiles (CLI)

The package is **not published to npm yet**. Once it is, install it by name:

```sh
dsh plugin --profile web add dsh-memory-cloud-brain
```

Until then, install it straight from GitHub (this path has not been run end-to-end yet):

```sh
dsh plugin --profile web add github:WenXin-L/dsh-memory-cloud
```

The repository has no built `lib/`, so pnpm runs the package's `prepare` script (`tsdown`) on the fetched source and installs the result. Since pnpm 10.26, a git dependency's `prepare` is blocked by default, so the first install can stop with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. If it does, set the key that pnpm's error prints to `true` under `allowBuilds` in the profile's `pnpm-workspace.yaml` (`$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml`), then run the same command again. Copy the key from the error output: for git dependencies, pnpm 11 ignores a key that is only the package name.

You can also install from a local checkout. pnpm links it with `link:`, which is how the E2E harness installs it:

```sh
git clone https://github.com/WenXin-L/dsh-memory-cloud.git dsh-memory-cloud-brain
cd dsh-memory-cloud-brain
pnpm install
pnpm build
dsh plugin --profile web add "$PWD"
```

Or pack a tarball and install that (this path has not been run end-to-end yet):

```sh
npm pack                     # writes dsh-memory-cloud-brain-0.1.0.tgz
dsh plugin --profile web add ./dsh-memory-cloud-brain-0.1.0.tgz
```

For headless and SDK hosts, use their profile instead of `web`, e.g. `--profile headless`. See [below](#headless--sdk) for enabling engine mode there.

### Desktop

In the Desktop app open **Plugins → Add plugin**, enter `dsh-memory-cloud-brain` (once published), `github:WenXin-L/dsh-memory-cloud` or the tarball's absolute path, then enable it. Desktop manages its own profile. The plugin has not been tested on Desktop yet.

### Restart notes

- Restart DSH (`dsh --profile web …` or the Desktop app) if the plugin does not show up after installing, or if the UI asks for a restart.
- Changing `storageRoot` needs a restart; every other setting applies live.
- Headless/SDK takeover and restore need a restart; the Web/Desktop preset takeover does not.
- Both takeover and restore affect **new sessions only**.

After installing, run `/memory status` in a session to confirm the plugin is loaded and to see its mode.

## Enabling engine mode (compaction takeover)

### Why it is needed

The Web (and Desktop) Standard preset builds its own compaction engine in an **isolated compaction group** (`preset-standard` → the `compaction` group with `compaction-basic`, `command-compact` and `tool-result-pruner`). The host-level `compaction-basic` is already disabled in those profiles. A plugin's bundle patch cannot reach that nested group by id, so installing alone only gives you assist mode. Engine mode needs one explicit takeover.

### Web / Desktop

Click **Take over compaction** on the plugin's settings page (on the Plugins page), or run:

```
/memory takeover            # the standard preset
/memory takeover <preset>   # another preset with a compaction group
```

This goes through DSH's config editor (`ctx.configEditor`), which rewrites the `preset-standard` row in the current profile's `cordis.patch.yml`. It puts `dsh-memory-cloud-brain/engine` first in the `compaction` group and disables `compaction-basic` there. Everything else in the row, including your own edits, is kept.

- **New sessions only**: open sessions keep their engine. No restart is needed.
- **Reversible**: **Restore** on the settings page, or `/memory restore [preset]`, resets the row to its inherited value and removes the override from the profile patch.
- **Follows DSH upgrades**: about 10 s after the plugin starts, it checks whether a recorded takeover was made against an older preset. If so, it re-applies the takeover to the new preset. If you edited the row by hand, the status reports it as "customized" and the plugin leaves it alone.
- **Failures carry a reason code**. For example, `overridden` means a higher layer (home patch or `--patch`) overrides the row, so the config editor cannot write it.

### Headless / SDK

Profiles without agent presets use host-level compaction. The bundle ships a **disabled** `dsh-memory-cloud-brain-engine` row. Takeover disables `compaction-basic` and enables that row through the plugin manager, then **needs a restart**. Restore reverses both. Headless has no slash-command input, so use one of these:

- in an SDK host, call `ctx.get('memoryCloud')?.api.takeover()` (or `.restore()`); see [`docs/host-api.md`](host-api.md);
- in a host that can execute slash commands, run `/memory takeover`;
- or write the same entries the plugin manager writes into the profile's `cordis.patch.yml`:

  ```yaml
  - id: compaction-basic
    disabled: true
  - id: dsh-memory-cloud-brain-engine
    disabled: false
  ```

The engine row accepts all of `compaction-basic`'s options plus `composeTimeoutMs` (default 120000).

## Settings

### Settings page

The plugin's page on the Plugins page has these sections:
- **Status**: effective mode, resolved budget, firewall (how sessions no rule matches are scoped right now), episode counts per scope, background jobs, takeover, coexistence warnings, last engine fallback, storage;
- **Compression level**;
- **Compaction mode**;
- **Take over compaction / Restore**;
- **Advanced** (collapsed; loaded the first time it is opened), with every other live field:
  - background summaries: `summarizer.provider` / `model` / `reasoningEffort`;
  - capture and forgetting: `idleMinutes`, `idleCompactRatio`, `halfLifeDays`, `maxEpisodeTokens`, `captureReasoning`;
  - level overrides: `overrides.*`; an empty field keeps the level's own value. The input's placeholder shows the value resolved for the active session's model when it is known, and the level's preset ceiling otherwise. An override skips the "never more than the level below" cap (see [Compression levels](#compression-levels-default-3)), so typing the ceiling can give more than leaving the field empty;
  - scope rules: add, remove and reorder `scopeRules`, plus [sessions no rule matches](#sessions-no-rule-matches-unmatchedsessions) (`unmatchedSessions`).

Advanced checks number ranges, and that no `$n` exceeds the pattern's wildcard count, in the browser. The host checks the result against the config schema again before writing and writes nothing if it fails. **Discard changes** resets the form; **Restore defaults** only fills in the shipped values, and nothing is written until you save.

Changes apply live and are written to the current profile's `cordis.patch.yml`. Only `storageRoot` cannot be changed on the page: edit `cordis.patch.yml` and restart. The page reaches the host through DSH's Typert Remote (SRC mode); if that is unavailable, use the `/memory` commands or edit `cordis.patch.yml` by hand (below).

### Compression levels (default 3)

K = 1024 tokens. W is the model's context window and O the reserved output.

| Level | Compaction trigger (working-memory ceiling) | Raw tail kept | Memory block M | Recent summaries count × tokens | Per gist | Single recall limit |
|---|---|---|---|---|---|---|
| 1 light | 0.8W (host default) | 0.16(W−O) | 48K | 10 × 1500 | 80 | 16K |
| 2 | 256K | 48K | 32K | 8 × 1000 | 60 | 12K |
| **3 default** | **128K** | **24K** | **24K** | **6 × 800** | **50** | **8K** |
| 4 | 64K | 12K | 12K | 4 × 500 | 35 | 4K |
| 5 minimal | 32K | 6K | 6K | 2 × 300 | 25 | 2K |

The table lists ceilings. The actual values are resolved per model window, level by level from level 1 (`src/pack/budget.ts`). With A = W − O − H, where H is the engine headroom `headroomTokens` (default 8192), level n gets:
- **trigger** `Tₙ = min(level value, A, Tₙ₋₁)`, where level 1 is `min(0.8W, A)`;
- **raw tail**: `0.16(W − O)` at level 1, the level value otherwise, and never more than the level below;
- **block** `M = clamp(min(level value, 0.25A), 2K, level value)`, and never more than the level below;
- **60% rule**: `M + raw tail < 0.6T`, so a compaction does not immediately trigger another one. When the sum is too large, both shrink in proportion; M keeps at least 2K (or the whole allowance when that is smaller), and the tail gets the rest. The shrunk values are still capped by the level below;
- **single recall** `max(512, min(level value, 0.25T))`, and never more than the level below.

Fields set in `overrides` skip the "level below" cap but keep the window clamps and the 60% rule. The recent-summary count and the per-summary and per-gist lengths come straight from the level (then clamped to the tier quotas) and are not compared across levels.

**The ladder is monotonic**: trigger, raw tail, block and recall limit stay equal or shrink from level 1 to level 5, so a higher level never exceeds a lower one on any window. On smaller windows the higher levels therefore fall back to level 1's (host default) values:
- below a 320K window `0.8W < 256K`, so level 2's trigger equals level 1's; below 160K, level 3's does too;
- on a 128K window (O = 2000), levels 1–3 all trigger at 104 857 tokens and keep about 20K of raw tail; level 3 only has a smaller block (24K) and recall limit (8K);
- on a 32K window (O = 2000), all five levels share the trigger, raw tail and block (22 576 / 4 922 / 5 644); only the recall limit and the recent-summary count and lengths differ.

When the model reports no context window, the plugin assumes W = 32K for the block and recall limit, and the status shows the window as unknown. In engine mode the plugin then leaves that model's compaction thresholds to the engine row's own config.

`/memory status` shows the values resolved for the current session. Notes:
- in assist mode, the level only controls the block and the recall limit;
- levels 4–5 compact more often, which moves more context from cache-hit price to full recompute price, so they are not necessarily cheaper;
- `/memory rebuild` regenerates existing gists and summaries at the current level's lengths.

### All fields

Every field below except `storageRoot` can be changed in the settings page's Advanced section. You can also configure the row by id in `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (`$DSH_HOME` defaults to `~/.dsh`):

```yaml
- id: dsh-memory-cloud-brain
  config:
    level: 3
    compactionMode: auto
    idleMinutes: 30
    overrides:
      memoryBudgetTokens: 16000
```

> The row's `config` is replaced as a whole, not deep-merged. The settings page and `/memory level|mode` write the same place, so keep existing fields when editing by hand.

| Field | Default | Meaning |
|---|---|---|
| `level` | `3` | Compression level 1–5 |
| `compactionMode` | `auto` | `auto` \| `engine` \| `assist` \| `off` |
| `storageRoot` | empty = `$DSH_HOME/memory-cloud` | Storage root; **restart required** |
| `idleMinutes` | `30` | Idle time before the open tail is sealed as an episode |
| `idleCompactRatio` | `0.5` | Context pressure above which an idle agent is compacted with `compactNow()` |
| `halfLifeDays` | `14` | Forgetting half-life in days |
| `maxEpisodeTokens` | `32768` | Seal an episode once its raw text exceeds this; `0` disables size-based sealing |
| `captureReasoning` | `true` | Keep model reasoning in the raw archive |
| `summarizer.provider` | empty | Provider for background summaries; empty uses the default model's provider |
| `summarizer.model` | `deepseek-flash` | Model for background summaries; falls back to the default model (with a warning) if it cannot be resolved |
| `summarizer.reasoningEffort` | `off` | Reasoning effort for background summaries; empty uses the adapter default; ignored if the model does not support it |
| `overrides.*` | — | Per-field overrides over the active level: `workingMemoryTokens`, `retainTokens`, `memoryBudgetTokens`, `recentSummaryCount`, `recentSummaryTokens`, `gistTokens`, `recallLimitTokens`; still clamped to minimums and the model window |
| `scopeRules` | `[]` | Scope rules, see below |
| `unmatchedSessions` | `auto` | `auto` \| `owner` \| `isolated`: what sessions no scope rule matches get, see below |

In engine mode, the checkpoint call uses the **conversation's own model** (to share its prefix cache), not `summarizer.*`.

### Scopes and the privacy firewall

Every session belongs to one scope, and scopes are fully isolated: memory blocks, checkpoints and the recall tools only read and write the session's own scope. The owner's memory is open only to a **private owner decision**, which a session gets in one of two ways:
- a rule whose scope is **literally** `owner` matches it;
- no rule matches it and the [`unmatchedSessions`](#sessions-no-rule-matches-unmatchedsessions) decision is owner.

Injection, engine checkpoints and the recall tools all go through one check, `canReadScope` (`src/scope/guard.ts`): a session may only read its own scope, and the owner scope only with a private owner decision. When the check fails, no memory block is injected, the engine checkpoint falls back to the host summary, and the tools answer `Memory is not available in this session.`

**That is the group-chat firewall: the owner's private memory stays out of group and guest sessions.**

#### Scope rules

Rules are tried in order, and the first rule whose glob matches any of the session's tags wins. Matching is case-insensitive.
- **Glob syntax**: `*` matches any run of characters (including `:` and `/`), `?` matches one character, and `\` escapes the next character.
- **Scope templates**: `$1`…`$9` insert the wildcard captures, `$&` (or `$0`) the whole tag, and `$$` a literal `$`.
- **`$n` validation**: a rule whose template uses a `$n` beyond the number of wildcards (`*` and `?`) in its pattern is skipped with a warning. The settings page and `setConfig` refuse to save such a rule.
- **Empty captures**: a `$n` that captured an empty string expands to a hash of the whole tag, so distinct tags never collapse into one scope.
- **Expanding to `owner`**: a template that is not literally `owner` but expands (after normalization) to `owner`, e.g. because `$1` captured `owner`, gets the scope `owner-<hash>` instead and **never** sees the owner's memory.
- **Scope ids**: normalized to lowercase `[a-z0-9_-]`, at most 64 characters. When an id has to be rewritten, a hash of the original is appended so two scopes never merge.

Example (QQ):

```yaml
- id: dsh-memory-cloud-brain
  config:
    scopeRules:
      - match: "qqbot:*:private:10001"   # the owner's own DM stays in owner
        scope: owner
      - match: "qqbot:*:group:*"         # qqbot:<bot>:group:<group id> → qq-group-<group id>
        scope: "qq-group-$2"
      - match: "qqbot:*:private:*"       # everyone else's DM gets its own scope
        scope: "qq-user-$2"
```

Every session also carries the tags `preset:<preset>`, `cwd:<working dir>` and `session:<session id>`, which rules can use too (e.g. `cwd:/home/me/qq-rooms/*`). A subagent is not resolved by its own tags: it follows `parentSession` up to the root session of its delegation chain and gets that session's decision.

DSH session headers have no tag field. A chat bridge (or your integration code) should supply tags when a session is created:

```js
ctx.get('memoryCloud')?.setSessionTags(sessionId, ['qqbot:fish:group:123456'])
```

#### Sessions no rule matches (unmatchedSessions)

| Value | Behaviour |
|---|---|
| `auto` (default) | `isolated` while a chat-bridge plugin is detected, `owner` otherwise |
| `owner` | The private owner scope. Use it only when nobody else can reach this agent |
| `isolated` | Each session gets its own scope `session-<hash>` (subagents share the scope of their delegation chain's root session), without the owner's memory or any other session's |

An unrecognized value is treated as `isolated`. Bridges recognized by package name: `dsh-qq-bridge`, `dsh-qqbot`, `dsh-qq-rooms`, `dsh-onebot-qq`, `dsh-wechat`.

> **Note: once `auto` detects a bridge, your own sessions are isolated too.** Bridge sessions carry no tags that rules could match, so the plugin cannot tell a group chat from a session you opened yourself in Web, Desktop or the CLI. Every session no rule matches is isolated and loses access to earlier memory. To keep owner memory in your own sessions, add a rule that maps them to owner, for example:
>
> ```yaml
> scopeRules:
>   - match: "cwd:/Users/me/*"     # sessions opened under your own directory
>     scope: owner
>   - match: "preset:standard"     # or: every Standard-preset session
>     scope: owner
> ```
>
> Such a rule is only safe if bridge sessions do **not** match it (their working directory is elsewhere, or they use another preset). Put the bridge rules first, because the first matching rule wins.

> **Undetected bridges**: a bridge outside the list does not trigger `auto`'s isolation, so its untagged sessions land in the owner scope **and see the owner's memory**. With such a bridge, set `unmatchedSessions` to `isolated` and map your own sessions to owner with a rule.

`/memory status` shows the current session's scope, whether it is private and why, plus how sessions no rule matches are scoped right now (the firewall); the settings page's Status shows the latter too.

**After changing rules or tags**:
- injection and recall resolve the scope again on every step, so they follow at once;
- capture resolves it again at the start of the next turn, whenever the session's tags change, and when the session switches agent preset (`agent-preset/selected`); if the scope changed, the open episode is sealed in the old scope and later records go to the new one;
- an owner memory block that was already injected stays in the context until the next compaction (the plugin logs a warning). If the session must no longer see owner memory, start a new session.

## Tools and commands

### Tools for the model

All tools only see the current session's scope and go through the same `canReadScope` check (see [Scopes and the privacy firewall](#scopes-and-the-privacy-firewall)).

| Tool | Parameters | What it does |
|---|---|---|
| `memory_search` | `query`, `from` / `to` (`YYYY-MM-DD`, `YYYY-MM` or `YYYY`, separated by `-`, `/` or `.`; or a strict ISO date-time `YYYY-MM-DDTHH:mm[:ss[.sss]][Z\|±hh:mm]`, with a space allowed for `T` and local time without an offset; anything else is rejected), `limit` (default 8, max 50), `includeRaw` | Searches Chinese and English words, names and dates (Chinese bigrams plus BM25-style scoring). Returns the true hit count and `#id date gist`. `includeRaw` also scans raw transcripts, with a bound |
| `memory_read` | `id`, `level`: `summary` (default) \| `gist` \| `raw`, `offset` / `limit` (raw paging, default 40, max 200), `includeSystem` | Reads an episode's summary, gist or raw transcript. Raw hides system records by default and shows only the conversation (user and assistant messages, tool calls and results); the number of hidden records is reported as `hiddenRecords`. `includeSystem: true` shows runtime-context reminders, compaction checkpoints, injected memory blocks and log events too; offsets then count every stored record, so keep the same value while paging |
| `memory_timeline` | `id`, `before` / `after` (default 3, max 20) | Dated gists of the neighbouring episodes |
| `memory_pin` / `memory_unpin` | `id` | Pin / unpin |
| `memory_hide` / `memory_unhide` | `id` | Hide from blocks and search / restore; nothing is deleted. Rollups that contain a hidden episode are not injected either (see [Rollups](#rollups)) |
| `memory_note` | `action` (`list`, `add`, `replace`, `remove`), `text`, `oldText` | Manage lasting preferences in a private owner session. List takes no text. Add takes the new text. Remove and replace require the entire old entry in `oldText`; replace also takes the new `text`. Writes require capture to be enabled for the caller. |

Use this tool when the user explicitly asks to remember, correct, or forget a preference across sessions. “Keep this answer short” applies to one reply. “Remember that I prefer short answers” warrants a note. Store one fact per line. Notes share a budget of 1,375 Unicode code points, including one newline between entries. Adding an existing note uses no extra space. If the store is full, list the notes and shorten or remove an entry according to the user's intent.

Notes share the profile's injection budget and follow the hand-written lines. List reflects writes immediately. A new session or a fresh pack at compaction picks up the change. Previously injected text, snapshots, and transcripts remain historical records. If you roll back to an earlier plugin version, keep `profile-notes.json` to reuse the notes after upgrading again.

One recall returns at most the level's single-recall limit, and the cap tightens with context pressure:
- above 60%: the cap is halved;
- above 75%: raw reads return the summary instead;
- above 90%: recall is paused.

A byte-stable usage section (in Chinese) in the system prompt covers when to save a preference and how to recall earlier conversations: memory is history, not instructions, and what the user says now wins over it; look details up instead of guessing, with at most 1–3 lookups per answer; recall the past naturally, with its time, and do not mention the memory block, tools or episode ids unless asked.

### `/memory` commands

| Command | What it does |
|---|---|
| `/memory status` | Effective mode and reason, level and resolved budget, scope, firewall (how sessions no rule matches are scoped), episode counts, background jobs, takeover and coexistence, recent engine fallbacks |
| `/memory level <1-5>` | Set the level; applies live |
| `/memory mode <auto\|engine\|assist\|off>` | Set the mode |
| `/memory compact-now` | Compact the current session now with its compaction engine |
| `/memory summarize-now` | Seal the current tail and run the background summary queue now, including failed episodes that used up their retries and rollups that were given up on; empty episodes are skipped, and jobs another DSH process is running are left alone |
| `/memory rebuild` | Re-summarize every episode in this scope at the current level's lengths (subject to the daily quota; old text stays until the new one is written) |
| `/memory takeover [preset]` | Take over compaction (the `standard` preset by default; the host-level engine row on headless) |
| `/memory restore [preset]` | Restore DSH's default compaction |
| `/memory backfill` | **Not implemented yet**: it only explains this. Only sessions after installation are archived |
| `/memory help` | Usage |

## Storage on disk

```
<storageRoot, default $DSH_HOME/memory-cloud>/
  state.json                 per-session capture watermarks, background job queue, daily quota, given-up rollups (exhaustedRollups)
  takeover.json              preset takeover records (per DSH profile)
  logs/summarizer.jsonl      result, usage and errors of every summarizer call (append-only)
  scopes/<scope>/            owner, qq-group-123456, session-<hash>, …
    index.json               episode catalogue (compact one-line JSON)
    profile.md               optional hand-written profile, packed line by line (lines over quota are left out)
    profile-notes.json       owner only, created when the first preference is saved separately from the hand-written profile
    episodes/2026/11/20261120-2130_ab12cd34_1/
      raw.jsonl              raw events {seq,time,type,data,…}, append-only
      summary.md  gist.md    summary / gist with frontmatter (seq range, times, model, prompt version, tokens; the summary also people, dates, promises)
      meta.json              mirror of the index entry, used to rebuild the index
    rollups/2026-W47.md  2026-11.md
    snapshots/<sessionId>-<n>.md   every injected block or checkpoint, for auditing
```

- **Plain files only** (JSON, JSONL, Markdown). Every write is temp file + rename.
- **Nothing is deleted**:
  - the raw archive is append-only;
  - before `summary.md`, `gist.md` or a rollup is overwritten (re-summarizing, `/memory rebuild`, re-merging), a differing previous version is kept as `<file>.prev-<timestamp>`;
  - a corrupt `index.json`, `state.json` or `meta.json` is kept as `<file>.corrupt-<timestamp>`.

  These copies are never cleaned up automatically.
- **Self-healing**: if `index.json` is lost or corrupt, it is rebuilt from the episode directories and `meta.json`.
- **Git-friendly backups**: make `storageRoot` a git repository, or back it up with any file sync tool. Commit while DSH is idle and ignore transient files:

  ```gitignore
  *.lock
  *.clear
  *.tmp
  ```

**Several DSH processes on one store** (e.g. Web and Desktop sharing a `DSH_HOME`):
- writers take a cross-process file lock on `index.json` (one per scope) and on `state.json`, waiting at most 10 s. The plugin clears a lock file that has not changed for 5 s in these cases:
  - a torn lock file left by a writer that died mid-write;
  - a lock naming this process's own PID that was written before this process started (left by an earlier process with the same PID);
  - a lock left from before the last system boot, only if a live process has since reused its PID.

  Anything else (for example a lock whose PID has exited) is left to DSH's own lock takeover;
- every open episode records the process that opened or adopted it (PID and process start time) in the index until it is sealed. The stale-episode sweep runs at startup and then at most every 5 minutes; it only seals episodes older than `idleMinutes`, and skips those owned by another process that is still running. A recorded PID now held by a process that started more than 5 minutes after the owner counts as exited (a reused PID). This check reads process start times with `ps`; where they cannot be read, as on Windows, it is skipped and the old rule applies: a live PID counts as the owner;
- an episode another process has sealed cannot be appended to: the append is refused (`EpisodeNotOpenError`), and capture continues after the sealed range in a new episode;
- the background job queue and the daily quota live in `state.json` and are shared. A claimed job is leased (the 5-minute job timeout plus 60 s), so other processes skip it, even when `/memory summarize-now` or `/memory rebuild` forces the queue; deferred or cancelled jobs refund their quota.

- **The raw archive is the full conversation**, including tool results and (by default) reasoning. Use a private remote.

## Privacy

- **Summarizer calls are kept out of DeepSeek session-log upload.** Background summaries, rollups and engine-mode checkpoint summaries use the custom purpose `memory-cloud-summarize` and are sent **without a `sessionId`**. The plugin also registers an upload exclusion for that purpose with `dsh-session-log-deepseek`.
  - These calls still go to your configured model provider.
  - An engine fallback uses DSH's own default summary (`purpose: compaction`), which is handled like any DSH compaction.
  - The memory block injected into a session is part of that session's messages and follows DSH's session-log settings like any other message.
- **Scope firewall**: see [Scopes and the privacy firewall](#scopes-and-the-privacy-firewall).
- **Local only**: the plugin does no network sync. There is no redaction.

## Coexistence with other memory and compaction plugins

- The plugin recognizes a known list by package name:
  - **compaction plugins**: `dsh-taskfold`, `dsh-ebbing-context`, `dsh-ctxopt-compaction`, `dsh-context-maid`, `dsh-world/compaction`, `dsh-brain-compaction`, `flowctx-dsh`;
  - **memory plugins**: `dsh-memory`, `dsh-codex-memories`, `dsh-engramory`, `dsh-auto-memory`, `dsh-world`, and several 大肥鱼 ecosystem plugins;
  - **chat bridges**: `dsh-qq-bridge`, `dsh-qqbot`, `dsh-qq-rooms`, `dsh-onebot-qq`, `dsh-wechat`.
- With another **compaction plugin** loaded, `auto` falls back to assist mode instead of competing for the compaction engine.
- With a **chat bridge** loaded, `unmatchedSessions: auto` isolates sessions no rule matches, and the status says so (see [Sessions no rule matches](#sessions-no-rule-matches-unmatchedsessions)).
- Other **memory plugins** only produce a status warning about duplicate injection and wasted context. Keep one memory-injecting plugin per profile.
- **Tool-name clashes**: `dsh-memory` and `dsh-codex-memories` also register `memory_search` / `memory_read`, and `dsh-world` registers `memory_read`. DSH rejects duplicate tool names, so whichever plugin registers second fails. This plugin registers its recall tools all-or-nothing. On failure `/memory status` shows "recall tools: not registered" with the reason, and memory injection still works. The `/memory` command name can clash the same way.
- Plugins outside the list are not detected. Assist mode keeps the host's or another plugin's compaction summary and only adds the memory block after it.
- The plugin ships no persona; the memory block is kept separate from persona sections.

## Limitations and what is not verified

- **Real DeepSeek requests and prompt caching are unmeasured.** The E2E harness uses a fake model. These are design goals, but `prompt_cache_hit_tokens` was never measured:
  - the memory block is frozen once per session, so its bytes stay stable;
  - engine mode replays the replaced span the way the host does, to hit the prefix cache.

  Summarizer calls carry no `sessionId`, and the effect of that on DeepSeek routing and caching is unknown. The level numbers are initial values that still need tuning.
- **Desktop is untested.** Desktop profile composition was not verified. Preset takeover should work as on Web but has not been run.
- **`/memory backfill` is not implemented.** Sessions from before installation are not imported.
- **The settings page depends on SRC-mode Remote.** It finds the host service through DSH Typert Gateway's SRC mode, because third parties cannot generate strict endpoints. If DSH changes that, the page cannot load status; use the `/memory` commands or edit `cordis.patch.yml` instead. The page (Advanced included) has not been rendered in a real browser yet.
- **Bridge tags and detection**:
  - no bridge plugin is known to call `setSessionTags`, so rules such as `qqbot:…` only become useful once bridges supply tags; QQ/WeChat bridge session metadata was not verified;
  - bridges are recognized by package name only; the listed names and row layouts were not verified against real installs, and bridges outside the list are not detected (use `unmatchedSessions: isolated` for those);
  - once `auto` detects a bridge, your own unmatched sessions are isolated as well until you add a rule that maps them to owner.
- **Several processes**: locking, episode ownership and job leases for Web and Desktop sharing one `DSH_HOME` are covered by unit tests only (cross-process locking included); the E2E harness never runs two DSH processes at once.
- **Other things not verified in a real setup**:
  - installing from a packed tarball or a `github:` spec (the E2E harness uses a `link:` install);
  - re-applying the takeover after a real DSH upgrade;
  - slash commands typed in a UI (commands were only run host-side through `ctx.commands.execute`);
  - taking over presets other than `standard`.
- **Levels on small windows**: below a window of about 320K the higher levels fall back to level 1's trigger and raw tail, so the levels differ less (on a 32K window only the recall limit and the recent-summary count and lengths differ).
- **Models that report no window**: the block and recall limit are sized for a 32K window, which may be smaller than needed.
- **Resumed headless sessions**: the compaction span may cross earlier sealed episodes. The checkpoint summary is then not stored for the open episode (it is summarized in the background instead), and the checkpoint can repeat facts from those episodes.
- **Token counts are estimates.** Chinese is estimated as `(0.6 × CJK chars + 0.3 × other chars) × 1.15`, while DSH's own meter uses 4 chars per token, which underestimates Chinese. The plugin rescales the retained tail for this, but the numbers stay approximate.

## Development

```sh
pnpm install
pnpm build       # tsdown → lib/index.js (host), lib/engine.js (compaction engine), lib/client.js (settings page)
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
```

End-to-end check (real DSH with a fake model, no API key, about 3 minutes):

```sh
node scripts/e2e/run-e2e.mjs                 # installs DSH 0.2.2-rc.5 (~1.2 GB) into a temp dir and runs every scenario
node scripts/e2e/run-e2e.mjs --keep          # keep the temp dir (logs, DSH home)
node scripts/e2e/run-e2e.mjs --only s1,s2 --skip-build --dsh-dir /path/with/node_modules/.bin/dsh
```

The scenarios cover headless takeover and compaction, new-session injection and recall, level changes, summarizer-failure fallback, assist mode, Web preset takeover and shutdown. See [`scripts/e2e/README.md`](../scripts/e2e/README.md).

More documentation:
- changelog (Chinese): [`CHANGELOG.md`](../CHANGELOG.md)
- design (Chinese): [`docs/superpowers/specs/2026-11-23-memory-cloud-design.md`](superpowers/specs/2026-11-23-memory-cloud-design.md)
- verified DSH facts: [`docs/dsh-api-notes.md`](dsh-api-notes.md)
- host API (`ctx.memoryCloud`): [`docs/host-api.md`](host-api.md)

## License

Released under the [GNU General Public License v3.0](../LICENSE) (SPDX: `GPL-3.0-only`).
