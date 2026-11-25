# Memory Cloud · dsh-memory-cloud-brain

[中文](README.md) · [User guide](docs/reference.en.md) · [Changelog (Chinese)](CHANGELOG.md)

**Pick up where you left off in a new DeepSeek Harness (DSH) session.** Memory Cloud archives conversations locally, carries recent summaries and older highlights into new sessions, and lets the model look up the original text when it needs details. It can also replace DSH's context compaction engine, but you do not need to enable that to get started.

> This is the `0.1.0` source preview; it is not on npm. The recorded end-to-end runs used DSH `0.2.2-rc.5`, a local link, and a fake model. Desktop, real-model caching, and other install methods have not been verified.

## Install

Start with [DSH](https://github.com/deepseek-ai/deepseek-harness) `0.2.2-rc.5`, Node.js `24.9` or later, and `pnpm` on your PATH. Try it in a separate test profile or a temporary `DSH_HOME` before using it with existing conversations.

```sh
git clone https://github.com/WenXin-L/dsh-memory-cloud.git
cd dsh-memory-cloud
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
dsh plugin --profile web add "$PWD"
```

If the plugin does not show up, restart DSH. In a **new session**, run `/memory status` to check that it loaded and see the current mode and scope. Start in the default **assist mode**: it adds memory without replacing DSH's compaction engine.

## Everyday use

| I want to… | What to do |
| --- | --- |
| Check whether the plugin is active | `/memory status` shows the mode, memory budget, scope, and background jobs. |
| Adjust how much detail it keeps | Use `/memory level 1` through `/memory level 5`; the default is `3`. |
| Use Memory Cloud for compaction | Choose **Take over compaction** in settings or run `/memory takeover`; use `/memory restore` to undo it. See the [takeover and restart notes](docs/reference.en.md#enabling-engine-mode-compaction-takeover). |
| Look up details from an earlier conversation | The model can use `memory_search` and `memory_read`. Archiving starts after the plugin is enabled; it does not backfill earlier sessions. |

## Before using it for real conversations

- **The raw archive stays on disk.** The default is `$DSH_HOME/memory-cloud` and may include tool results and model reasoning. Hiding a memory does not delete it. Keep the archive and raw logs out of public repositories.
- **Local storage does not mean offline processing.** Summaries still use the configured model provider. Memory added to a session follows DSH's session logging settings.
- **Set isolation explicitly for shared or bridged chats.** `auto` only recognizes some bridges. In shared environments, start with `unmatchedSessions: isolated` and review the [scope rules](docs/reference.en.md#scopes-and-the-privacy-firewall).

## More documentation

- Using the plugin: [install options](docs/reference.en.md#install) · [settings](docs/reference.en.md#settings) · [tools and commands](docs/reference.en.md#tools-and-commands) · [privacy](docs/reference.en.md#privacy)
- Development: [local checks](docs/reference.en.md#development) · [host API](docs/host-api.md) · [end-to-end tests](scripts/e2e/README.md)

License: [GPL-3.0-only](LICENSE).
