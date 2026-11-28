# Memory Cloud · dsh-memory-cloud-brain

[中文](README.md) · [How it works](docs/reference.en.md#tiers-and-data-flow) · [User guide](docs/reference.en.md) · [Changelog (Chinese)](CHANGELOG.md)

**Getting your previous conversation ready for a new session. The part that fits, anyway.** Memory Cloud archives DeepSeek Harness (DSH) conversations on this machine, one episode at a time. A new session picks up summaries of recent episodes and shorter gists of older ones from the same scope. For the exact wording, the model can look up the original. You can hand context compaction to Memory Cloud as a separate step whenever you need it.

> The `0.2.3` developer preview is available as an installable package. The end-to-end tests used DSH `0.2.2-rc.5`, a local link and a fake model. [Download 0.2.3](https://github.com/WenXin-L/dsh-memory-cloud/releases/tag/v0.2.3)

## Install

Give the trial a home of its own. Use a separate test profile or point `DSH_HOME` at a temporary directory, and start with test conversations. You'll need [DSH](https://github.com/deepseek-ai/deepseek-harness) `0.2.2-rc.5`, Node.js `24.9` or later, and `pnpm` on your PATH.

Download `dsh-memory-cloud-brain-0.2.3.tgz` from the release and run the command from your downloads directory.

```sh
dsh plugin --profile web add ./dsh-memory-cloud-brain-0.2.3.tgz
```

Restart DSH and check that Memory Cloud is enabled under **Plugins**. In a **new session**, run `/memory status` to check its mode and scope. A default Web install uses **assist mode**. DSH compacts the context, and Memory Cloud supplies the memories. [Install from source](docs/reference.en.md#web--headless-profiles-cli)

## Everyday use

| What you'd like memory to do | Where to start |
| --- | --- |
| Report for duty | Run `/memory status` for the mode, memory budget, scope and background jobs. |
| Keep things a little shorter | Choose `/memory level 1` through `/memory level 5`. The default is `3`. |
| Take on compaction | Choose **Take over compaction** in settings or run `/memory takeover`. Use `/memory restore` to hand the job back. See the [takeover and restart notes](docs/reference.en.md#enabling-engine-mode-compaction-takeover). |
| Use the right units in the next chat | In a private owner chat, say “Remember to use Celsius for temperatures.” You can ask the model to correct or remove the preference later. |
| Keep a launch date up to date | Say “Remember that Orchid launches on December 12.” Later, say “Orchid now launches on December 19. Update the record.” Ask about Orchid in a new chat in the same scope and the plugin looks up the revised date by subject. |
| Find out what was actually said | The model can find an episode with `memory_search` and read the original with `memory_read`. Archiving starts when the plugin is enabled. Earlier sessions aren't backfilled. |

## Before using it for real conversations

- **The disk remembers a hidden episode.** Raw transcripts live in `$DSH_HOME/memory-cloud` by default and may include tool results and model reasoning. Hiding an episode leaves its files on disk. Keep the store and the raw logs out of public repositories.
- **Summary requests have a forwarding address.** The archive lives on this machine. Requests to summarize it still go to your configured model provider. Memory added to a session follows the same DSH logging settings as its other messages.
- **`auto` recognizes the bridges on its list.** Set isolation explicitly for shared chats and external bridges. In a shared environment, start with `unmatchedSessions: isolated` and check the [scope rules](docs/reference.en.md#scopes-and-the-privacy-firewall) before connecting the bridge.

## More documentation

- Using the plugin · [Install options](docs/reference.en.md#install) · [Settings](docs/reference.en.md#settings) · [Tools and commands](docs/reference.en.md#tools-and-commands) · [Privacy](docs/reference.en.md#privacy)
- Working on the plugin · [Local checks](docs/reference.en.md#development) · [Host API](docs/host-api.md) · [End-to-end tests](scripts/e2e/README.md)

Licensed under [GPL-3.0-only](LICENSE).
