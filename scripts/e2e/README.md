# End-to-end check in a real DSH host

`run-e2e.mjs` installs DeepSeek Harness into a throwaway directory, installs this repo into the `headless` and `web` profiles the way a user would (`dsh plugin --profile <p> add <repo>`), and runs [seven scenarios](#scenarios) against a scripted fake model. No API key or account is used: every DSH process runs with an empty environment (only `PATH`, a fake `HOME`, a throwaway `DSH_HOME`, `DSH_TELEMETRY_DISABLED=1`).

```sh
pnpm build                              # or let the harness build
node scripts/e2e/run-e2e.mjs            # ~3 min; exit 0 when every check passes
node scripts/e2e/run-e2e.mjs --keep     # keep the temp dir (logs/, dsh-home/) for inspection
node scripts/e2e/run-e2e.mjs --only s1,s2 --skip-build --dsh-dir /path/with/node_modules/.bin/dsh
```

Requirements: Node ≥ 24.9, `pnpm` on `PATH` (DSH's `plugin add` shells out to it), and npm registry access only for `npm install @deepseek-ai/dsh@0.2.2-rc.5` (about 1.2 GB; runs with your normal npm environment and cache, retried once; override the version with `DSH_VERSION`, or skip the install with `--dsh-dir` pointing at an existing install). `--dsh-dir` must contain `node_modules/.bin/dsh` and a hoisted `node_modules/@deepseek-ai/dsh-llm`; the harness writes its test plugins into a `.mcb-e2e-plugins-<pid>` subdirectory there and removes it afterwards.

## What it generates

Two test-only plugins are serialized from functions inside `run-e2e.mjs` into the temp dir and loaded with `--patch`; they are never part of the repo's package:

- **fake LLM** (`e2e-fake-llm`): registers adapter `fake`, overrides `agent-default-model` to `fake/fake-1`, reports usage with a CJK-aware estimate. Conversation directives in the user prompt: `[[long:N]]` (reply of N chars), `[[steps:K:N]]` (K tool-call steps of N chars each, to cross thresholds mid-turn), `[[search:q]]`, `[[read:<id>]]`, `[[raw:<id>]]`. Summarizer requests (`purpose: memory-cloud-summarize`) get a `memory_save` call (transcript mode) or a fenced JSON answer (replay mode), built from `【事实：…】` markers; `summarize: throw | garbage` simulates failures; `purpose: compaction` gets a `DEFAULT-SUMMARY` text.
- **probe** (`e2e-probe`): exports every log line to `logs/dsh.log`, records unhandled rejections and exit codes, runs host-API actions at the end of a headless turn (`takeover`, `restore`, `level5`, `status`, `checkpoints`, `cmd:/memory …`), and in the web profile drives sessions host-side through `sessionController.create/prompt`.

## Scenarios

Scenarios run in order and share one DSH home. s1 performs the headless takeover that s3 and s4 rely on (both check compactions by the memory engine), and s2 continues s1's session, so an `--only` subset should include s1 whenever it includes s2, s3 or s4.

| | Checks |
|---|---|
| s1 | headless takeover through `api.takeover()` (plugin manager, `restart-required`); a 16-step turn on a 32K window triggers ≥ 2 pressure compactions by the memory engine; checkpoints in the session log carry `<memory-cloud>`; compaction episodes have `raw.jsonl`/`summary.md`/`gist.md` and no second (background) summarizer call; the session continues over later turns |
| s2 | new session: one injected block per request, distant entries as gists and recent ones as summaries; `memory_read #id` returns the summary, `level: raw` the original prompt, `memory_search` finds it |
| s3 | `api.setLevel(5)` through `ctx.settings`; on a 128K window the threshold drops 104 857 → 32 768 (level 3 inherits level 1's `0.8W` through the monotonic level ladder), the new-session block shrinks, and the same 14-step turn compacts only at level 5. Needs s1's headless takeover, because it counts compactions by the memory engine |
| s4 | summarizer throws / returns garbage: the turn completes, the checkpoint is compaction-basic's own summary, the episode is `failed` with a 30 s backoff and is summarized after it |
| s5 | `api.restore()`; with compaction-basic in charge the injected block is refilled on the step after a host compaction and compaction episodes are summarized in the background |
| s6 | `dsh web --no-open --port 0`: plugin loads, client bundle listed in the web index, preset sessions run in assist mode, configEditor takeover mounts `dsh-memory-cloud-brain/engine` for new sessions (engine mode, memory checkpoints), restore removes the override |
| s7 | SIGINT shutdown: prompt exit, no `*.lock` left in the store, no unhandled rejections, no lock timeouts or burned job attempts, open episodes sealed and queued |

Everything the harness creates lives in one `mcb-e2e-*` temp dir and is deleted at the end unless `--keep` is given; a web server it started is killed on exit.
