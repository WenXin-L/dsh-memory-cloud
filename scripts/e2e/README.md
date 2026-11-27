# End-to-end check in a real DSH host

[中文](README.zh.md) · [English user guide](../../docs/reference.en.md#development)

DSH gets a fresh home and a model that has rehearsed its lines. `run-e2e.mjs` installs DeepSeek Harness in a temporary directory, adds this checkout to the `headless` and `web` profiles with `dsh plugin --profile <p> add <repo>`, and runs [seven scenarios](#scenarios) against the scripted fake model. No API key or account is needed. Each DSH process gets its own clean environment containing only `PATH`, a temporary `HOME` and `DSH_HOME`, `DSH_TELEMETRY_DISABLED=1` and `TERM=dumb`.

Use Node.js ≥ 24.9 and put `pnpm` on `PATH`. DSH calls it when `plugin add` runs. From a checkout with its build dependencies installed, run the full check. The harness builds the plugin and exits with `0` when every check passes. Allow about 3 minutes for the checks themselves. A fresh DSH download takes additional time.

```sh
node scripts/e2e/run-e2e.mjs
```

To have the logs and test home waiting for you afterwards, ask for them at the start.

```sh
node scripts/e2e/run-e2e.mjs --keep
```

The step that needs npm registry access is `npm install @deepseek-ai/dsh@0.2.2-rc.5` (about 1.2 GB). npm uses your usual environment and cache and retries once after a failure. Set `DSH_VERSION` to change the version, or skip that install with `--dsh-dir`. Pass the installation directory containing both `node_modules/.bin/dsh` and a hoisted `node_modules/@deepseek-ai/dsh-llm`. To build once and run just the first two scenarios, replace `/path/to/dsh-install` with that directory.

```sh
pnpm build
node scripts/e2e/run-e2e.mjs --only s1,s2 --skip-build --dsh-dir /path/to/dsh-install
```

## What it generates

The harness serializes two functions from `run-e2e.mjs` into test plugins and loads them with `--patch`. They live in `.mcb-e2e-plugins-<pid>` under the DSH installation, including an installation you supply. Neither plugin ships in the package.

- **Fake LLM (`e2e-fake-llm`).** Registers the `fake` adapter, points `agent-default-model` at `fake/fake-1` and estimates token usage with a CJK-aware count. In a user prompt, `[[long:N]]` asks for N characters of filler. `[[steps:K:N]]` requests K tool-call steps with N characters of filler each. The harness uses these steps to reach a compaction threshold mid-turn. `[[search:q]]`, `[[read:<id>]]` and `[[raw:<id>]]` ask for search, summary and original text. For episode requests with `purpose: memory-cloud-summarize`, the model takes facts from `【事实：…】` markers and returns a `memory_save` call in transcript mode or fenced JSON in replay mode. A rollup gets text. Set `summarize: throw` or `summarize: garbage` to make the summarizer fail on cue. A request with `purpose: compaction` gets text beginning with `DEFAULT-SUMMARY`.
- **Probe (`e2e-probe`).** Exports every log line to `logs/dsh.log` and records unhandled rejections and exit codes. At the end of a headless turn it can run host-side actions including `takeover`, `restore`, `level5`, `status`, `checkpoints` and `cmd:/memory …`. Under the web profile it creates sessions and sends prompts from the host with `sessionController.create/prompt`.

## Scenarios

The scenarios run in order and share one DSH home. Earlier work has a way of showing up in later checks. When selecting with `--only`, include s1 with s2, s3 or s4. It supplies the session that s2 continues and the headless takeover that s3 and s4 exercise. Include s3 for s4 as well, to leave level 5 in effect. Run s1 before s5 to give it a headless takeover to restore. Include s6 for s7 so there is a Web process and a pair of sessions to shut down.

| Scenario | What the harness checks |
|---|---|
| s1 | Headless `api.takeover()` goes through the plugin manager and reports `restart-required`. With a 32K window, a 16-step turn triggers at least 2 pressure compactions by the memory engine. The session log contains `<memory-cloud>` checkpoints. Each compacted episode has `raw.jsonl`, `summary.md` and `gist.md`, and reuses the checkpoint summary without a second, background call. Later turns continue the same session. |
| s2 | First the old session gets a few more turns. Then a new session gets one injected block per request, with distant gists and recent summaries. `memory_read #id` returns the summary, `level: raw` returns the original prompt, and `memory_search` finds the episode. An isolated session gets its own scope and no owner memory block or owner search hits. |
| s3 | `api.setLevel(5)` writes through `ctx.settings`. On a 128K window the threshold drops from 104 857 to 32 768 tokens. Level 3 inherits level 1's `0.8W` threshold because each level is capped by the one below. The new-session block shrinks, and the same 14-step turn triggers engine compaction only at level 5. |
| s4 | Make the summarizer throw or return garbage. The turn completes with compaction-basic's own summary in the checkpoint. The episode is marked `failed` and waits out a 30 s backoff before a working summarizer picks it up. |
| s5 | `api.restore()` hands compaction back to compaction-basic. On the step after a host compaction, the plugin refills the memory block. It summarizes the compacted episodes in the background. |
| s6 | `dsh web --no-open --port 0` starts the Web host. The plugin loads, the web index lists the client bundle and preset sessions start in assist mode. The config editor takes over the preset's compaction group, mounting `dsh-memory-cloud-brain/engine` for new sessions. They get engine mode and memory checkpoints. Restore removes the override. |
| s7 | After SIGINT the Web host exits promptly. Open episodes are sealed and queued for summarization or already summarized. The harness checks for leftover `*.lock` files, unhandled rejections, lock timeouts and job attempts used up during shutdown. |

The harness stops any Web server it started on exit. By default it removes the `mcb-e2e-*` temporary directory and the test-plugin subdirectory. `--keep` retains both, including `logs/` and `dsh-home/` under the temporary directory. If you supplied `--dsh-dir`, the retained test plugins are in that installation.
