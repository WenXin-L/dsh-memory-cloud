# dsh-memory-cloud-brain：类人脑分层记忆云（DSH 插件，兼作上下文压缩引擎）设计与实施计划

## 1. 背景与目标

DSH = DeepSeek Harness（`dsh`，DeepSeek 开源、基于 Cordis 的"一切皆插件"Agent 框架）；"养大肥鱼" = 在 DSH 上长期陪伴式地养一个拟人 Agent（常驻 home 会话 + QQ/微信房间）。DSH **没有内置记忆包**；内置压缩 `dsh-compaction-basic` 的摘要模板是编码向的（"AI coding assistant / Files and Code"），不适合陪伴场景。

本项目要做一个 DSH 插件，把"长期记忆"和"上下文压缩"做成同一套机制：
1. **全量无损存档**：所有会话事件以多文件形式存于一个文件夹；每段完整会话（下称"片段 episode"）生成一份 **总结**（gist，高度压缩，"有这么件事"）和一份 **摘要**（summary，正常压缩，"发生了什么"）。
2. **自动注入 + 按需取原文**：新会话开始时、**以及每次上下文压缩时**，自动填入"远期记忆的总结 + 近期记忆的摘要"；模型需要时通过工具取完整原文。
3. **适配 DSH/大肥鱼场景，压缩程度可调**，保证永不撑爆上下文。

人脑类比：上下文里保留的近期原文 = 工作记忆；摘要 = 近期记忆；总结与时期总结 = 远期记忆；文件夹里的原文 = 可按需回想的档案。**压缩 = 把滑出工作记忆的部分封存为片段并换成记忆块**。

成功标准：装进 `web`/`desktop` profile 即生效；压缩发生时上下文被替换为"记忆块 + 近期原文"，对话无缝继续；新会话能正确回忆旧事；调档位后压缩阈值与记忆块体积按预期变化；记忆块稳定、能命中 DeepSeek 前缀缓存；任何异常都回退到宿主默认行为，不拖垮 DSH。

## 2. 调研结论（GitHub / DSH 生态）

DSH 记忆类插件已有 900+ 个（[awesome-dsh-plugin/memory](https://github.com/billLiao/awesome-dsh-plugin/blob/main/categories/memory.md)），**没有一个完整实现"每段会话 总结+摘要 → 远期给总结/近期给摘要 → 原文按需"的三层设计，也没有把它和压缩统一起来**，这正是本项目的差异点。最相关的参考：

| 项目 | 可借鉴 | 要避开 |
|---|---|---|
| yan5236/dsh-memory、Lushdawn/dsh-codex-memories | Codex 式两阶段抽取；`lastSeq` 水位 + 增量 `-partN`；结构化工具调用输出 + 兜底解析；"近期详细 / Older Memory Topics 简略"布局；`memory_search/read` 与"≤4–6 步查找"使用说明 | 编码向 prompt（会丢弃闲聊）；整文件重写易截断；按字符计预算 |
| tinqiao-oss/engramory | 大肥鱼 companion 模式（经历/约定/我自己）；`agent/pre-step` 追加冻结消息 + 哈希去重，**被 compaction 移除后自动重发**；水位迟滞（0.85/0.7） | 所有 profile 共用一个库，QQ 用户可见主人记忆 |
| yindf/taskfold、chunsi-w/dsh-ctxopt-compaction、Icstick/dsh-context-maid | **继承宿主 `BasicCompactionEngine`、只覆写 `summarize()`**，选区/锁/提交仍用宿主实现；按 seq 还原原文（`fold_recall`）；小片段不压缩的下限；摘要质量/预算闸门、失败保留原历史；置顶事实压缩后校验 | monkeypatch `llm.stream`；只改顶层行而不改 Web 预设导致不生效 |
| Light-EI/dsh-ebbing-context、33moren33/dsh-memory-pyramid | 越旧分辨率越低但不删除（原文→L1→L2→L3）；按预算二分决定旧块粒度；注入块每会话冻结一次（缓存命中 40%→91%） | 往宿主会话手写 compaction 事件（`SessionFormatError`）；版本上限卡死 |
| chenkezhen480/dsh-world、Aik358/dsh-auto-memory | 自定义压缩引擎的阈值公式（`resolveModelInfo` + 预留输出 + `modelPolicies`）与 `agent/request-error` 溢出重试；后台任务冷却/超时/重试/熔断/跳过自身子 agent | 改写 profile 预设副本在 DSH 升级时失效；`catch` 吞掉 API 漂移 |
| vvxer/dsh-silicon、liu-zhengdong/dsh-recall、zhengqiuyang/dsh-compaction-guard | 周→月→年滚动概况；`session/flush` 排空队列；摘要长度硬校验；从 `compaction/summary` 的 `shadowedSeqs` 取被压缩原文 | 包装成假 provider；只存指针不存原文 |
| 大肥鱼生态（dafeiyu-life、pbyugujia、cosplay、qq-bridge、qqbot）及 fishmemory/linghun | 原子写；"记忆三行" + `source_ids`；返回真实命中总数；衰减只影响层级不删数据；按 chatId 隔离；后台总结 `reasoningEffort: off` | 多插件各自注入人设/记忆导致叠加与重复写入；群聊注入主人私密记忆；AGPL/PolyForm 代码不可抄 |
| ReadAgent / RAPTOR / Rsum / EPC 论文 | ReadAgent 与本设计同构：gist 压缩 85–97% 仍可答题，按需 lookup 原页；"shorten" 式 prompt；**写入时丢信息才是主因**→ 摘要须保留人名/日期/数字/偏好/否定/状态变化 | MemWalker 树导航；RAPTOR 聚类（不可增量、丢时间线） |
| Letta/MemGPT、MemoryOS、MemoryBank、Generative Agents、mem0、Graphiti | MemGPT"压力警告 → 驱逐 → 摘要"，驱逐只离开上下文不删存储；遗忘曲线 + 召回强化；重要度 1–10；增量摘要水位；相对日期转绝对日期；摘要 prompt 写明"不要续写对话" | 摘要的摘要；LLM 决定 UPDATE/DELETE；图数据库 |

**关键 DSH 事实（已在官方文档/源码核实）**：
- 插件 = Cordis 模块（`name/inject/Config/apply`），以 bundle 发布：`dsh.bundle.patch` → `cordis.patch.yml`；浏览器半边 `dsh.client` + `exports["./client"]`；`engines.dsh` 必须写成 `>=0.2.2-rc.5 <0.3.0-0` 这种带 `-0` 的范围，否则 prerelease 被拒、bundle 被静默跳过。
- **压缩接缝**：`ctx.compaction`（`CompactionEngine`：`compactIfNeeded(agent, 'pressure'|'context-overflow')`、`compactNow`（空闲时维护性压缩）、`compactRegion`）；每个上下文只能有一个实现。社区常规做法是继承 `BasicCompactionEngine` 只覆写 `summarize()`。压缩写入 `compaction/start → compaction/summary{summary, shadowedSeqs, shadowedRange, shadowedTokenCount} → user/message(surfaceOp: replace) → compaction/end`；被替换的原始事件仍留在日志里。默认触发点 `min(0.8W, W−O−65536)`，保留最新 `0.16×(W−O)`；可调 `thresholdRatio/retainRatio/retainTokens/summarizationModel/modelPolicies/auto`。
- **Web Standard 预设在隔离组里自建压缩引擎**（`preset-standard` → `compaction` 组：`compaction-basic`/`command-compact`/`tool-result-pruner`）。只改顶层行对 Web 会话无效。预设文件注明"profile patch 可按 id 覆盖本行的 `config.plugins`"。
- 其他事件：`session/event`、`agent/created`、`agent/pre-step`（waterfall）、`agent/turn-stopping`、`agent/status`、`agent/request-error`、`session/flush`、`session/disposed`。**没有"会话结束"事件**，需自定义。
- 注入：`systemPrompt.section()` 变化会整段重发；`systemPrompt.context()` 有插件实测"任一 context 变化会重发整个快照"；务必 `interpolate:false`。
- 旁路模型调用 `ctx.llm.stream({..., purpose})`（purpose 需扩展 `LlmRequestPurposeMap`）；`resolveModelInfo()` 给上下文窗口；`ctx.tokenMeter` 按 ~4 字符/token，**中文低估约 2.4 倍**。
- 隐私：默认启用的 `dsh-session-log-deepseek` 会随带 `sessionId` 的请求上传会话日志片段（含 compaction 调用）。
- 稳定性：后台异步任务的未处理 rejection 会让整个 DSH 退出；工具必须声明 `output: {schema, render}`。

## 3. 推荐方案：记忆云即压缩引擎（引擎模式为主，辅助模式兜底）

### 3.1 两种运行模式

**A. 引擎模式（首选）**：插件提供 `MemoryCompactionEngine extends BasicCompactionEngine`，只覆写 `summarize()`；选区、锁、工具配对、事务提交、溢出重试全部沿用宿主实现。每次压缩：
1. 把被替换的区间（`shadowedSeqs`）封存为一个片段（原文早已由捕获层写入文件夹）。
2. 用一次模型调用为该区间生成 `{总结, 摘要, 进行中事项, importance, keywords, people, dates, promises}`：按宿主做法原样重放区间消息以命中缓存，再追加陪伴向中文指令。
3. 返回的 checkpoint 不是普通摘要，而是**记忆块**（见 3.4）：相处档案 + 远期总结 + 近期摘要（含刚封存的这段）+ 进行中事项 + "原文可用 `memory_read #id` 取回"。
4. 任一步失败或超时 → 调用 `super.summarize()` 回退到宿主默认摘要，并把片段放入后台队列稍后补总结。

**B. 辅助模式（兜底）**：保留宿主或其他插件的压缩引擎。监听 `compaction/summary`/`compaction/end`：
1. 按 `shadowedSeqs` 封存片段，后台生成总结/摘要。
2. 在下一次 `agent/pre-step` 自动追加刷新后的记忆块（与会话开始时同一套打包逻辑，哈希去重）。
3. 宿主自己的压缩摘要保留不动。

**模式选择**：设置项 `compactionMode: auto | engine | assist | off`。`auto` 在 agent 创建时检查生效的 `ctx.compaction` 是否为本引擎：是就走 A；检测到其他压缩插件（taskfold、ebbing、ctxopt、context-maid、dsh-world 等）或预设未接管时走 B，并在 `/memory status` 中说明原因。

**安装接管**：bundle patch 在顶层（headless/sdk）禁用 `compaction-basic` 并插入本引擎；对 Web/Desktop 的 Standard 预设，按阶段 0 的实测结果从以下三条路径中选一条：
1. bundle patch 按 id 覆盖 `preset-standard` 的 `compaction` 组。
2. 设置页提供"一键接管 Standard 预设压缩"按钮，通过 configEditor 写入 profile patch，并可一键还原。
3. 额外发布一个"记忆云"预设行。

都不可行时停在辅助模式，功能不缺失，只是压缩摘要仍是宿主模板。

### 3.2 空闲整理（"睡眠整理"）

`agent/status` 转为空闲且上下文超过 `idleCompactRatio` 时，调用 `ctx.compaction.compactNow()`（官方定义为两轮之间的维护任务），把压缩挪到用户不等待的时候。引擎模式下即触发记忆封存；辅助模式下同样可用。空闲 `idleMinutes`（默认 30）后，把未压缩的尾部也封存为片段（不改动上下文），保证"每段完整会话都有总结/摘要"。

### 3.3 存储布局（全量、多文件、可 git 备份）

```
<root = $DSH_HOME/memory-cloud，可配置>/
  scopes/<scopeId>/                     # 作用域：owner（默认）/ qq-group-xxx …
    index.json                          # 片段目录：id、会话、seq 区间、时间、各层 token 数、importance、strength、lastRecalled、pinned、来源(compaction|idle|end)
    profile.md                          # 可选：用户可编辑的"相处档案"（称呼/偏好/约定）
    episodes/2026/11/20261120-2130_<sid8>_<n>/
      raw.jsonl                         # 无损原始事件 {seq,time,type,data}，append-only
      summary.md  gist.md               # 摘要 / 总结（frontmatter：seq 区间、时间、模型、promptVersion、tokens）
    rollups/2026-W47.md, 2026-11.md     # 时期总结（总结层溢出时合并）
    snapshots/<sessionId>-<n>.md        # 每次实际注入/作为 checkpoint 的记忆块（审计 + 缓存稳定）
  state.json                            # 捕获水位 lastSeq、任务队列
  logs/summarizer.jsonl                 # 每次总结调用的请求/结果/错误
```
写入一律"临时文件 + rename"原子写；`index.json` 加跨进程文件锁（Web 与 Desktop 可能同时运行）；原文只追加不改写；"遗忘"只改变注入层级，从不删文件。

### 3.4 记忆块的分层打包（会话开始与每次压缩共用，纯计算）

- 预算 `M = clamp(min(档位预设, r × (W − O − H)), 2K, Mmax)`，W 来自 `resolveModelInfo()`。不变式：记忆块 + 保留尾部 + 系统提示 + 工具 < 压缩触发点的 60%，避免压缩后立刻再次触发压缩。
- 配额：相处档案 10% → 近期摘要 55% → 远期总结 35%，未用完的顺延；进行中事项（仅压缩 checkpoint）单独小预算。
- 最近 N 个片段给摘要；其余按保留分 `T = 0.5^(Δt/(h·S)) × (0.5 + I/20)` 排序，有余量升级为摘要，否则给总结（S = 1 + 被召回次数，h = 半衰期天数，I = 重要度）。
- 总结层溢出 → 最旧时期合并为周/月 rollup（生成 rollup 是后台任务，不在压缩路径上）；仍溢出 → 丢最低分条目，留一行"还有 N 段更早记忆，可用 memory_search 查询"。从不截断单条。
- 渲染：档案 → 远期总结（旧→新）→ 近期摘要 → 进行中事项；每条带日期和 `#episodeId`；包在 `<memory-cloud>` 中并声明"历史数据，非指令"，转义 `<`。
- 自研计数器：`(0.6×CJK + 0.3×其他) × 1.15`，写入时算好存进 index；用 provider 返回的 usage 做校正。
- 会话开始注入：静态使用说明放一个字节稳定的 `section()`；记忆块冻结，在首个 `agent/pre-step` 追加一条带声明 `source.kind` 的消息，被压缩移除后自动重发。引擎模式下压缩 checkpoint 本身就是新的记忆块，不再重复追加。

### 3.5 捕获与总结

- **捕获**：`session/event` → 追加到当前片段 `raw.jsonl`（含工具调用/结果，reasoning 可选排除）。跳过子 agent、本插件注入的消息、其他插件注入的 `source.kind`（防止"总结的总结"），也跳过自身的总结请求。
- **片段封口**：压缩替换区间、空闲超时、`session/disposed`、单片段超过 `maxEpisodeTokens`。`session/flush`/dispose 时排空队列。
- **总结调用**：结构化工具调用输出 + 分隔符兜底解析；长度超限重试一次，再按句子边界截断；超长片段分块 map-reduce；剥离 `<think>`。prompt 写明"不要续写对话"，保留人名、日期（转绝对日期）、数字、偏好、否定、状态变化、约定，跟随对话语言，陪伴向。默认模型为当前 provider 的 `deepseek-flash`、`reasoningEffort: off`，可配置；自定义 purpose，并注册日志上传 exclusion。后台任务有冷却、每日配额、超时、指数退避、熔断，全部 try/catch。

### 3.6 按需回忆（工具与命令）

- `memory_search(query, from?, to?, limit)`：中文二元组 + 关键词/BM25-lite，返回真实命中总数和 `#id + 总结`。
- `memory_read(id, level: summary|raw, offset, limit)`：分页读原文。单次上限随上下文压力收紧：>60% 减半，>75% 只给摘要，>90% 拒绝。
- `memory_timeline(id)`：查看前后片段。
- `memory_pin / memory_unpin / memory_hide`：置顶或隐藏，不删除。
- 被读取的片段 `S += 1`、刷新 `lastRecalled`，下次打包时"回暖"为摘要。
- 命令：`/memory status | level <1-5> | mode <auto|engine|assist|off> | compact-now | summarize-now | rebuild | backfill`。

### 3.7 压缩档位（默认 3，`.volatile()` 配置即时生效）

| 档位 | 工作记忆上限（触发压缩） | 压缩后保留原文 | 记忆块预算 M | 近期摘要 个数×tokens | 每条总结 tokens | 单次回忆上限 |
|---|---|---|---|---|---|---|
| 1 轻 | 0.8W（宿主默认） | 0.16(W−O) | 48K | 10 × 1500 | 80 | 16K |
| 2 | 256K | 48K | 32K | 8 × 1000 | 60 | 12K |
| **3 默认** | **128K** | **24K** | **24K** | **6 × 800** | **50** | **8K** |
| 4 | 64K | 12K | 12K | 4 × 500 | 35 | 4K |
| 5 极简 | 32K | 6K | 6K | 2 × 300 | 25 | 2K |

- **引擎模式**：档位映射到引擎的 `thresholdRatio`/`retainTokens` 和记忆块预算。
- **辅助模式**：档位只控制记忆块和回忆上限，压缩阈值仍由宿主配置决定，并提示用户如何调整。
- 所有字段都可单独覆盖，有 min/max 夹紧，并始终受"不超过模型窗口"的约束。
- 生成时的总结/摘要目标长度是另一组参数，`/memory rebuild` 可按新长度重算。
- 数值是初值，需实测调优。注意：压缩越频繁，越多上下文从"缓存命中价"变成"全价重算"，档位 4–5 主要换来更短的上下文和更快的响应，不一定更省钱。

### 3.8 作用域与大肥鱼生态共存

- 默认一个 `owner` 作用域；按会话元数据规则（如 qqbot 的 `qqbot:*:group:*`、qq-rooms 房间）映射到独立作用域。**主人私密记忆绝不进入群聊/访客房间的记忆块或压缩 checkpoint**。
- 不自带人设；记忆块与人设 section 分离。检测已装的其他记忆/压缩插件，在状态中提示重复注入或引擎冲突，并据此选择模式。
- 回忆工具遵守 qq-rooms 的 `tools.restrict`。

### 3.9 包结构

```
package.json          # name = row id = plugin name = "dsh-memory-cloud-brain"；engines.dsh ">=0.2.2-rc.5 <0.3.0-0"；
                      # dsh.bundle.patch + dsh.client(platform: web)；@deepseek-ai/* 同时放 peer+dev
cordis.patch.yml      # 插入主插件行 + 引擎行（顶层禁用 compaction-basic）；预设接管方式按阶段 0 结论
locale/{zh,en}.json   # meta.title / description / detail
tsdown.config.ts      # host ESM → lib/index.js；client 手工 __ModuleLoader__ 工厂格式 → lib/client.js
src/index.ts          # 入口：Config(schemastery)、apply、服务装配、模式选择
src/engine/           # MemoryCompactionEngine（覆写 summarize、失败回退）、空闲整理
src/store/            # 文件布局、原子写、锁、index
src/capture/          # session/event 捕获、片段封口
src/summarize/        # 任务队列、prompts、解析校验、rollup
src/pack/             # token 估算、预算、保留分、打包渲染
src/inject/           # 静态 section、会话开始注入、辅助模式压缩后重填
src/tools/ src/commands/ src/scope/
src/client/           # 设置页（档位、模式、模型、作用域规则、一键接管预设）
test/                 # 单元 + 基于伪造 ctx 的集成测试
```

## 4. 实施阶段

0. **兼容性探针（spike）**：在真实 DSH `0.2.2-rc.5` web profile 上用最小插件实测，结论写入 `docs/dsh-api-notes.md`，锁定接管方式与注入策略。
   - `BasicCompactionEngine` 的导出与 `summarize()` 的签名/返回类型。
   - bundle patch 能否按 id 覆盖 `preset-standard` 的 `compaction` 组；configEditor 写 profile patch 是否可行。
   - `compactNow` 的空闲调用行为。
   - `compaction/*` 事件载荷。
   - 各事件载荷（`turn/end.reason`、子 agent 判定）。
   - 注入消息的重发与缓存行为（看 `prompt_cache_hit_tokens`）。
   - `tokenMeter`/`resolveModelInfo`、自定义 purpose 与日志上传 exclusion、设置页槽位、QQ 会话的可识别字段。
1. **脚手架**：package.json、cordis.patch.yml、tsdown、locale、测试、CI；空插件在 web profile 成功加载。
2. **存储层**：布局、原子写、锁、index、崩溃恢复。
3. **捕获与片段封口**（含按 `shadowedSeqs` 封存）。
4. **总结器**：队列、prompts、解析/校验/重试、分块、rollup、隐私处理。
5. **计数与打包**：估算器、预算、档位、保留分、降级、渲染。
6. **压缩集成**：先做辅助模式（压缩后重填、会话开始注入），再做引擎模式（覆写 `summarize`、失败回退、预设接管、空闲整理）。
7. **回忆工具与命令**，含召回强化。
8. **作用域与共存**：作用域规则、群聊防火墙、冲突插件检测与模式选择。
9. **设置页**（client 半边）。
10. **发布**：npm 包、中英 README（web/desktop 分别安装、如何接管预设、如何还原）、GitHub topic `dsh-plugin` + `deepseek-harness`。

阶段 0–1 完成后，2/4/5/7/9 接口清晰，可并行开发。

## 5. 验证

- **单元测试**：
  - 存储原子性与锁、片段封口边界、总结解析兜底与长度校验、计数器。
  - 打包：每档位输出 ≤ M、降级顺序、从不截断单条、旧→新顺序稳定。
  - 保留分与召回强化、作用域隔离。
  - 引擎 `summarize()` 在模型报错/超时/输出超长时回退到 `super.summarize()`。
- **集成测试**：伪造 `ctx`（events/llm/systemPrompt/tools/compaction），覆盖两条路径：
  - 引擎模式："捕获 → 压缩 → 片段封存 → checkpoint 为记忆块 → memory_read 取回原文"。
  - 辅助模式："宿主压缩事件 → 后台总结 → 下一步重填记忆块"。
- **端到端（真实 DSH）**：
  1. `dsh plugin --profile web add <本地路径或 tgz>` 安装，确认 `/memory status` 显示的模式。
  2. 用档位 5（32K 工作记忆）长聊，确认自动压缩发生，会话日志中的 checkpoint 是记忆块，且对话能接上前文。
  3. 检查文件夹中的片段原文、总结、摘要。
  4. 新开会话，确认远期为总结、近期为摘要。
  5. 问一件旧事，确认模型调用 `memory_read` 并答对。
  6. 切换档位，确认阈值和体积变化。
  7. 空闲后确认 `compactNow` 整理生效。
  8. 装上 taskfold 等其他压缩插件，确认自动退回辅助模式。
  9. 让总结模型故意报错，确认回退到宿主摘要且 DSH 不崩溃。
  10. 对比同一记忆块下 `prompt_cache_hit_tokens`。
  11. 在 desktop profile 重复一遍。

## 6. 补充建议（超出原始需求，供取舍）

1. **"片段"而非"DSH 会话"作为记忆单位**：大肥鱼的 home 会话可能永不结束；按压缩区间和空闲间隔切分，才能做到"每段一总结"。（已纳入设计）
2. **空闲时整理**：压缩放在两轮之间，用户不用等。（已纳入设计）
3. **第四层"相处档案"**：一份置顶、可人工编辑的称呼/偏好/约定档案，比翻摘要更省 token。
4. **约定追踪**：摘要中单独抽出"约定/待办"，到期后下次会话提醒模型主动问起。
5. **类艾宾浩斯遗忘 + 召回回暖**，以及周→月→年时期总结，使远期层不随时间线性膨胀。（已纳入设计）
6. **写入时防丢信息**：可选为每个片段预生成 3–5 个"未来可能被问的问题"（EPC 方法），在紧预算下提升回忆准确率。
7. **压缩完整性校验**：借鉴 compaction-guard，压缩后检查用户明确说过"必须/记住"的内容是否进入了记忆块，缺失时补入置顶事实。
8. **隐私**：总结调用不随日志上传；可选脱敏；群聊防火墙。
9. **历史回填**：`/memory backfill` 导入装插件前的旧会话，包括已被宿主压缩过的原文。
10. **"云"的部分**：v1 先做本地文件（天然可 git/WebDAV 同步）；之后再考虑跨设备同步和时间线可视化面板。
11. **评测集**：做一个小型回忆问答集，用来调档位数值。

## 7. 假设（auto 模式下我自行决定的部分）

- DSH 指 DeepSeek Harness，"大肥鱼"指其陪伴 Agent 场景；插件不自带人设。
- "压缩时自动填入"与"作为自动压缩手段"两者都做：能接管引擎时走引擎模式，否则走辅助模式；默认 `compactionMode: auto`。
- 引擎模式不重写选区/锁/提交逻辑，只继承宿主引擎；宿主 API 变化时首先失效的是引擎模式，自动退回辅助模式。
- 目标 DSH `>=0.2.2-rc.5 <0.3.0-0`、Node ≥24；TypeScript + tsdown；零原生依赖；测试框架用 vitest（阶段 1 若发现生态惯例不同再调整）。
- 包名 `dsh-memory-cloud-brain`（`dsh-memory-cloud` 已被一个 3D 可视化插件占用），MIT 许可（不复用 AGPL / PolyForm 项目的代码）。
- 默认存储根 `$DSH_HOME/memory-cloud`，默认单一 owner 作用域，群聊/访客会话隔离。
- 原文默认全量保存（含工具调用），reasoning 可选排除；脱敏默认关闭，可开启。
- 默认档位 3（128K 工作记忆上限）；空闲封口 30 分钟；半衰期 14 天；这些都是初值。
- 批准后先把本设计存为仓库内 `docs/superpowers/specs/2026-11-23-memory-cloud-design.md`，再从阶段 0 开始实施。
