# 宿主 API（`ctx.memoryCloud`）

[English](host-api.md) · [中文使用手册](reference.md)

要找记忆云报数，可以先点它的名。主插件行提供 Cordis 服务 `memoryCloud`（`MEMORY_CLOUD_SERVICE`）。从 `ctx.get('memoryCloud')?.api` 取得接口，调用方无需声明 `inject`。这里的五个方法都返回解析为普通 JSON 的 Promise。写入设置后请查看 `ok`，Promise 已结束也可能表示写入失败。

```ts
const memory = ctx.get('memoryCloud')
if (memory) {
  const status = await memory.api.status(sessionId)
  ctx.logger.info('当前配置为 %d 档', status.configured.level)
  const saved = await memory.api.setLevel(3)
  if (!saved.ok) ctx.logger.warn('%s', saved.message)
}
```

| 方法 | 返回值 | 生效位置和时间 |
| --- | --- | --- |
| `api.status(sessionId?)` | `MemoryCloudStatus` | 返回宿主快照。传入活跃会话 ID 时，`agent` 可给出该会话的实际模式、作用域和预算。 |
| `api.setLevel(level)` | `SettingWriteResult` | 保存 `1`–`5` 档，立即生效。优先写入 `ctx.settings`，缺少该服务时由配置编辑器写插件行。两者都不可用或写入失败时，返回 `{ok: false, message}`。 |
| `api.setMode(mode)` | `SettingWriteResult` | 同样的写入路径。可选 `auto`、`engine`、`assist` 或 `off`。每个会话在下次需要模式时重新判断。 |
| `api.takeover(presetId?)` | `TakeoverActionResult` | 有 agent 预设时，配置编辑器改写指定预设的压缩组，默认预设为 `standard`，新会话生效。没有预设时，插件管理器启用宿主记忆引擎，并停用已安装的 `compaction-basic`。 |
| `api.restore(presetId?)` | `TakeoverActionResult` | 撤销相应的预设或宿主接管。宿主级操作按返回的 `outcome.application` 判断是否需要重启。 |

公开类型从包根导入。`MemoryCloudApi`、`MemoryCloudService`、`MemoryCloudStatus` 和 `TakeoverActionResult` 的定义在[状态接口](../src/runtime/status.ts)，`SettingWriteResult` 在[设置写入接口](../src/runtime/settings.ts)。同一服务上的 `budgetFor`、`composer`、`scopeFor`、`isEnabled` 和 `notifyFallback` 供记忆引擎内部使用。

## 看懂状态

`configured` 记下你选了什么，`agent` 记下一个会话实际领到了什么。新会话没开之前，这两件事可以各自等一等。

| 字段 | 内容 |
| --- | --- |
| `storageRoot`、`profile?` | 实际存储目录和已知的 DSH profile 名称。 |
| `configured`、`firewall?` | 配置的 `level`、`compactionMode` 和 `unmatchedSessions`。`firewall` 另列 `setting`、实际 `mode`、触发隔离的已知 `bridges` 和 `reason`。无效设置按 `isolated` 处理。 |
| `agent?` | `sessionId`、`subagent`、`scope`、实际 `mode`、`capacity`、`budget` 和 `pressure`。作用域决定包含 `scope`、`capture`、`private` 和 `reason`，上下文压力范围为 0–1。 |
| `scopes` | 各作用域内 `open`、`sealed`、`summarized`、`failed` 的片段数，以及固定、隐藏和时期总结的数量。 |
| `jobs`、`takeover` | 后台队列、运行中的任务、当日额度、连续失败暂停状态、累计结果及最近一次错误。`takeover` 另报预设或宿主引擎的接管状态。 |
| `coexistence`、`registrations` | 检测到的记忆、压缩、桥接插件，工具名冲突和中英文提示，以及回忆工具和 `/memory` 的注册结果。 |
| `fallbacks`、`routineFallbacks?` | 前者保留最近 20 次非常规回退，最新的在末尾，包括 `compose-error`、`compose-timeout`、`shrink-guard`、`empty`、`scope-error` 和 `budget-error`。`stage` 区分回退到宿主阈值或宿主摘要。后者按 `subagent`、`no-capture` 和 `region-too-small` 统计常规回退。 |

DSH 没给出模型窗口，或模型信息查询失败时，记忆云按 32 768 token 估算记忆块、回忆上限和状态，标记 `capacity.known: false`。此时引擎将压缩时机交给 `compaction-basic` 的配置。[预算实现](../src/runtime/budget.ts)

## 给桥接会话设置标签

同步调用 `ctx.get('memoryCloud')?.setSessionTags(sessionId, tags)`，把这个会话应有的**整组标签**交给服务。新集合替换旧集合，传 `[]` 就清空。标签会去掉首尾空白，舍弃空值和长度超过 1024 的条目，每个会话最多保留 64 个不同标签。进程中的活跃会话在插件重载后仍保有标签，`session/disposed` 清除它们。

例如，桥接可传 `qqbot:<bot>:group:<id>`。作用域规则还可匹配 `preset:`、`cwd:` 和 `session:`。`preset:` 取当前预设。子 agent 沿 `parentSession` 查到委派根会话决定作用域，遇到未知父会话就停止查找。

更换标签或预设后，记忆云会重新计算作用域。作用域和捕获设置相同就继续原片段。如果决定改变，会取消旧的待打包记忆，封存旧作用域里正在写的片段，下一条捕获事件使用新作用域。已经注入对话的主人记忆块会留到下一次压缩，缩小访问权限时会记下一条警告。

如果下个请求就需要隔离主人记忆，请在新作用域里新建会话。读取主人记忆要求 `scope === 'owner'` 且 `private === true`。作用域模板须明确写 `owner` 才能通过规则授予这项权限，用通配符展开成 `owner` 会得到 `owner-<hash>`。未匹配规则时由 `unmatchedSessions` 决定。默认 `auto` 只在检测到名单上的桥接时隔离会话，使用其他桥接时应显式选 `isolated`。[作用域与已知桥接名单](reference.md#作用域与隐私防火墙)

## 从 Web 读取和保存设置

浏览器通过 Typert Remote 的 `memoryCloud` 命名空间调用 `status`、`setLevel`、`setMode`、`takeover` 和 `restore`。Remote 的 `status()` 省略 ID 时会选最近活跃的非子 agent 会话。宿主的 `api.status()` 要取得指定会话明细，应传它的 ID。Remote 在传输时把非有限数值转成 `null`。主人端默认可用，其他端需要 DSH 的远程访问策略允许该动作。

| Remote 专有接口 | 返回值与写入方式 |
| --- | --- |
| `memoryCloud/getConfig()` | 返回 `ConfigView`，其中 `config` 是当前值，`defaults` 是 schema 默认值。可热更新的字段有 `level`、`compactionMode`、`timeAwareness`、`idleMinutes`、`idleCompactRatio`、`halfLifeDays`、`maxEpisodeTokens`、`captureReasoning`、`summarizer.{provider,model,reasoningEffort}`、`overrides`、`scopeRules` 和 `unmatchedSessions`。 |
| `memoryCloud/setConfig(patch)` | 返回 `SettingWriteResult`。只传要改的字段，`summarizer` 可只传改动的子项。传入 `overrides` 或 `scopeRules` 会替换整个字段。从替换值中去掉某个覆盖项，该项就回到档位值。 |

写入前会验证整份补丁。字段须支持热更新，合并后的值须符合 schema。作用域规则中的匹配式和作用域均需非空，模板里的 `$n` 要有对应通配符。验证失败返回 `{ok: false, message}`。`storageRoot` 属于启动项。支持 `settings.mutate()` 时，对象值按路径替换，以便真正去掉不再需要的覆盖项。其余情况走 `settings.update()`，或由配置编辑器在当前完整行配置上修改指定路径。保存后的作用域由注入和回忆在每步检查，捕获在下一轮开始时检查。[Remote 实现](../src/runtime/remote.ts) · [参数和编解码](../src/client/contract.ts)

## 读接管结果

- **预设操作成功**会返回 `{kind: 'preset', ok: true, action, preset?, warning?}`。`action` 是 `applied`、`unchanged` 或 `restored`。若接管是整行唯一的改动，还原会移除 profile 覆盖。若另有手动修改，还原会撤销接管并保留其余修改。
- **预设操作失败**会返回 `{kind: 'preset', ok: false, code, message}`。原因代码包括 `no-config-editor`、`preset-not-found`、`no-compaction-group`、`overridden` 和 `edit-failed`。
- **宿主级操作**会返回 `{kind: 'host', ok, outcome}`。`outcome.application` 为 `restart-required` 时，配置已经保存，重启 DSH 后生效。

接管记录按 DSH profile 名称保存在 `<storage root>/takeover.json`。插件启动约 10 秒后在后台运行一次 `refreshAfterUpgrade()`，按记录检查预设是否应随升级重新应用接管。
