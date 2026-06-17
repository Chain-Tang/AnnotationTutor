# Annotation Tutor Lite

[English](README.md) · **简体中文**

**把你读到的内容，变成 AI 导师真正用得上的学习记忆 —— 全部以纯 Markdown 形式，
全部在你自己的电脑上。**

Annotation Tutor Lite 是一个自包含的 Obsidian 插件。你高亮一段文字，写下你的理解，
AI 导师便会点评它、提炼出可长期保留的**记忆单元（memory cell）**，并按遗忘曲线在合适
的时间把它们重新带回你面前，帮你真正记住。**不需要服务器、数据库，也不内置任何模型
API 密钥** —— 每一份产物都是你 Vault 里的 Markdown 文件，因此任何智能体（Claude Code、
OpenCode、Codex）都能读取并扩展它。

> 这是完整版 Annotation Tutor 的「Lite」姊妹项目。它是一个独立项目（拥有自己的构建，
> 不属于 monorepo 工作区）。

## 为什么与众不同

- 🗂 **数据始终属于你。** 批注、点评、记忆单元、场景以及你的学习者画像，全部是 Vault
  里人类可读的 Markdown，绝不锁死在二进制文件中。
- 🧠 **一个真正的学习闭环，而不只是记笔记。** 点评会沉淀为**记忆单元**，记忆单元会
  自动归并为**场景（scene）**，并由**间隔重复（SM-2）**在你遗忘之前安排复习 —— 其依据
  正是艾宾浩斯遗忘曲线。
- 📓 **一本读起来像书的学习笔记本。** 一条命令就能把零散的批注汇成一本可导航的笔记本，
  用带日期的链接串起 笔记本 → 批注 → 原文。
- 🌐 **用任意语言阅读。** 行内逐词/逐句释义（`Alt+T`）与整篇文档预翻译（`Ctrl+Alt+T`），
  带来沉浸式阅读体验。
- 🔌 **自带引擎，按需选用。** 使用你已登录认证的 **OpenCode** CLI，或任意
  **兼容 OpenAI 的 API** —— 密钥只存在你 Vault 本地的插件数据里。
- 🌏 **界面完整本地化**：English、简体中文、繁體中文、日本語。

## 下载与安装

任选一种方式 —— 它们都会把同一个插件安装到
`<你的Vault>/.obsidian/plugins/annotation-tutor-lite/`。**方式 1–3 无需 Node 或任何
构建工具。**

### 1. 发行版 zip（最简单）

1. 从 [**Releases** 页面](https://github.com/Chain-Tang/PriveTutor/releases/latest)
   下载 `annotation-tutor-lite-<版本号>.zip`。
2. 将其解压到 Vault 的 `.obsidian/plugins/` 文件夹下 —— 它会自动为你创建
   `annotation-tutor-lite/` 文件夹。
3. 在 Obsidian 中打开 **设置 → 第三方插件**，如有需要先关闭「安全模式」，启用
   **Annotation Tutor Lite**，然后重新加载（`Ctrl/Cmd+R`）。

### 2. 散装文件（手动）

从同一个 [发行版](https://github.com/Chain-Tang/PriveTutor/releases/latest)
下载 `main.js`、`manifest.json`、`styles.css` 三个文件，并把它们一起放进你手动创建的
`<你的Vault>/.obsidian/plugins/annotation-tutor-lite/` 文件夹中。然后按上面的步骤启用
并重新加载。

### 3. BRAT（自动更新）

安装社区插件 **BRAT**，然后选择 *Add beta plugin*（添加测试版插件）→ 填入
`Chain-Tang/PriveTutor`。BRAT 会从最新发行版的资源安装，并保持插件自动更新。
（若 BRAT 无法解析，请改用方式 1 或 2。）

### 4. 从源码构建（开发者）

需要 **Node 22.13+** 与 **pnpm 10**。可用以下任意方式获取源码：

```bash
git clone https://github.com/Chain-Tang/PriveTutor.git      # 完整仓库
# 或：gh repo clone Chain-Tang/PriveTutor
# 或：在仓库绿色「Code」按钮处下载源码 ZIP（无需 git）
```

然后构建并安装到某个 Vault：

```bash
cd PriveTutor/TutorLite
pnpm install
pnpm install:vault -- --vault "/path/to/YourVault"   # 构建 + 拷贝 + 启用
# 或，生成发行版产物（dist/ 下的 zip + 散装文件）：
pnpm package
```

随后 [连接一个引擎](#连接一个引擎)，即可开始使用。

## 平台支持

桌面端 **Windows、macOS 与 Linux** 均受支持（需 Obsidian 1.12.4+）；本插件仅限桌面端
（不支持移动端）。纯逻辑部分有单元测试覆盖，涉及操作系统的代码路径（定位 agent CLI、
参数转义、路径处理）也都针对三大平台编写。

使用 **OpenCode 引擎** 时有一点需要了解：从 Dock、开始菜单或桌面快捷方式启动的
Obsidian 可能继承到一个精简的 `PATH`，从而漏掉 CLI 的安装目录。插件会额外搜索这些
常见位置作为补偿 —— Windows 上是 `%APPDATA%\npm`，macOS/Linux 上是 `/opt/homebrew/bin`、
`/usr/local/bin`、`~/.opencode/bin`、`~/.local/bin`、`~/.bun/bin`。如果你的 `opencode`
位于不常见的位置，可在引擎命令中填写它的完整路径，或改用 **Direct API** 引擎
（不启动子进程，处处可用）。

## 连接一个引擎

点评、导师对话与翻译都运行在某一个引擎上 —— 在 **设置 → General** 中选择：

- **OpenCode**（推荐；它可以直接读取你的 Vault）。请自行安装并登录
  [`opencode`](https://opencode.ai) CLI，然后把引擎设为 **OpenCode**。插件通过 ACP
  驱动你已认证的 CLI —— **不会存储任何 API 密钥**。默认模型为
  `opencode/mimo-v2.5-free`；如需更换，请修改 **Agent model**。
- **Direct API**（默认）：任意兼容 OpenAI 的端点。默认指向 DeepSeek
  （`https://api.deepseek.com/v1`，模型 `deepseek-chat`）—— 在 **API key** 处粘贴你的
  密钥。密钥只保存在你 Vault 本地的插件数据中，绝不会进入本仓库。

本插件不附带任何云服务或凭据。

## 工作原理

1. 在笔记中选中文字 → **添加学习批注**（`Ctrl/Cmd+Shift+L`）→ 写下你的理解。插件会
   插入一个 Obsidian 块 ID（`^ann-…`），并在 `Agent Memory/annotations/` 下为每条批注
   生成一个 Markdown 文件。
2. **请代理点评**。你的引擎会读取这些文件（由 `Agent Memory/AGENTS.md` 指引），把点评
   写入该批注的 **Agent Review** 区段，并可提炼出一个**记忆单元**。
3. 共享同一概念的记忆单元会自动组成一个**场景**；你的**学习者画像**会随时间记录关于你
   的长期事实。
4. **间隔重复**会让到期的记忆单元重新浮现；**生成笔记本**则把一切汇成一本可阅读的学习
   笔记本。

插件负责元数据、Selected Text 与 User Note；代理负责 Agent Review / Review History 区段，
插件每次编辑都会原样保留它们。`index.json`（位于插件文件夹下）是一个可重建的缓存 ——
**重建批注索引** 会从 Markdown 文件重新生成它。

## 核心概念

- **记忆单元（Memory cell）** —— 从一条或多条批注提炼出的、有据可依的原子记忆（一个
  概念、你对它的掌握程度、一个置信度，以及一份间隔重复日程）。它是导师记忆与复习的基本
  单位。
- **场景（Scene）** —— 把相关记忆单元归并在一起的上下文。当两个及以上记忆单元共享同一
  概念时，场景会**自动**形成；你（或代理）也可以手动创建自己的场景。
- **学习者画像（Learner profile）** —— 一份可审计的、纯 Markdown 的「你」的模型：关于
  你的优势、薄弱点与目标的若干论断，每条都附有证据。导师据此进行个性化。
- **笔记本（Notebook）** —— 自动生成的、人类可读的学习笔记本（按文档分页、按概念分章、
  以及一份优势/薄弱点小结），并带有指回每条批注与原文的带日期链接。

→ 完整解释、数据模型，以及每个部分如何被触发，详见
**[docs/guide.md](docs/guide.md)**。

## 键盘快捷键

默认值（Mod = Windows/Linux 上的 `Ctrl`，macOS 上的 `Cmd`）：

| 操作 | 快捷键 |
| --- | --- |
| 添加学习批注 | `Ctrl/Cmd + Shift + L` |
| 翻译选中内容（行内释义） | `Alt + T` |
| 预翻译整篇文档（全文） | `Ctrl/Cmd + Alt + T` |

其余所有命令（打开学习笔记本、生成笔记本、复习到期单元、打开导师对话……）**没有默认
快捷键** —— 可在 **设置 → 快捷键** 中搜索「Annotation Tutor Lite」自行分配。

## Vault 目录结构

```
Agent Memory/
├── annotations/ANN-YYYYMMDD-NNN.md   # 事实源，每条批注一个文件
├── memory-cells/MEM-*.md             # 有据可依的原子记忆（含间隔重复日程）
├── scenes/SCENE-*.md                 # 自动归并或手动创建的上下文
├── profiles/
│   ├── learner-profile.md            # 可审计的长期学习者模型
│   └── preferences.md                # 可选；默认禁止代理写入
├── indexes/{annotations,cells,scenes}.md
├── proposals/{pending,archive}/      # 确认模式下的审阅队列
├── Notebook/                         # 自动生成的学习笔记本
│   ├── Notebook.md                   #   入口 / 内容地图
│   ├── pages/<doc>.md                #   每篇学习过的文档一则文献笔记
│   ├── chapters/<topic>.md           #   按概念分章，归并相关页面
│   └── Learning summary.md           #   优势 / 薄弱点 / 方法
├── annotation-memory.md              # 自动生成的总览 / 代理入口
├── recent-learning.md                # 自动生成的简短小结
├── agent-inbox.md                    # 任务队列
└── AGENTS.md                         # 自动生成的代理说明
```

新文件采用 YAML Properties 加上可读的 Markdown 正文与 Obsidian Wikilink。记忆写入默认为
`direct`（直接写入）；可在设置中切换为 `confirmation`（确认模式），让提议的
单元/场景/画像变更先经过 **Proposals** 标签页。

## 开发

在获取源码（[上文方式 4](#4-从源码构建开发者)）并于 `TutorLite/` 内运行 `pnpm install`
之后：

- `pnpm typecheck` / `pnpm test` / `pnpm build` —— 质量门禁。
- `pnpm dev` —— esbuild 监听构建。
- `pnpm package` —— 构建并暂存 `dist/release/annotation-tutor-lite/` 与一个发行版 zip。
- `pnpm install:dev-plugin -- --vault ../Tutor` —— 把构建产物拷贝进开发用 Vault
  （默认为 `../Tutor`）；插件 id `annotation-tutor-lite` 让它能与完整版插件共存。
  `pnpm install:vault` 会一步完成构建与安装。

## 架构

纯逻辑、有单元测试（不引入 Obsidian）：`src/model.ts`、`src/ids.ts`、`src/anchors.ts`、
`src/srs.ts`、`src/memory-derive.ts`、`src/learning.ts`、`src/index-table.ts`、
`src/markdown/*`。与 Obsidian 绑定的一层：`src/store.ts`（文件读写 + 自写循环防护）、
`src/watcher.ts`、`src/decorations.ts`、`src/editor.ts`、`src/settings.ts`、
`src/views/*`、各 `*-controller.ts` 模块，以及 `src/main.ts`（接线）。测试位于 `tests/`。

学习模型详见 **[docs/guide.md](docs/guide.md)**；原始产品基线见
`PrivTutor Lite MVP Design Spec.md`。
