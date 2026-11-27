# 记忆云 · dsh-memory-cloud-brain

[English](README.en.md) · [工作原理](docs/reference.md#分层与数据流) · [使用手册](docs/reference.md) · [更新日志](CHANGELOG.md)

**正在为新会话准备上一次。能放得下的那部分。** 记忆云把 DeepSeek Harness（DSH）的对话分段存在本机。新会话从同一作用域接过近期的摘要，再早一些的事只带简短的总结。需要核对当时的说法，模型可以回去读原文。你也可以让记忆云接管上下文压缩，这一步可以留到以后。

> `0.1.0` 源码预览已经到这里了。它还没有发布到 npm。端到端记录来自 DSH `0.2.2-rc.5`、本地链接安装和一个假模型。Desktop、真实模型的缓存以及其他安装方式仍待验证。

## 安装

先给试用找一个自己的家。用独立的测试 profile，或把 `DSH_HOME` 指到临时目录，拿测试会话试跑。准备好 [DSH](https://github.com/deepseek-ai/deepseek-harness) `0.2.2-rc.5`、Node.js `24.9` 或更新版本，并把 `pnpm` 放在 PATH 中。

```sh
git clone https://github.com/WenXin-L/dsh-memory-cloud.git
cd dsh-memory-cloud
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
dsh plugin --profile web add "$PWD"
```

插件还没出现在列表里时，重启 DSH，让列表赶上来。在**新会话**里运行 `/memory status`，确认插件已加载，并查看当前模式和作用域。第一次可以让 `auto` 留在原位。按上面步骤新装到 Web 时，生效的是**辅助模式**。记忆云补入记忆，压缩仍由 DSH 负责。

## 日常使用

| 想让记忆做什么 | 从这里开始 |
| --- | --- |
| 报告它在做什么 | 运行 `/memory status`，查看模式、记忆预算、作用域和后台任务。 |
| 把记忆再压短一点 | 用 `/memory level 1` 到 `/memory level 5` 选档。默认在 `3` 档。 |
| 把压缩交给记忆云 | 在设置页选「接管压缩」，或运行 `/memory takeover`。交还给原引擎时用 `/memory restore`。[接管与重启说明](docs/reference.md#启用引擎模式接管压缩) |
| 让新会话也知道该用什么单位 | 在私有主人会话里说「记住，以后温度都用摄氏度」。日后想改，或想移除这条偏好，都可以告诉模型。 |
| 让上线日期跟上它自己的更改 | 先说「记住，海棠项目 12 月 12 日上线」，再说「海棠上线改到 19 日，请更新记录」。在同一作用域开个新会话问海棠，插件会按主题取回更新后的日期。 |
| 看看当时究竟怎么说的 | 模型可用 `memory_search` 查片段，再用 `memory_read` 读原文。归档从启用插件时开始，更早的会话没有补录。 |

## 装进日常环境前

- **隐藏以后，磁盘还记得。** 原文默认保存在 `$DSH_HOME/memory-cloud`，可能含有工具结果和模型推理内容。隐藏片段后文件仍在，请把存储目录和原文日志留在公开仓库之外。
- **总结请求另有收件人。** 原文存在本机，生成总结的请求仍会发给你配置的模型服务。注入会话的记忆随其他消息一起按 DSH 日志设置处理。
- **`auto` 只认得名单上的桥接插件。** 接入群聊或外部桥接时，显式设置隔离。多人环境建议用 `unmatchedSessions: isolated`，接入前核对[作用域规则](docs/reference.md#作用域与隐私防火墙)。

## 深入阅读

- 把插件用起来 · [安装方式](docs/reference.md#安装) · [配置与设置](docs/reference.md#设置) · [命令与工具](docs/reference.md#工具与命令) · [数据与隐私](docs/reference.md#隐私)
- 在宿主里开发和检查 · [本地检查](docs/reference.md#开发) · [宿主 API](docs/host-api.zh.md) · [端到端测试](scripts/e2e/README.zh.md)

采用 [GPL-3.0-only](LICENSE) 许可证。
