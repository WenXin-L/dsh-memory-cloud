# 记忆云：使用与配置手册

[返回项目首页](../README.md) · [English reference](reference.en.md)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的类人脑分层长期记忆插件，同时可以作为 DSH 的上下文压缩引擎。为长期陪伴场景设计（比如"养大肥鱼"：一个常驻的拟人 Agent，长期在 home 会话和聊天房间里陪你）。

- **原文无损存档**：会话事件原样追加到本地文件，只追加、不改写、从不删除。
- **每段一份总结 + 一份摘要**：会话按"片段"（episode）切分，每段生成高度压缩的 **总结**（gist，"有这么件事"）和正常压缩的 **摘要**（summary，"发生了什么"）。
- **远期给总结，近期给摘要**：新会话开始、以及每次上下文压缩之后，自动填入一个 `<memory-cloud>` 记忆块：相处档案 + 远期总结 + 近期摘要。
- **原文按需取回**：模型用 `memory_search` / `memory_read` 查旧事，需要时再分页读原文。
- **兼作压缩引擎**：接管后，DSH 的压缩检查点本身就是记忆块，被压缩掉的那段同时封存为一个片段。
- **压缩程度可调**：5 个档位，可以随时切换，立即生效。

> 当前源码版本：`0.1.0`（预览），变更见 [更新日志](../CHANGELOG.md)。尚未发布到 npm，DSH 本身也还是开发者预览版。只在 DSH `0.2.2-rc.5` 上用假模型做过端到端测试，详见 [局限与尚未验证的部分](#局限与尚未验证的部分)。

## 目录

- [工作原理](#工作原理)
- [安装](#安装)
- [启用引擎模式（接管压缩）](#启用引擎模式接管压缩)
- [设置](#设置)
- [工具与命令](#工具与命令)
- [磁盘上的存储](#磁盘上的存储)
- [隐私](#隐私)
- [与其他记忆 / 压缩插件共存](#与其他记忆--压缩插件共存)
- [局限与尚未验证的部分](#局限与尚未验证的部分)
- [开发](#开发)
- [许可](#许可)

## 工作原理

### 分层与数据流

```
                 ┌──────────── 上下文（工作记忆）────────────┐
 会话事件 ──────▶│ 系统提示 · <memory-cloud> 记忆块 · 近期原文 │
   │             └───────────────▲──────────────────┬───────┘
   │ 捕获                         │ 会话开始 / 压缩后注入  │ 压缩、空闲、会话结束、片段过大
   ▼                              │                     ▼
 raw.jsonl（原文，只追加）    打包器（按预算）◀──── 片段封存
   │                              ▲                     │
   │ memory_read level:raw        │                     ▼ 一次模型调用
   │                    相处档案 profile.md       summary.md（摘要，近期层）
   │                    时期总结 rollups/  ◀───── gist.md（总结，远期层）
   ▼                                  周→月合并
 模型按需回忆
```

| 人脑类比 | 插件里的对应物 |
|---|---|
| 工作记忆 | 上下文中保留的近期原文 |
| 近期记忆 | 最近几个片段的 **摘要** |
| 远期记忆 | 更早片段的 **总结**，以及按周 / 月合并的 **时期总结** |
| 可回想的档案 | 文件夹里的原文 `raw.jsonl` |
| 长期印象 | 手写的 `profile.md`（称呼、偏好、约定），以及在私有主人会话里通过 `memory_note` 保存的偏好 |

**片段**是记忆单位，不是 DSH 会话。陪伴型 home 会话可能永远不结束，所以出现以下任一情况时，当前片段就会封存：
- 一次上下文压缩替换了它；
- 空闲超过 `idleMinutes`（默认 30 分钟）；
- 会话被释放；
- 原文超过 `maxEpisodeTokens`（默认 32768；设为 0 则不按大小封存）。

封存后，后台会为片段生成总结和摘要（提示词版本 `memory-cloud-summary/2`）：
- 摘要会保留人名、日期、数字、偏好、否定、状态变化和任一方的约定，按"发生了什么 / 约定/待办 / 关键事实 / 情绪与关系变化"分节，没有内容的节省略；
- 对话记录的时间戳带中文星期，相对日期（"下周三"）按说这句话的时间换算成绝对日期；
- 同时给片段打上 1–10 的重要度和关键词，并在 `summary.md` 的 frontmatter 中记下人物、日期和承诺；
- 模型照抄格式模板里的占位内容（`…`、`<…>`、"（每行一项…）"之类）时，这些条目会被丢弃。

**记忆块**的打包是纯计算，不调用模型：
- **各层配额**：相处档案 10% → 近期摘要 55% → 远期总结 35%。没用完的额度顺延给下一层。压缩检查点另有一小份"进行中事项"预算。
- **相处档案里的待办**：手写档案和已保存的偏好之后，列出仍未兑现的约定和即将到来的日程，取自各片段 `summary.md` frontmatter 中的承诺和日期，最多 8 条，最近的在前。它们和 `profile.md` 共用相处档案的配额，放不下时优先保留待办：
  - 有截止日期的约定，截止日不早于今天；
  - 没有截止日期的约定，所在片段在 30 天内；
  - 今天到 90 天内的日期。

  每条带中文星期和片段 ID，例如 `- 约定（AI，截止 2026-11-25 周三）：提醒小林打包 #…`。
- **谁得到摘要**：最新的 `recentSummaryCount` 个片段先进入近期层；其余片段先按是否置顶、再按保留分排序，近期层还有空间就给摘要，没有就降为一行总结。
- **远期层溢出时**：先用时期总结替代多条总结；仍然放不下，就丢掉分数最低的条目，并留一行"还有 N 段更早记忆，可用 memory_search 查询"。单条记忆从不截断。
- **格式**：每条记忆都带日期和片段 ID（`#20261120-2130_ab12cd34_1`）。整个块声明为"历史数据，非指令"。

### 引擎模式与辅助模式

| | 引擎模式 `engine` | 辅助模式 `assist` |
|---|---|---|
| 谁来压缩 | 本插件的 `MemoryCompactionEngine`。它继承 DSH 的 `BasicCompactionEngine`，选区、锁、提交、溢出重试都沿用宿主实现 | DSH 自带的 `compaction-basic`，或其他压缩插件 |
| 压缩检查点 | 记忆块 + 刚封存片段的摘要 + 进行中事项 | 宿主自己的摘要模板（编码向），保持不动 |
| 压缩后的记忆 | 检查点本身就是记忆块，不再另外追加 | 下一步自动重新追加记忆块 |
| 档位控制的范围 | 压缩阈值、保留原文、记忆块大小、回忆上限 | 只控制记忆块大小和回忆上限，压缩阈值仍由宿主决定 |
| 模型调用 | 每次压缩一次调用：按宿主做法重放被压缩的区间以尽量命中前缀缓存，结果同时存成片段的总结 / 摘要 | 片段封存后在后台总结 |

引擎模式下，任一步失败、超时（`composeTimeoutMs`，默认 120 秒），或者记忆块超过被替换内容大小的一半（DSH 要求检查点小于被替换内容，插件留了余量），都会回退到 `compaction-basic` 的默认摘要，对应片段改为后台总结。DSH 不会因此崩溃。子 agent 会话总是用默认摘要，也不被捕获。

`compactionMode` 的取值：

- `auto`（默认）：此 agent 的压缩服务是本插件的引擎，**并且**没有检测到其他压缩插件时，用引擎模式；否则用辅助模式。新装的 Web/Desktop 会落在辅助模式，要先[接管压缩](#启用引擎模式接管压缩)。
- `engine`：要求引擎模式。引擎未接管时退回辅助模式，并在状态里说明原因。
- `assist`：始终用辅助模式。
- `off`：不注入记忆，不生成记忆检查点，也不做空闲整理。捕获、后台总结和回忆工具照常工作。

`/memory status` 和设置页会显示每个会话实际生效的模式和原因。修改设置、接管或还原、会话切换 agent 预设之后，模式会重新判断。

### 空闲整理（"睡眠整理"）

agent 变为空闲并保持 20 秒（期间状态有任何变化就重新计时），如果上下文压力超过 `idleCompactRatio`（默认 0.5），插件会调用该 agent 压缩引擎的 `compactNow()`，把压缩挪到你不用等的时候。触发条件：
- 每个 agent 两分钟内最多尝试一次，任何一次压缩完成后的两分钟内也不尝试；
- 可压缩的区间太短时跳过；
- 子 agent 和 `off` 模式不做。

两种模式都可用：引擎模式下得到记忆检查点，辅助模式下得到宿主摘要。另外，空闲超过 `idleMinutes` 时，未压缩的尾部会被封存为片段，但上下文不变。这样每段完整对话都有自己的总结和摘要。

### 遗忘与召回强化

每个片段有一个保留分：

```
T = 0.5^(Δt / (h·S)) × (0.5 + I/20)
```

- Δt：距上次被回忆（没有则用片段结束时间）的天数；
- h：`halfLifeDays`（默认 14）；
- S：1 + 被回忆次数；
- I：重要度（1–10）。

分数越低，越容易从摘要降为总结，最终被时期总结吸收或省略。用 `memory_read` 读取一个片段（读摘要，或从第一页读到了原文记录；继续翻页不再计数）会让 S 加 1 并刷新回忆时间，下次打包时它会"回暖"。"遗忘"只改变注入层级，**从不删除文件**。`memory_pin` 让片段优先保留，`memory_hide` 让它不再出现（可撤销）。

### 时期总结（rollup）

远期层（总结 + 时期总结）超过配额时，后台任务按以下规则合并：
1. 先把已结束、且早于 7 天的 ISO 周合并为周总结 `rollups/2026-W47.md`；
2. 至少两周都有周总结的月份，再合并为月总结 `rollups/2026-11.md`。

置顶、隐藏和最近 7 天内的片段不参与合并。片段在合并之后才被隐藏时，包含它的时期总结以及在其之上合并的月 / 年总结都不再注入记忆块，其中仍可见的片段改为照常逐条打包。时期总结不在压缩路径上生成，压缩时只读取已有的。

后台任务的限制：
- 单次超时 5 分钟；
- 失败后从 30 秒开始指数退避，最多 30 分钟，最多 8 次。用完次数后，片段标为失败，时期总结记为已放弃（`state.json` 的 `exhaustedRollups`），都不再自动重新排队，`/memory summarize-now` 会重试它们；
- 连续失败 5 次熔断 30 分钟；
- 每天最多 200 次。

## 安装

**要求**：
- Node.js ≥ 24.9；
- DSH `>=0.2.2-rc.5 <0.3.0-0`（已验证 `0.2.2-rc.5`）；
- `PATH` 中有 `pnpm`，因为 `dsh plugin add` 会调用它。

### Web / headless profile（CLI）

本包**尚未发布到 npm**。发布之后可以按包名安装：

```sh
dsh plugin --profile web add dsh-memory-cloud-brain
```

在那之前，直接从 GitHub 安装（这条路径还没有做端到端测试）：

```sh
dsh plugin --profile web add github:WenXin-L/dsh-memory-cloud
```

仓库里没有构建产物 `lib/`，pnpm 取得源码后会运行本包的 `prepare` 脚本（`tsdown`）构建，再安装构建结果。pnpm 10.26 起默认拦截 git 依赖的 `prepare`，第一次安装可能报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。这时在 profile 的 `pnpm-workspace.yaml`（`$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml`）的 `allowBuilds` 中，把 pnpm 报错里给出的键设为 `true`，再运行一次同样的命令。键要照抄报错输出：对 git 依赖，pnpm 11 不认只写包名的键。

也可以从本地 checkout 安装（pnpm 以 `link:` 方式链接；端到端测试用的就是这种方式）：

```sh
git clone https://github.com/WenXin-L/dsh-memory-cloud.git dsh-memory-cloud-brain
cd dsh-memory-cloud-brain
pnpm install
pnpm build
dsh plugin --profile web add "$PWD"
```

或者打一个 tarball 再安装（这条路径还没有做端到端测试）：

```sh
npm pack                     # 生成 dsh-memory-cloud-brain-0.1.0.tgz
dsh plugin --profile web add ./dsh-memory-cloud-brain-0.1.0.tgz
```

headless 和 SDK 宿主同理，把 `--profile web` 换成对应的 profile，例如 `--profile headless`。headless 下启用引擎模式的方法见[下一节](#headless--sdk)。

### Desktop

在 Desktop 应用中打开 **Plugins → Add plugin**，输入包名 `dsh-memory-cloud-brain`（发布后）、`github:WenXin-L/dsh-memory-cloud` 或 tarball 的绝对路径，然后启用。Desktop 自己管理它的 profile。Desktop 上尚未实际测试过本插件。

### 重启说明

- 装好后如果插件没有出现在列表中，或者界面提示需要重启，就重启 DSH（`dsh --profile web …` 或 Desktop 应用）。
- 修改 `storageRoot` 需要重启；其他设置都会立即生效。
- headless/SDK 的接管与还原需要重启，Web/Desktop 的预设接管不需要。
- 接管和还原都只影响**新建的会话**。

安装后在会话中运行 `/memory status`，确认插件已加载，并查看当前模式。

## 启用引擎模式（接管压缩）

### 为什么需要手动接管

Web（和 Desktop）的 Standard 预设在一个**隔离的压缩组**里自建压缩引擎（`preset-standard` → `compaction` 组：`compaction-basic` / `command-compact` / `tool-result-pruner`），宿主级的 `compaction-basic` 在这些 profile 里本来就是停用的。插件的 bundle patch 无法按 id 改到这个嵌套组，所以安装本身只能让插件以辅助模式运行，引擎模式需要你明确接管一次。

### Web / Desktop

在 Plugins 页面打开本插件的设置页，点 **接管压缩**；或者在会话里运行：

```
/memory takeover            # 默认接管 standard 预设
/memory takeover <preset>   # 其他带压缩组的预设
```

接管时，插件通过 DSH 的配置编辑器（`ctx.configEditor`）改写当前 profile 的 `cordis.patch.yml` 里 `preset-standard` 这一行：在 `compaction` 组最前面插入 `dsh-memory-cloud-brain/engine`，并停用组内的 `compaction-basic`。其他内容（包括你自己的修改）原样保留。

- **只影响新会话**：已打开的会话继续用原来的引擎。不需要重启。
- **可以还原**：设置页的 **还原** 按钮，或 `/memory restore [preset]`，会把这一行恢复为继承值，profile patch 中的覆盖随之删除。
- **跟随 DSH 升级**：插件启动约 10 秒后，会检查记录的接管是否基于旧版预设。如果是，就在新版预设上重新应用；如果你手动改过，就在状态中标为"已被手动修改"，不再自动改动。
- 接管失败会给出原因代码。例如 `overridden` 表示这一行被更高层（home patch 或 `--patch`）覆盖了，配置编辑器写不进去。

### headless / SDK

没有 agent 预设的 profile 使用宿主级压缩。本插件的 bundle 自带一行**默认停用**的 `dsh-memory-cloud-brain-engine`。接管时，插件通过插件管理器停用 `compaction-basic`、启用这一行，然后**需要重启**。还原时两行恢复原样。headless 没有输入斜杠命令的界面，有三种方式：

- SDK 宿主中调用 `ctx.get('memoryCloud')?.api.takeover()`（还原用 `.restore()`），见 [`docs/host-api.md`](host-api.md)；
- 能执行斜杠命令的宿主中运行 `/memory takeover`；
- 手动在 profile 的 `cordis.patch.yml` 中写入（与插件管理器写入的内容相同）：

  ```yaml
  - id: compaction-basic
    disabled: true
  - id: dsh-memory-cloud-brain-engine
    disabled: false
  ```

引擎行接受 `compaction-basic` 的全部配置项，另外加一项 `composeTimeoutMs`（默认 120000）。

## 设置

### 设置页

Plugins 页面中本插件的设置页包括：
- **运行状态**：生效模式、实际预算、防火墙（未匹配规则的会话当前怎么处理）、各作用域的片段统计、后台任务、接管状态、共存提示、最近一次回退、存储位置；
- **压缩档位**；
- **压缩模式**；
- **接管压缩 / 还原**；
- **高级设置**（折叠，第一次展开时读取），包含其余全部实时配置项：
  - 后台总结：`summarizer.provider` / `model` / `reasoningEffort`；
  - 捕获与遗忘：`idleMinutes`、`idleCompactRatio`、`halfLifeDays`、`maxEpisodeTokens`、`captureReasoning`；
  - 档位覆盖：`overrides.*`，留空即沿用档位自身的数值。输入框中的灰字在已知时是当前会话按其模型算出的实际值，否则是该档位的预设上限。覆盖值跳过"不超过上一档"的限制（见[压缩档位](#压缩档位默认-3)），所以填入预设上限可能比留空得到更大的值；
  - 作用域规则：增删、上下移动 `scopeRules`，以及[未匹配规则的会话](#未匹配规则的会话unmatchedsessions) `unmatchedSessions`。

高级设置在浏览器中先检查数字范围，以及 `$n` 是否超过匹配模式的通配符个数；宿主写入前再按配置 schema 检查一遍，不通过就整体不写。表单有"放弃修改"和"恢复默认"两个按钮，"恢复默认"只把出厂值填进表单，点保存才写入。

修改立即生效，写入当前 profile 的 `cordis.patch.yml`。只有 `storageRoot` 不能在设置页修改：要编辑 `cordis.patch.yml` 并重启。设置页通过 DSH 的 Typert Remote（SRC 模式）调用宿主；用不了时，可以改用 `/memory` 命令或手动编辑 `cordis.patch.yml`（见下文）。

### 压缩档位（默认 3）

K = 1024 tokens。W 为模型上下文窗口，O 为输出预留。

| 档位 | 触发压缩（工作记忆上限） | 压缩后保留原文 | 记忆块预算 M | 近期摘要 个数 × tokens | 每条总结 | 单次回忆上限 |
|---|---|---|---|---|---|---|
| 1 轻 | 0.8W（宿主默认） | 0.16(W−O) | 48K | 10 × 1500 | 80 | 16K |
| 2 | 256K | 48K | 32K | 8 × 1000 | 60 | 12K |
| **3 默认** | **128K** | **24K** | **24K** | **6 × 800** | **50** | **8K** |
| 4 | 64K | 12K | 12K | 4 × 500 | 35 | 4K |
| 5 极简 | 32K | 6K | 6K | 2 × 300 | 25 | 2K |

表中是上限，实际值按模型窗口从 1 档开始逐档计算（`src/pack/budget.ts`）。记 A = W − O − H，H 为引擎余量 `headroomTokens`（默认 8192）。第 n 档的各项值如下：
- **触发点** `Tₙ = min(档位值, A, Tₙ₋₁)`，其中 1 档为 `min(0.8W, A)`；
- **保留原文**：1 档为 `0.16(W − O)`，其他档为档位值，且不超过上一档；
- **记忆块** `M = clamp(min(档位值, 0.25A), 2K, 档位值)`，且不超过上一档；
- **60% 规则**：要求 `M + 保留原文 < 0.6T`，避免压缩后立刻又触发压缩。超出时两者按比例缩小，M 至少保留 2K（允许量不足 2K 时取全部允许量），余下的给保留原文。缩小后的值仍不超过上一档；
- **单次回忆** `max(512, min(档位值, 0.25T))`，且不超过上一档。

`overrides` 中设置的字段不受"不超过上一档"的限制，但仍受窗口和 60% 规则约束。近期摘要条数、每条摘要和总结的长度直接取档位值（再按各层配额收紧），不参与逐档比较。

**档位单调**：触发点、保留原文、记忆块和回忆上限从 1 档到 5 档只会相等或变小，任何窗口下都不会出现高档位比低档位更大的情况。因此窗口较小时，高档位会退回 1 档（宿主默认）的数值：
- 窗口低于 320K 时 `0.8W < 256K`，2 档的触发点等于 1 档；低于 160K 时，3 档也等于 1 档；
- 例如 128K 窗口（O = 2000）下，1–3 档都在 104 857 tokens 触发，保留原文都是约 20K，3 档只是记忆块（24K）和回忆上限（8K）更小；
- 32K 窗口（O = 2000）下，五个档位的触发点、保留原文和记忆块完全相同（22 576 / 4 922 / 5 644），只有回忆上限和近期摘要条数、长度不同。

模型不报告上下文窗口时，插件按 W = 32K 估算记忆块和回忆上限，状态里窗口显示为"未知，按默认估计"；引擎模式下，插件不改写这类模型的压缩阈值，沿用引擎行自身的配置。

`/memory status` 会显示当前会话实际算出的数值。注意：
- 辅助模式下只有记忆块和回忆上限受档位控制；
- 档位 4–5 压缩更频繁，更多上下文会从"缓存命中价"变成"全价重算"，不一定更省钱；
- `/memory rebuild` 会按当前档位的长度重新生成已有的总结和摘要。

### 全部配置项

除 `storageRoot` 外，下表各项都能在设置页的高级设置中修改。也可以在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中按行 id 手动配置（`$DSH_HOME` 默认是 `~/.dsh`）：

```yaml
- id: dsh-memory-cloud-brain
  config:
    level: 3
    compactionMode: auto
    idleMinutes: 30
    overrides:
      memoryBudgetTokens: 16000
```

> 这一行的 `config` 会被整体替换，不做深合并。设置页和 `/memory level|mode` 写的也是这里，手动编辑时要保留已有的字段。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `level` | `3` | 压缩档位 1–5 |
| `compactionMode` | `auto` | `auto` \| `engine` \| `assist` \| `off` |
| `storageRoot` | 空 = `$DSH_HOME/memory-cloud` | 存储根目录；**修改需要重启** |
| `idleMinutes` | `30` | 空闲多久后把未封存的尾部封存为片段 |
| `idleCompactRatio` | `0.5` | 空闲时上下文压力超过多少就执行 `compactNow()` |
| `halfLifeDays` | `14` | 遗忘半衰期（天） |
| `maxEpisodeTokens` | `32768` | 单个片段原文超过此大小即封存；`0` 表示不按大小封存 |
| `captureReasoning` | `true` | 原文存档是否保留模型的推理内容 |
| `summarizer.provider` | 空 | 后台总结用的 provider；空表示用当前默认模型的 provider |
| `summarizer.model` | `deepseek-flash` | 后台总结用的模型；无法解析时退回默认模型并记一条警告 |
| `summarizer.reasoningEffort` | `off` | 后台总结的推理强度；空表示用适配器默认值；模型不支持时忽略 |
| `overrides.*` | — | 覆盖当前档位的单项：`workingMemoryTokens`、`retainTokens`、`memoryBudgetTokens`、`recentSummaryCount`、`recentSummaryTokens`、`gistTokens`、`recallLimitTokens`；仍受最小值和模型窗口约束 |
| `scopeRules` | `[]` | 作用域规则，见下文 |
| `unmatchedSessions` | `auto` | `auto` \| `owner` \| `isolated`：没有匹配任何作用域规则的会话怎么处理，见下文 |

引擎模式下，压缩检查点的那次调用使用**会话本身的模型**（为了共享前缀缓存），不使用 `summarizer.*`。

### 作用域与隐私防火墙

每个会话属于一个作用域，作用域之间的记忆完全隔离：记忆块、压缩检查点和回忆工具都只读写本作用域。主人（`owner`）的记忆只对**私有的 owner 决定**开放，会话只有两种方式得到它：
- 一条作用域**字面写作** `owner` 的规则匹配了这个会话；
- 没有规则匹配，并且 [`unmatchedSessions`](#未匹配规则的会话unmatchedsessions) 的决定是 owner。

注入、引擎检查点和回忆工具都通过同一个检查 `canReadScope`（`src/scope/guard.ts`）：会话只能读自己的作用域，读 owner 还必须是私有的 owner 决定。检查不通过时，不注入记忆块，引擎检查点退回宿主摘要，工具返回 `Memory is not available in this session.`。

**这就是群聊防火墙：主人的私密记忆不进入群聊或访客会话。**

#### 作用域规则

规则按顺序尝试，第一条匹配到会话任一标签的规则生效。匹配不区分大小写。
- **glob 语法**：`*` 匹配任意字符（包括 `:` 和 `/`），`?` 匹配一个字符，`\` 转义下一个字符。
- **作用域模板**：`$1`…`$9` 代入各通配符捕获的内容，`$&`（或 `$0`）代入整个标签，`$$` 表示字面 `$`。
- **`$n` 校验**：模板用到的 `$n` 超过匹配模式里通配符（`*` 和 `?`）的个数时，这条规则被跳过，并记一条警告。设置页和 `setConfig` 直接拒绝保存这样的规则。
- **捕获为空**：某个 `$n` 捕获到空串时，代入整条标签的哈希，避免不同标签合并成同一个作用域。
- **展开成 `owner`**：模板不是字面的 `owner`、但展开（规范化）后等于 `owner` 时（例如 `$1` 捕获到 `owner`），作用域改为 `owner-<哈希>`，**不会**得到主人的记忆。
- **作用域 id**：会被规范为小写 `[a-z0-9_-]`，最长 64 个字符；需要改写时附加原文的哈希，避免两个作用域被合并。

示例（QQ）：

```yaml
- id: dsh-memory-cloud-brain
  config:
    scopeRules:
      - match: "qqbot:*:private:10001"   # 主人自己的私聊，仍用 owner
        scope: owner
      - match: "qqbot:*:group:*"         # qqbot:<bot>:group:<群号> → qq-group-<群号>
        scope: "qq-group-$2"
      - match: "qqbot:*:private:*"       # 其他人的私聊，每人一个作用域
        scope: "qq-user-$2"
```

每个会话自动带有 `preset:<预设名>`、`cwd:<工作目录>`、`session:<会话 id>` 这几个标签，也可以用来写规则（例如 `cwd:/home/me/qq-rooms/*`）。子 agent 不按自己的标签解析：它沿 `parentSession` 找到委派链最上层的会话，作用域跟那个会话的决定走。

DSH 的会话头没有标签字段。聊天桥接插件（或你的集成代码）应在会话创建时提供标签：

```js
ctx.get('memoryCloud')?.setSessionTags(sessionId, ['qqbot:fish:group:123456'])
```

#### 未匹配规则的会话（unmatchedSessions）

| 取值 | 行为 |
|---|---|
| `auto`（默认） | 检测到聊天桥接插件时按 `isolated` 处理，否则按 `owner` |
| `owner` | 使用私有的 owner 作用域。只在没有其他人能接触这个 agent 时使用 |
| `isolated` | 每个会话一个独立作用域 `session-<哈希>`（子 agent 用其委派链最上层会话的），看不到主人的记忆，也看不到其他会话的记忆 |

无法识别的取值按 `isolated` 处理。识别的桥接插件（按包名）：`dsh-qq-bridge`、`dsh-qqbot`、`dsh-qq-rooms`、`dsh-onebot-qq`、`dsh-wechat`。

> **注意：`auto` 检测到桥接插件后，你自己的会话也会被隔离。** 桥接会话不带可供规则匹配的标签，插件分不清哪个是群聊、哪个是你自己在 Web、Desktop 或 CLI 里开的会话，所以所有未匹配规则的会话都会被隔离，看不到以前的记忆。要让自己的会话继续使用 owner 记忆，加一条映射到 owner 的规则，例如：
>
> ```yaml
> scopeRules:
>   - match: "cwd:/Users/me/*"     # 在自己目录下打开的会话
>     scope: owner
>   - match: "preset:standard"     # 或者：所有 Standard 预设的会话
>     scope: owner
> ```
>
> 这样的规则只在桥接会话**不**满足它时才安全（桥接会话的工作目录不在该目录下、或不使用这个预设）。给桥接会话的规则放在前面，因为第一条匹配的规则生效。

> **检测不到的桥接插件**：识别列表之外的桥接插件不会触发 `auto` 的隔离，它的未打标签会话会落入 owner，**并看到主人的记忆**。使用这类桥接时，把 `unmatchedSessions` 设为 `isolated`，再用规则把自己的会话映射到 owner。

`/memory status` 显示当前会话的作用域、是否私有和原因，以及未匹配会话当前怎么处理（防火墙）；设置页的运行状态也显示后者。

**修改规则或标签之后**：
- 注入和回忆每一步都重新判断作用域，立即生效；
- 捕获在下一轮对话开始时、会话标签改变时，以及会话切换 agent 预设时（`agent-preset/selected`）重新判断；作用域变了，就把当前片段封存在原作用域，之后的记录写入新作用域；
- 已经注入到上下文里的 owner 记忆块会留到下一次压缩（插件会记一条警告）。如果这个会话不能再看到主人的记忆，请新开一个会话。

## 工具与命令

### 模型可用的工具

所有工具只访问当前会话所在作用域，并经过同一个 `canReadScope` 检查（见[作用域与隐私防火墙](#作用域与隐私防火墙)）。

| 工具 | 参数 | 作用 |
|---|---|---|
| `memory_search` | `query`，`from` / `to`（`YYYY-MM-DD`、`YYYY-MM` 或 `YYYY`，分隔符可用 `-`、`/` 或 `.`；或严格的 ISO 日期时间 `YYYY-MM-DDTHH:mm[:ss[.sss]][Z\|±hh:mm]`，`T` 可写成空格，不带时区按本地时间；其他写法直接报错），`limit`（默认 8，最多 50），`includeRaw` | 中英文关键词、人名、日期搜索（中文二元组 + BM25 式打分），返回真实命中总数和 `#id 日期 总结`；`includeRaw` 会额外扫描原文（有上限） |
| `memory_read` | `id`，`level`：`summary`（默认）\| `gist` \| `raw`，`offset` / `limit`（原文分页，默认 40，最多 200），`includeSystem` | 读一个片段的摘要、总结或原文。原文默认隐藏系统记录，只含对话（用户 / 助手消息、工具调用与结果），隐藏的条数在结果的 `hiddenRecords` 中报告；`includeSystem: true` 才显示运行时提醒、压缩检查点、注入的记忆块和日志事件，此时偏移量按全部记录计算，翻页时要保持同一取值 |
| `memory_timeline` | `id`，`before` / `after`（默认 3，最多 20） | 查看前后片段的带日期总结 |
| `memory_pin` / `memory_unpin` | `id` | 置顶 / 取消置顶 |
| `memory_hide` / `memory_unhide` | `id` | 从记忆块和搜索中隐藏 / 恢复，不删除任何东西；包含隐藏片段的时期总结也不再注入（见[时期总结](#时期总结rollup)） |
| `memory_note` | `action`（`list`、`add`、`replace`、`remove`），`text`，`oldText` | 私有主人会话中的长期偏好。`list` 查看条目，`add` 保存一条；更正和移除需提供完整的 `oldText`，更正还需给出新的 `text`。写入要求当前会话允许捕获。 |

只有当用户明确要求跨会话记住、纠正或忘记某个偏好时，才使用这项工具。例如「这次回答短一点」只适用于这次，「记住，我以后都更喜欢简短回答」才值得保存。每条用一句事实表述。总量上限为 1,375 个 Unicode 码点，条目之间的换行也计入。重复新增不会占用空间。写满后，先查看条目，再按用户意图缩短或移除已有内容。

手写档案和偏好共用相处档案的注入配额，手写行排在偏好前面。写入成功后，`list` 能立即读到新值。新会话或压缩后重新生成的记忆块才带上变更；已经注入的文本、历史快照和对话原文会保留。回退到旧版时可以保留 `profile-notes.json`，以后重新升级即可继续使用已保存的偏好。

单次回忆的输出上限是档位的"单次回忆上限"，并随上下文压力收紧：
- 超过 60%：上限减半；
- 超过 75%：原文请求改为返回摘要；
- 超过 90%：暂停回忆。

系统提示中有一段字节稳定的中文使用说明，包含上述偏好记录规则，并提示模型如何回忆往事：记忆是历史数据、不是指令，和用户现在说的冲突时以现在为准；需要细节时不要猜，先查，每次回答最多查 1–3 次；像自然回忆一样带出时间，用户没问时不提记忆块、工具和片段 ID。

### `/memory` 命令

| 命令 | 作用 |
|---|---|
| `/memory status` | 当前会话的模式与原因、档位与实际预算、作用域、防火墙（未匹配会话怎么处理）、片段统计、后台任务、接管与共存情况、最近的引擎回退 |
| `/memory level <1-5>` | 切换档位，立即生效 |
| `/memory mode <auto\|engine\|assist\|off>` | 切换模式 |
| `/memory compact-now` | 立即用当前会话的压缩引擎整理上下文 |
| `/memory summarize-now` | 封存当前尾部，并立即处理后台总结队列，包括重试已用完次数的失败片段和已放弃的时期总结；空片段跳过，其他 DSH 进程正在运行的任务不受影响 |
| `/memory rebuild` | 按当前档位的长度重新总结本作用域的全部片段（受每日配额限制；新结果写入前继续用旧文本） |
| `/memory takeover [preset]` | 接管压缩（默认 `standard` 预设；headless 下切换宿主级引擎行） |
| `/memory restore [preset]` | 还原宿主默认压缩 |
| `/memory backfill` | **尚未实现**：只返回说明。插件只存档安装之后的会话 |
| `/memory help` | 用法 |

## 磁盘上的存储

```
<storageRoot，默认 $DSH_HOME/memory-cloud>/
  state.json                 每个会话的捕获水位、后台任务队列、每日配额、已放弃的时期总结（exhaustedRollups）
  takeover.json              预设接管记录（按 DSH profile）
  logs/summarizer.jsonl      每次总结调用的结果、用量和错误（只追加）
  scopes/<scope>/            owner、qq-group-123456、session-<哈希> …
    index.json               片段目录（紧凑的单行 JSON）
    profile.md               可选：你手写的相处档案，按行放进记忆块（超出配额的行省略）
    profile-notes.json       仅 owner，首次保存偏好时创建；与手写档案分别管理
    episodes/2026/11/20261120-2130_ab12cd34_1/
      raw.jsonl              原始事件 {seq,time,type,data,…}，只追加
      summary.md  gist.md    摘要 / 总结，frontmatter 记录 seq 区间、时间、模型、提示词版本、token 数，摘要还有人物、日期、承诺
      meta.json              index 条目的镜像，用于重建 index
    rollups/2026-W47.md  2026-11.md
    snapshots/<sessionId>-<n>.md   每个实际注入的记忆块或压缩检查点（便于审计）
```

- **全是普通文件**（JSON、JSONL、Markdown），写入都是"临时文件 + rename"的原子写。
- **不删除任何东西**：
  - 原文只追加；
  - `summary.md`、`gist.md` 和时期总结被覆盖（重新总结、`/memory rebuild`、重新合并）前，内容不同的旧文件会保留为 `<文件名>.prev-<时间戳>`；
  - `index.json`、`state.json` 或 `meta.json` 损坏时保留为 `<文件名>.corrupt-<时间戳>`。

  这些副本不会自动清理。
- **可以自愈**：`index.json` 丢失或损坏时，从片段目录和 `meta.json` 重建。
- **方便 git 备份**：可以直接把 `storageRoot` 当作一个 git 仓库，或者用任何文件同步工具备份。建议在 DSH 空闲时提交，并忽略临时文件：

  ```gitignore
  *.lock
  *.clear
  *.tmp
  ```

**多个 DSH 进程共用一个存储**（例如 Web 和 Desktop 使用同一个 `DSH_HOME`）：
- 写 `index.json`（每个作用域一把）和 `state.json` 前都先拿跨进程文件锁，最多等 10 秒。超过 5 秒没有变化的锁文件，以下情况由插件清除：
  - 写锁时被中断留下的残缺锁文件；
  - 记着本进程 PID、但写于本进程启动之前的锁（之前用过同一 PID 的进程留下的）；
  - 系统上次启动之前留下的锁，并且它的 PID 现在被某个存活进程复用。

  其他情况（例如锁里的 PID 已经退出）交给 DSH 自己的锁接管处理；
- 每个打开的片段在 index 中记录打开或接管它的进程（PID 和进程启动时间），封存时清除。过期片段清扫在启动时运行，之后最多每 5 分钟运行一次；它只封存超过 `idleMinutes` 的片段，并跳过仍在运行的其他进程的片段。如果记录的 PID 现在属于一个比原进程晚 5 分钟以上启动的进程，就视为原进程已退出（PID 被复用）。这项检查用 `ps` 读取进程启动时间；在 Windows 等取不到启动时间的环境中不做，沿用旧规则：PID 仍存活就视为原进程；
- 另一个进程已经封存的片段不能再追加：追加会被拒绝（`EpisodeNotOpenError`），捕获从已封存的区间之后接着写入一个新片段；
- 后台任务队列和每日配额保存在 `state.json` 中，各进程共享。领取任务时加租约（任务超时 5 分钟再加 60 秒），其他进程会跳过租约中的任务，`/memory summarize-now` 和 `/memory rebuild` 的强制执行也不例外；被推迟或取消的任务退还配额。

- **原文是完整的对话记录**：包括工具结果和（默认）推理内容。备份到远程时请使用私有仓库。

## 隐私

- **总结调用不随 DeepSeek 会话日志上传**：后台总结、时期总结和引擎模式的检查点总结都使用自定义 purpose `memory-cloud-summarize`，并且**不携带 `sessionId`**。插件还在 `dsh-session-log-deepseek` 中为这个 purpose 注册了上传排除规则。
  - 这些调用本身仍然会发给你配置的模型 provider。
  - 引擎回退时调用的是 DSH 自己的默认摘要（`purpose: compaction`），它和普通 DSH 压缩一样处理。
  - 注入到会话里的记忆块是会话消息的一部分，会和其他消息一样，随 DSH 的会话日志设置处理。
- **作用域防火墙**：见[作用域与隐私防火墙](#作用域与隐私防火墙)。
- **数据只在本地**：插件不做任何网络同步。没有实现脱敏。

## 与其他记忆 / 压缩插件共存

- 插件按包名识别一份已知列表：
  - **压缩插件**：`dsh-taskfold`、`dsh-ebbing-context`、`dsh-ctxopt-compaction`、`dsh-context-maid`、`dsh-world/compaction`、`dsh-brain-compaction`、`flowctx-dsh`；
  - **记忆插件**：`dsh-memory`、`dsh-codex-memories`、`dsh-engramory`、`dsh-auto-memory`、`dsh-world`、大肥鱼生态的若干插件；
  - **聊天桥接**：`dsh-qq-bridge`、`dsh-qqbot`、`dsh-qq-rooms`、`dsh-onebot-qq`、`dsh-wechat`。
- 检测到其他**压缩插件**时，`auto` 模式退回辅助模式，不和它争夺压缩引擎。
- 检测到**聊天桥接**时，`unmatchedSessions: auto` 会隔离未匹配规则的会话，并在状态中提示（见[未匹配规则的会话](#未匹配规则的会话unmatchedsessions)）。
- 检测到其他**记忆插件**时，只在状态中提示可能重复注入、重复占用上下文。建议一个 profile 只保留一个负责注入记忆的插件。
- **工具名冲突**：`dsh-memory`、`dsh-codex-memories` 也注册 `memory_search` / `memory_read`，`dsh-world` 注册 `memory_read`。DSH 不允许重名工具，后注册的一方会失败。本插件的回忆工具要么全部注册、要么全部不注册；失败时 `/memory status` 会显示"回忆工具：未注册"及原因，记忆块注入不受影响。`/memory` 命令名同理。
- 列表之外的插件识别不到。辅助模式保留宿主或其他插件的压缩摘要，只在其后补充记忆块。
- 本插件不自带人设，记忆块和人设分开。

## 局限与尚未验证的部分

- **真实 DeepSeek 请求与前缀缓存没有测过**：端到端测试只用假模型。下面这些都是设计目标，没有量过 `prompt_cache_hit_tokens`：
  - 记忆块每会话冻结一次，保证字节稳定；
  - 引擎模式按宿主做法重放被压缩区间，以命中前缀缓存。

  总结调用不带 `sessionId`，这对 DeepSeek 路由和缓存的影响也未知。档位数值是初值，需要实测调优。
- **Desktop 没有测过**：Desktop 的 profile 组合未经验证，预设接管应该与 Web 相同，但没有实际跑过。
- **`/memory backfill` 尚未实现**：安装之前的会话不会被导入。
- **设置页依赖 SRC 模式的 Remote**：设置页靠 DSH Typert Gateway 的 SRC 模式发现宿主服务（第三方拿不到生成的严格接口）。DSH 若改变这一机制，设置页会读不到状态，此时请用 `/memory` 命令或手动编辑 `cordis.patch.yml`。设置页（包括高级设置）还没有在浏览器里实际渲染测试过。
- **桥接标签与识别**：
  - 没有任何桥接插件已知会调用 `setSessionTags`，`qqbot:…` 这类规则要等桥接提供标签后才有用；QQ/微信桥接的会话元数据也没有实际验证过；
  - 桥接插件只按包名识别，列表里的包名和行布局没有在真实安装中验证过，列表之外的桥接识别不到（此时请用 `unmatchedSessions: isolated`）；
  - `auto` 检测到桥接后，你自己的未匹配会话也会被隔离，直到你加上映射到 owner 的规则。
- **多进程**：Web 和 Desktop 共用一个 `DSH_HOME` 时的锁、片段归属和任务租约只有单元测试覆盖（包括跨进程锁），端到端测试没有同时运行两个 DSH 进程。
- **其他没有在真实环境中验证的部分**：
  - 用打包好的 tarball 或 `github:` 地址安装（端到端测试用的是 `link:` 安装）；
  - DSH 升级后自动重新应用接管；
  - 通过界面输入斜杠命令（命令只在宿主侧用 `ctx.commands.execute` 测过）；
  - `standard` 以外的预设接管。
- **小窗口下的档位**：窗口低于约 320K 时，高档位会退回 1 档的触发点和保留原文，档位之间的差别变小（32K 窗口下只剩回忆上限和摘要条数、长度的差别）。
- **不报告窗口的模型**：按 32K 估算记忆块和回忆上限，可能比实际需要的小。
- **恢复的 headless 会话**：压缩区间可能跨过之前已封存的片段，这时检查点的总结不会存给当前片段（改为后台总结），检查点里也可能重复已有片段中的事实。
- **token 计数是估算**：中文按 `(0.6×中文字符 + 0.3×其他字符) × 1.15` 估算，DSH 自己的计数按 4 字符 / token（中文会被低估）。插件已为此换算保留原文的大小，但数字仍是近似值。

## 开发

```sh
pnpm install
pnpm build       # tsdown → lib/index.js（宿主）、lib/engine.js（压缩引擎）、lib/client.js（设置页）
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
```

端到端测试（在真实 DSH 中用假模型运行，不需要 API key，约 3 分钟）：

```sh
node scripts/e2e/run-e2e.mjs                 # 安装 DSH 0.2.2-rc.5（约 1.2 GB）到临时目录并跑全部场景
node scripts/e2e/run-e2e.mjs --keep          # 保留临时目录（日志、DSH home）
node scripts/e2e/run-e2e.mjs --only s1,s2 --skip-build --dsh-dir /path/with/node_modules/.bin/dsh
```

覆盖的场景包括：headless 接管与压缩、新会话注入与回忆、切换档位、总结失败回退、辅助模式、Web 预设接管、关闭进程。详见 [`scripts/e2e/README.md`](../scripts/e2e/README.md)。

更多文档：
- 更新日志：[`CHANGELOG.md`](../CHANGELOG.md)
- 设计：[`docs/superpowers/specs/2026-11-23-memory-cloud-design.md`](superpowers/specs/2026-11-23-memory-cloud-design.md)
- 已核实的 DSH 事实：[`docs/dsh-api-notes.md`](dsh-api-notes.md)
- 宿主 API（`ctx.memoryCloud`）：[`docs/host-api.md`](host-api.md)

## 许可

本项目以 [GNU 通用公共许可证第 3 版（GPLv3）](../LICENSE) 发布（SPDX：`GPL-3.0-only`）。
