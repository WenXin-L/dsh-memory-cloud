# 在真实 DSH 宿主里做端到端检查

[English](README.md) · [中文使用手册](../../docs/reference.md#开发)

DSH 领到一个新家，模型已经背好了台词。[测试驱动](run-e2e.mjs) 在临时目录安装 DeepSeek Harness，通过 `dsh plugin --profile <p> add <repo>` 把当前插件装进 `headless` 和 `web` 两个 profile，再用脚本化假模型走完七个场景。模型在本地回答，运行不需模型账号或 API key。

从装好项目依赖的仓库根目录执行。需要 Node.js 24.9 或更高版本，`pnpm` 需在 `PATH` 中，DSH 安装插件时也会调用它。

```sh
node scripts/e2e/run-e2e.mjs
```

默认会构建插件，并安装 `@deepseek-ai/dsh@0.2.2-rc.5`。首次安装需要访问 npm registry。可用 `DSH_VERSION` 指定另一宿主版本。驱动为测试进程指定临时 `HOME` 和 `DSH_HOME`，关闭遥测。仓库脚本按 POSIX 命令和信号启动、关闭宿主。

如果已有可用的 DSH 安装目录，可以只构建一次再复用它。`--dsh-dir` 取安装根目录，该目录下应同时有 `node_modules/.bin/dsh` 和顶层的 `node_modules/@deepseek-ai/dsh-llm`。下例只跑最前面的两个场景。

```sh
pnpm build
node scripts/e2e/run-e2e.mjs --only s1,s2 --skip-build --dsh-dir /path/to/dsh-install
```

## 七个场景在等什么

场景按编号运行，共用同一个临时 DSH 环境。单独选场景时，S2、S3 和 S5 要带上 S1；S4 要带上 S1 和 S3，以便第 5 档已生效。S7 要带上 S6，它要关闭的是 S6 启动的 Web 宿主。全部检查通过时，驱动以 `0` 退出。

| 场景 | 可以观察到的结果 |
| --- | --- |
| S1 · 接管宿主压缩 | headless 调用 `api.takeover()` 后由插件管理器返回 `restart-required`。新进程在 32K 窗口内完成 16 步对话，触发至少两次记忆引擎压缩。检查点含 `<memory-cloud>`，并将同一份总结用于已封存片段，省去重复的后台模型调用。 |
| S2 · 归档、回忆与隔离 | 先继续旧会话，再开新会话。每个请求只带一个记忆块，内含近期摘要和远期总结。`memory_search` 可找片段，`memory_read` 可读摘要或 `raw` 原文。另一个隔离会话搜索不到主人片段，注入的记忆也来自它自己的作用域。 |
| S3 · 调档位 | 通过 `api.setLevel(5)` 热更新档位。在测试用的 128K 窗口，阈值从 104 857 降至 32 768 token，记忆块缩小。同一套 14 步对话只在第 5 档触发记忆引擎压缩。 |
| S4 · 总结失败 | 让模型抛错或返回格式错误的内容。当前对话仍可用宿主摘要完成压缩，片段记为 `failed`。经过 30 秒退避后，再观察恢复正常的模型重新处理片段。 |
| S5 · 交还给 DSH | `api.restore()` 交还宿主级压缩。辅助模式在 DSH 压缩后的下一步补入记忆块，封存片段的总结由后台完成。 |
| S6 · 接管 Web 预设 | `dsh web --no-open --port 0` 启动 Web，在页面索引中查到插件客户端。在这组新装配置里，预设会话先用辅助模式。接管后新会话使用记忆引擎并产生检查点，还原会移除本例中只含接管改动的覆盖。 |
| S7 · 关闭 Web | 向 S6 的进程发送 SIGINT，检查退出时间、已封存片段与总结队列，并核对残留锁、未处理的 Promise 拒绝、锁超时和关停中耗尽重试的问题。 |

## 假模型、探针及日志

驱动把两个测试插件写入 DSH 安装目录下的 `.mcb-e2e-plugins-<pid>`，用 `--patch` 加载。传了 `--dsh-dir` 时，这个测试子目录也在你指定的安装目录里。

- **`e2e-fake-llm`** 注册 `fake/fake-1`。`[[long:N]]` 生成填充文字，`[[steps:K:N]]` 在一轮里产生多次工具调用，供压缩阈值测试使用。`[[search:q]]`、`[[read:<id>]]` 和 `[[raw:<id>]]` 分别触发查找、读摘要和读原文。片段总结从 `【事实：…】` 取样，在转录模式返回 `memory_save`，在重放模式返回 JSON 代码块。时期总结返回文本。`summarize: throw` 和 `summarize: garbage` 用来验证失败和回退。
- **`e2e-probe`** 把宿主日志记入 `logs/dsh.log`，记录退出码与未处理的拒绝。它在 headless 回合结束时调用宿主 API、查询检查点或执行 `/memory` 命令，在 Web 宿主上用 `sessionController.create/prompt` 创建会话并发送提示。

驱动退出时停止自己启动的 Web 服务，默认删除临时测试目录和测试插件。要在完成后读取 `logs/` 或 `dsh-home/`，请在运行前指定 `--keep`，临时目录和测试插件都会保留。

```sh
node scripts/e2e/run-e2e.mjs --keep
```
