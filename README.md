# 记忆云 · dsh-memory-cloud-brain

[English](README.en.md) · [使用手册](docs/reference.md) · [更新日志](CHANGELOG.md)

**让 DeepSeek Harness（DSH）在新会话里也能接上以前聊过的事。** 记忆云把旧对话分段存到本机，近期保留较详细的摘要，远期只带要点；需要核对细节时，再按需找回原文。它也可以接管 DSH 的上下文压缩，但首次安装不需要开启。

> 目前是 `0.1.0` 源码预览，尚未发布到 npm。已有端到端记录基于 DSH `0.2.2-rc.5`、本地链接安装和假模型；Desktop、真实模型缓存和其他安装方式尚未验证。

## 安装

准备好 [DSH](https://github.com/deepseek-ai/deepseek-harness) `0.2.2-rc.5`、Node.js `24.9` 或更新版本，以及 PATH 中的 `pnpm`。先用独立的测试 profile 或临时 `DSH_HOME` 试跑，避免把已有会话当作测试数据。

```sh
git clone https://github.com/WenXin-L/dsh-memory-cloud.git
cd dsh-memory-cloud
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
dsh plugin --profile web add "$PWD"
```

如果插件列表尚未刷新，重启 DSH。然后在**新会话**里运行 `/memory status`，确认插件已加载，并查看当前模式和作用域。第一次建议保留默认的**辅助模式**；它会补充记忆，但不替换 DSH 原来的压缩引擎。

## 日常使用

| 想做什么 | 怎么做 |
| --- | --- |
| 确认插件是否生效 | `/memory status`：查看模式、记忆预算、作用域和后台任务。 |
| 调整记忆压缩程度 | `/memory level 1` 到 `/memory level 5`，默认 `3`。 |
| 用记忆云压缩上下文 | 在设置页选择「接管压缩」，或运行 `/memory takeover`；用 `/memory restore` 还原。[接管与重启说明](docs/reference.md#启用引擎模式接管压缩)。 |
| 让偏好跨会话生效 | 在私有主人会话里说「记住，以后温度都用摄氏度」。以后也可以让模型改正或移除这条偏好。 |
| 找回旧对话里的细节 | 模型可以调用 `memory_search` 和 `memory_read`。插件只归档启用后的会话，不会补录以前的会话。 |

## 装进日常环境前

- **原文会保留在磁盘上。** 默认存到 `$DSH_HOME/memory-cloud`，可能包含工具结果和模型推理内容。隐藏片段不等于删除；不要把存储目录或原文日志放进公开仓库。
- **本地存储不等于离线处理。** 总结请求仍会发给你配置的模型服务；注入会话的记忆按 DSH 的日志设置处理。
- **群聊或外部桥接请显式隔离。** `auto` 只识别部分桥接插件。多人环境建议设 `unmatchedSessions: isolated`，并在接入前核对 [作用域规则](docs/reference.md#作用域与隐私防火墙)。

## 深入阅读

- 使用： [安装方式](docs/reference.md#安装) · [配置与设置](docs/reference.md#设置) · [命令与工具](docs/reference.md#工具与命令) · [数据与隐私](docs/reference.md#隐私)
- 开发： [本地检查](docs/reference.md#开发) · [宿主 API](docs/host-api.md) · [端到端测试](scripts/e2e/README.md)

许可证：[GPL-3.0-only](LICENSE)。
