# 安装、迁移与回滚

> 历史记录（0.3.0）。当前0.4.2学习升级及事务安装请以 [本轮使用与回退说明](tutor-learning-upgrade.md) 和 [验收报告](qa/learning-upgrade-20260926/report.md) 为准；下文保留当时的验收范围。
本次是 **0.3.0 桌面预览**。请结合 [逐阶段验证](tutor-upgrade-status.md) 使用，不将 Android / 复杂人物实验视为正式支持。

## Obsidian

安装 `dist/annotation-tutor-lite-0.3.0.zip`，解压其中 `annotation-tutor-lite/` 到 `<Vault>/.obsidian/plugins/`。完整保留 `main.js`、`manifest.json`、`styles.css`、离线字体/许可证及包中资源。不要只复制 JS。`desktop.js` / `mobile.js` 是独立验证产物，实际入口使用惰性单文件，避免 Obsidian 不支持相对 require 的问题。

本机开发安装：`pnpm build && node scripts/install-dev-plugin.mjs --vault /absolute/vault`。确认聊天与外部任务空闲，再在 Obsidian 关闭/开启 Tutor。API 密钥、连接设置与 Vault 中画作不在发布包内，也不会被安装脚本覆盖。

- 流程/关系图：命令面板“创建 Excalidraw 画布”，或聊天明确指定 Excalidraw。已实测插件 2.27.3；缺失时报告能力不足，不重写压缩文件。
- Studio 聊天：先打开目标 Studio，再到侧栏描述要画的内容；会保留目标画布。生图会打开候选面板，选中后点击“加入作品”；数学图与基础形状走可编辑图形流程。运行中改变目标 Artboard 或图层时会拒绝落图。
- 精准角色：打开 Studio，右侧“对象与部件”插入圆团/书页角色，选择对象或部件，改色/锁定/路径数值；自然语言修改先显示局部差异，确认后应用。保存角色版本后可再次插入。
- 手写：文档画板选择墨迹，主动识别，校正后保存或发给 Tutor。转写位于配置的 `memoryRoot/ink/transcripts/`，原墨仍可编辑。
- 多 Agent：命令面板“Tutor + Codex 协作”，选择最多两个专家；Tutor 汇总建议，专家不会直接改学生作品。Codex 命令使用已登录的本机 CLI，可在设置指定绝对路径。
- 服务：开启 Tutor 的本机 MCP。默认只读，画图修改需启用写入并在配对时授权目标/选择；可逐客户端撤销。

## Codex / 通用 MCP

构建：`node scripts/build-tutor-plugin.mjs`。包根为 `host-plugins/tutor/`，包含 portable `plugin.json` / `mcp.json`（必需 `$schema`）、兼容清单、三个 Skills 和 stdio connector。

安装本机 personal marketplace 后，**新建一个 Codex 对话**载入新工具。调用 `tutor_instances` → `tutor_connect`，在 Obsidian 中选择文档、画布、对象和学习记忆权限。连接诊断使用 `tutor_diagnose`。只需配对一次，扩大范围时重新配对；不要把整个 Vault 或学习档案默认授予外部 Agent。

通用 MCP 配置：运行 `node /absolute/path/to/tutor/scripts/connector.cjs`（Node 22+）。插件包不带端口或令牌。连接器从用户私有发现目录找到正在运行的库；关闭 Obsidian 后明确不可用。

长任务返回句柄，查询/取消都必须沿用原客户端。绘图草稿不代表已保存，只有 `tutor_commit_change` 成功回执才代表提交。提交回执包含新修订，随后分页 `tutor_read_scene`；使用该修订读取下一页。矢量节点通过 `tutor_read_vector_asset` 获取。

## A2A

本机服务在同一端口提供 `/.well-known/agent-card.json` 与 `/a2a`，使用 A2A 1.0 JSON-RPC。Agent Card 可发现能力，任务操作要求配对 Bearer。MCP/A2A 使用同一客户端身份与同一任务 ID。

远端仅配置用户自有 HTTPS A2A 服务。请求限于该来源，不跟随重定向，不自动下载产物 URL，不开放本机公网端口。不确定是否完成时只查询已知远端 ID；初次请求若未获得 ID，报告不确定，不自动再次计费执行。

`memoryRoot/tasks/` 保存有界任务元数据与远程句柄，不保存模型推理、完整正文或密钥。它不是完整运行中会话的持久恢复。进程重启后的状态恢复目前仍有明确发布门。

## Android 开发预览

[配套应用源码](../android-companion/README.md)。需要 JDK17、SDK35、Gradle8.11.1 构建。当前未生成/签发 APK；正式 manifest 保持桌面限制。完成指定设备测试前不要通过修改 manifest 对外宣称 Android 可用。

语言模型必须用户主动下载。正常路径为配对的本机识别服务；回退路径为用户目录中的请求/结果文件和显式应用跳转。识别结果验证原墨指纹、ID、语言和内容版本；无服务时仍支持本地书写与人工转写。

## 回滚

1. 等所有聊天、外部任务和本地保存空闲，关闭 Tutor。
2. 备份当前插件目录及配置的 `memoryRoot`。不要分享 `data.json` 或 `~/.local/share/tutor/clients/`。
3. 恢复已有备份/上一个安装 ZIP 的程序和资源，**保留原 data.json**。如果回退到不理解新可选图层/角色字段的版本，先复制作品在测试库检查，不覆盖唯一原件。
4. 本轮没有批量迁移历史 v5 几何。角色按不可变版本引用，撤销与旧画板不会被后续改色覆盖。任务/权限/转写是独立文件。
5. Codex 可禁用/卸载 Tutor 插件，并在 Obsidian 撤销该客户端。取消配对不删除画作。

M0 快照与本轮最终预览包分别保留；没有生成过的逐阶段包不冒充历史验收产物。
