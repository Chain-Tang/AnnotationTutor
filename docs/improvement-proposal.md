# Annotation Tutor Lite 改进方案

> 主题：Qoderian-Excalidraw 集成机制解析、Zotero（用户原称 RoZero）核心功能对比、功能增强路线图
>
> 依据：Qoderian 源码（`.reference/Qoderian`，v1.0.4）、excalidraw-diagram SKILL.md（v1.2.1）、ACP 协议官方文档、OpenCode ACP 文档、TutorLite 自身源码（acp-session.ts / chat-view.ts 等）、Zotero 官方中文社区文档与 obsidian-zotero-integration 仓库。
>
> 状态：研究与规划文档，不含代码改动。

---

## 0. 背景与既有研究结论摘要

TutorLite（annotation-tutor-lite）是 Obsidian 桌面插件，学习闭环产品：批注 → Agent 评审 → 记忆单元（Memory Cell）→ 场景（Scene）→ 学习者画像 → SM-2 间隔重复复习。Markdown 为唯一真相源，无服务器无数据库。Agent 侧双引擎：Direct API（OpenAI 兼容 HTTP）与 OpenCode（ACP 协议，手写 JSON-RPC over stdio 驱动，见 `src/acp-session.ts`）。

此前研究已确认的关键结论（本文直接引用，不再重复论证）：

1. **TutorLite 对 ACP 通道的利用率约一半**，存在四个缺口（均在 `src/acp-session.ts`）：
   - 缺口一：`session/new` 时传 `mcpServers: []`，MCP 通道开着但没接；
   - 缺口二：`onUpdate` 只处理 `agent_message_chunk` / `agent_thought_chunk` / `tool_call`，丢弃 `available_commands_update`（slash 命令广播）；
   - 缺口三：`permissionOutcome()` 对写/执行类工具静默拒绝（`allowReads` 硬编码 true），agent 无法真正落盘文件、无法执行命令；
   - 缺口四：`thought` 事件已接收但 `chat-view.ts` 未渲染，工具调用仅显示一行状态文本。
2. **网页捕捉方向已确认**：捕捉选区进入学习批注闭环（创建 Selected Text 批注 + 用户理解，进入评审/记忆单元流程）。参考 Qoderian `browser-selection-controller.ts`：250ms 轮询检测内嵌浏览器视图，三级选区提取（document → iframe → webview.executeJavaScript），XML 打包上下文。
3. **Qoderian 架构**：分层（app / core / qoder / features / shared），`QoderServices` 组合根 + `QoderHostContext` 窄宿主契约；skills 协议为 `.qoder/skills/<name>/SKILL.md`（`skill-storage.ts` 解析 frontmatter 为 SlashCommand）；MCP 配置支持四格式粘贴解析（`mcp-config-parser.ts`）；bash 走本地 `exec` 直通（`bang-bash-service.ts`，30s 超时、1MB 缓冲、默认关闭）。

---

## 1. Qoderian 与 Excalidraw 集成的技术实现细节

### 1.1 核心结论：Qoderian 自身没有任何 Excalidraw 代码

对 Qoderian 全库（含 src/ 全部 214 个 TS 文件）执行 `grep -i excalidraw`，**命中 0 处**。即 Qoderian 插件与 Excalidraw 插件之间：

- 没有直接 API 调用（不 import、不调用 Excalidraw 插件的 `app.plugins.plugins["obsidian-excalidraw-plugin"]`）；
- 没有 IPC / 事件桥接；
- 甚至没有把 Excalidraw 列为依赖或可选依赖。

集成完全通过 **Skill 文件协议 + Agent 文件写入** 实现。这是一条"零耦合"路径，对 TutorLite 而言是重要启示：**两个 Obsidian 插件之间最稳健的集成方式，是共同遵守一个文件格式协议，中间由 agent 作为执行者。**

### 1.2 完整加载链：从 SKILL.md 到画图

```
用户 vault/.qoder/skills/excalidraw-diagram/SKILL.md
        │
        ▼  (1) skill-storage.ts 扫描 .qoder/skills/*/SKILL.md
解析 frontmatter（name / description / version）→ SlashCommand 对象
        │
        ▼  (2) 注册进聊天输入框的 slash 命令列表
用户输入 /excalidraw-diagram <内容>  或  触发词命中 description
        │
        ▼  (3) Qoder CLI 加载 skill 正文进 agent 上下文
agent 阅读 SKILL.md 中的格式规范，调用 Write 工具
        │
        ▼  (4) 生成 .md 文件（Obsidian Excalidraw 格式）
Obsidian Excalidraw 插件检测到 frontmatter，自动渲染画布
```

`skill-storage.ts`（62 行）的关键协议：

- 路径约定：`.qoder/skills/<skill-name>/SKILL.md`，一个 skill 一个目录；
- frontmatter 字段：`name`（命令名）、`description`（含触发词，供 agent 与命令面板路由）；
- 正文：自由 Markdown，全部作为 agent 的指令上下文注入；
- 附属资源：同目录下的 `references/`、`assets/` 等可被正文相对引用。

### 1.3 "控制 Excalidraw 插件"的真相：文件格式协议

社区 skill `excalidraw-diagram`（v1.2.1，15KB SKILL.md）定义了 agent 生成图的全部规则。Obsidian 模式的产物文件结构如下：

```markdown
---
excalidraw-plugin: parsed
tags: [excalidraw]
---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== ...

# Excalidraw Data

## Text Elements
%%
## Drawing
​```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://github.com/zsviczian/obsidian-excalidraw-plugin",
  "elements": [ ... ],
  "appState": { "gridSize": null, "viewBackgroundColor": "#ffffff" },
  "files": {}
}
​```
%%
```

关键要点：

- **识别开关**：frontmatter 的 `excalidraw-plugin: parsed` + `tags: [excalidraw]` 是 Excalidraw 插件认领文件的唯一依据；
- **数据区**：JSON 必须被 Obsidian 注释符 `%%` 包裹（渲染视图不可见），`## Text Elements` 段落必须留空，由插件自动回填；
- **元素字段硬约束**（违反会导致 excalidraw.com 或插件解析异常）：
  - 禁止 `frameId`、`index`、`versionNonce`、`rawText` 字段；
  - `boundElements` 必须为 `null`（不能是 `[]`）；
  - `updated` 必须为 `1`（不能是时间戳）；
  - 文本元素必须 `fontFamily: 5`（Excalifont 手写体）、`lineHeight: 1.25`；
- **三种输出模式**：Obsidian（`.md`，默认）/ 标准（`.excalidraw`，纯 JSON 供 excalidraw.com）/ 动画（每元素加 `customData.animate: { order, duration }`，供 excalidraw-animate）；触发词路由写在 description 中；
- **设计规范**（这是 skill 的精华，决定出图质量）：
  - 字号硬性下限：标题 20-28px、正文 16-18px、绝对禁止低于 14px；
  - 文字居中估算公式：`estimatedWidth = text.length * fontSize * 0.5`（CJK 乘 1.0），`x = centerX - estimatedWidth / 2`；
  - 画布建议范围 0-1200 x 0-800，元素间距 ≥ 20px，四周留白 50-80px；
  - 语义化配色表（8 种填充色 + 3 种区域背景色 + 4 种文字色，含对比度规则）；
  - 标点替换：`"` → `『』`、`()` → `「」`；禁用 Emoji；
  - 常见错误清单（文字偏移、元素重叠、标签溢出等）供 agent 自检。

### 1.4 对 TutorLite 的映射

| Qoderian 侧 | TutorLite 等价物 | 现状 |
|---|---|---|
| `.qoder/skills/<name>/SKILL.md` | OpenCode 自定义命令 `.opencode/command/*.md` | 未扫描、未展示 |
| frontmatter → SlashCommand | ACP `available_commands_update` 广播 | 缺口二：被丢弃 |
| agent Write 工具落盘 | ACP `session/request_permission` | 缺口三：写操作静默拒绝 |
| CLI 注入 skill 正文 | `session/prompt` 内容或 `/name args` 调用 | 无命令路由 UI |

**结论：要让 TutorLite 获得"Excalidraw 画图"能力，不需要写任何 Excalidraw 代码**。需要的是：(a) 接收并展示 slash 命令；(b) 打开写权限确认门；(c) 随插件分发一份 excalidraw-diagram 命令资产（可直接移植该 SKILL.md 内容）。此外应增加一个 **JSON 校验层**：LLM 生成的 Excalidraw JSON 未必合规，落盘前按 1.3 的硬约束做结构校验与自动修复（补 `boundElements: null`、剥离禁用字段），这部分是纯函数，可单测。

---

## 2. Zotero 核心功能对比分析

### 2.1 定位前提

Zotero 是文献库管理器（书目数据库 + PDF 存储 + 引文引擎）；TutorLite 是学习闭环工具。**目标不是复制 Zotero，而是覆盖"外部阅读材料 → 进入学习闭环"这一段**：捕捉 → 批注 → 评审 → 记忆单元。凡 Zotero 功能与学习闭环无关者（如文献库云同步），以产品哲学差异说明，不纳入覆盖范围。

### 2.2 八项核心功能逐项对比

| # | Zotero 功能 | Zotero 实现 | TutorLite 现状 | 覆盖策略 |
|---|---|---|---|---|
| 1 | 元数据捕获 | 浏览器 Connector 一键抓取网页/DOI/ISBN 的书目元数据与快照 | 无；网页捕捉已规划（选区进批注闭环） | 已确认方向落地：内嵌浏览器视图选区捕捉（参考 browser-selection-controller），URL/标题作为批注元数据写入 frontmatter |
| 2 | PDF 阅读标注 | 内置 PDF 阅读器：高亮、批注、区域框选、颜色分类，批注带页码回链 | Selected Text 批注仅限 Markdown 文本 | 不自建 PDF 阅读器；两条路：① 依赖 Obsidian 原生 PDF 视图 + 手动摘录；② 经 Zotero 互通导入（见 2.3）。PDF 是材料载体，不是闭环核心，优先级最低 |
| 3 | 笔记与批注回链 | 条目笔记、独立笔记，批注可跳转到 PDF 原位置 | Memory Cell + anchors.ts 锚点已实现回链 | 已覆盖且更强（锚点 + 记忆单元 + 复习调度），是 TutorLite 的差异化优势 |
| 4 | 集合分组 | Collections 层级树组织条目 | Notebook + Scene 组织 | 已覆盖；可补充"按来源聚合"视图（同一网页/PDF 的批注归组） |
| 5 | 标签 | 跨集合标签、彩色标签 | notebook-labels.ts 已有标签机制 | 已覆盖 |
| 6 | 引文输出 | CSL 数千样式、BibTeX 导出、Word/Docs 插件 | 无 | 可选 P2 轻量方案：从批注 frontmatter 提取元数据生成 BibTeX/CSL 片段（纯函数），不做样式全家桶 |
| 7 | 云同步 | Zotero 官方存储/同步服务 | 无 | 哲学差异：Markdown 文件即数据，用户自选 iCloud/Syncthing/Git 同步，文档说明即可 |
| 8 | 检索过滤 | 条目库全文搜索、条件过滤器 | library-index.ts / library-query.ts 已有索引与查询 | 已覆盖基础；可补"按来源/日期"过滤维度 |

**小结**：8 项中已覆盖或更强 3 项（3、5、8），哲学差异不覆盖 1 项（7），真正缺口集中在**材料入口**（1、2）与**引文输出**（6）。这与"把入口做厚"的定位完全吻合。

### 2.3 生态先例：obsidian-zotero-integration

mgmeyers 的 obsidian-zotero-integration（Obsidian 社区最成熟的 Zotero 桥）验证了一条低成本互通路线：

- 依赖 Zotero 侧 **Better BibTeX** 插件暴露的本地 HTTP API（默认 23119 端口）；
- 能力：插入引文/参考文献、导入条目笔记、**批量导入 PDF 标注**（高亮文本 + 颜色 + 页码 + 回链），支持模板化渲染；
- 提供 `runImport` API 可编程批量导入。

**对 TutorLite 的建议**：不自建 Zotero 连接器。若未来需要 Zotero 互通，做一个只读的"标注导入器"——经 Better BibTeX API 拉取指定条目的标注，逐条转成 TutorLite 的 Selected Text 批注（含页码锚点与来源元数据），直接进入评审/记忆单元流程。这比复刻 Zotero 任何单项功能都更贴合产品定位。

---

## 3. 功能增强路线图与实施建议

### 3.0 全局约束（每期适用）

- 纯逻辑模块不 import obsidian，测试禁 import obsidian（HANDOFF.md 约定），现有约 272 个测试保持通过；
- Direct API 引擎下新能力优雅降级（MCP/命令/bash 仅 OpenCode 引擎可用，设置项与 UI 需按引擎区分，引擎设置始终可见）；
- 每项 ACP 改动需在无 OpenCode 环境下不崩溃（握手失败回退 Direct API 的路径已存在）。

### 3.1 P0：流式体验补齐（预计 0.5-1 天）

**目标**：thought 与 tool 事件从"收到不渲染"升级为分块渲染，流式输出对齐 Qoderian 观感。

- `src/views/chat-view.ts`：
  - 渲染 `thought` 事件为可折叠的思考块（灰色斜体，默认折叠）；
  - 渲染 `tool` 事件为独立工具卡片（标题 + 状态），替代当前 `setStatus` 单行覆盖；
  - 借鉴 Qoderian stream-controller 的 **rAF 合帧**：同一帧内的多个 chunk 合并后一次性 DOM 更新，避免每 chunk 全量重渲染 Markdown；
- 渲染层抽出纯函数（`renderThoughtBlock` / `renderToolCard` 的 HTML 生成部分），补单测。

**验收**：OpenCode 引擎下能看到思考折叠块与工具卡片序列；高频 chunk 场景帧率不掉；Direct API 引擎行为不变。

**风险**：rAF 在 Obsidian 渲染上下文可用；增量渲染与全量 Markdown 重渲的切换点（代码块闭合时）需处理，建议先"chunk 期纯文本追加、结束时全量渲染"的保守方案。

### 3.2 P1：ACP 通道补齐（预计 2-3 天）

**目标**：补齐四个缺口中的三个（命令、MCP、权限），slash 命令、MCP、bash 三项能力全部可用。

1. **Slash 命令下拉**（缺口二）
   - `src/acp-session.ts`：`onUpdate` 增加 `available_commands_update` 分支，缓存命令列表并通过新回调上抛；
   - `src/views/chat-view.ts`：输入框 `/` 触发命令下拉（名称 + 描述），选中后以 `/name args` 文本形式发送（ACP 规范即把命令作为 prompt 文本）。
2. **MCP 配置**（缺口一）
   - `src/settings.ts`：新增 MCP 服务器列表设置（JSON 编辑 + 粘贴解析）；
   - 移植 Qoderian `mcp-config-parser.ts` 的四格式粘贴解析为纯函数（带单测）；
   - `src/acp-session.ts`：`session/new` 时将启用中的 stdio 服务器传入 `mcpServers`（`{name, command, args, env}`）。
3. **写/执行权限确认 UI**（缺口三，bash 的 ACP 路径）
   - `permissionOutcome` 改为按策略返回：读操作 allow、写/执行操作弹确认 UI（允许一次 / 始终允许 / 拒绝）；
   - 设置项：权限策略（只读 / 询问 / 自动允许）与"始终允许"清单持久化；
   - bash 支持由此自然获得（OpenCode 的 bash 工具走同一权限门），无需 Qoderian 式本地 exec 直通；本地直通作为后续可选增强。

**验收**：`/` 弹出 OpenCode 命令列表；配置一个 stdio MCP 服务器后 agent 能调用其工具；agent 写文件时弹确认，确认后文件真正落盘。

**风险**：`available_commands_update` 依赖 OpenCode 版本，需处理空列表降级；权限确认 UI 需防阻塞死锁（ACP 请求有超时，确认 UI 关闭时要回 reject）。

### 3.3 P2：内置 Skills 与 Excalidraw 画图（预计 1-2 天，依赖 P1）

**目标**：TutorLite 具备开箱即用的"让 agent 画 Excalidraw 图"能力。

1. **命令资产机制**：插件内置 `assets/commands/*.md`（首个为 excalidraw-diagram，内容移植自社区 SKILL.md v1.2.1，许可与署名见其 LICENSE），首次启用时写入 vault 的 `.opencode/command/`；同时扫描用户自定义命令并入下拉；
2. **Excalidraw JSON 校验层**（新纯函数模块，如 `src/excalidraw-guard.ts`）：
   - 校验 frontmatter（`excalidraw-plugin: parsed` + tags）与 `%%` 数据区结构；
   - 元素级修复：剥离 `frameId`/`index`/`versionNonce`/`rawText`，`boundElements: []` → `null`，`updated` 归一为 `1`，文本补 `fontFamily: 5`；
   - 补全单测（合法/越界/缺字段三类样例）。
3. **生成后自动打开**：检测到写入文件带 excalidraw frontmatter 时，提示并切换 Excalidraw 视图打开（前提：用户装有 Excalidraw 插件，未装时降级为普通文件打开 + 提示）。

**验收**：聊天中输入 `/excalidraw-diagram 把本章知识画成思维导图`，产出合规 `.md` 并自动以画布视图打开；构造畸形 JSON 时校验层能修复或拒绝并反馈。

**风险**：LLM 产物不稳定，校验层是必需的兜底；`.opencode/command/` 目录写入门槛（需 P1 权限门已就位）。

### 3.4 P3：学习材料入口（预计 3-5 天，含网页捕捉）

**目标**：覆盖 Zotero 对比表中的第 1、2、6 项缺口。

1. **网页捕捉进批注闭环**（已确认方向，参考 browser-selection-controller）：
   - 新模块轮询检测内嵌浏览器类视图（Surfing 等），三级选区提取（document → iframe → webview.executeJavaScript）；
   - 捕捉产物：Selected Text 批注，frontmatter 携带来源 URL/标题/捕捉时间，正文为用户理解输入；
   - 直接进入既有评审 → 记忆单元流程，无新数据模型。
2. **Zotero 标注导入器**（可选，依赖用户装 Zotero + Better BibTeX）：
   - 经 `http://127.0.0.1:23119/better-bibtex/` 本地 API 查询条目与标注；
   - 每条标注转为 Selected Text 批注（页码锚点 + 来源元数据），批量进入评审队列；
   - 纯数据转换部分抽纯函数单测，网络层薄封装。
3. **轻量引文输出**（可选）：从批注/来源 frontmatter 生成 BibTeX 条目片段的纯函数，供"复制到剪贴板"。

**验收**：在 Surfing 打开的网页上选区捕捉 → 生成带来源的批注 → 评审通过进入记忆单元；（若实现导入器）从 Zotero 导入一篇论文的标注并走完闭环。

**风险**：Obsidian 内嵌浏览器生态碎片化（viewType 命名各异），需按 Qoderian 的 `isBrowserLikeView` 宽松匹配 + 用户可配白名单；Zotero API 依赖用户本地环境，失败要静默降级。

### 3.5 路线图汇总

| 期 | 内容 | 依赖 | 预估 |
|---|---|---|---|
| P0 | 流式渲染 thought/tool + rAF 合帧 | 无 | 0.5-1 天 |
| P1 | slash 命令下拉 / MCP 配置 / 权限确认 UI（含 bash） | 无 | 2-3 天 |
| P2 | 内置命令资产 + excalidraw skill + JSON 校验层 | P1 | 1-2 天 |
| P3 | 网页捕捉进闭环 / Zotero 标注导入 / 引文输出 | P0-P2 之后均可 | 3-5 天 |

实施顺序建议 P0 → P1 → P2 → P3：P0 独立且见效快；P1 是 P2 的前置；P3 内部三项相互独立，可按需裁剪（网页捕捉优先，其余可选）。

---

## 4. 附录：引用来源

- Qoderian 源码（本地 `.reference/Qoderian`）：`skill-storage.ts`、`mcp-config-parser.ts`、`mcp-server-manager.ts`、`bang-bash-service.ts`、`browser-selection-controller.ts`、`stream-controller.ts`；全库 `grep -i excalidraw` 0 命中。
- axtonliu/axton-obsidian-visual-skills（MIT 许可）：`excalidraw-diagram/SKILL.md` v1.2.1 —— Excalidraw 文件格式协议与设计规范。
- ACP 官方文档（agentclientprotocol.com）：`session/new.mcpServers`、`available_commands_update`、terminal capability。
- OpenCode 官方文档（opencode.ai/docs/acp）：ACP 下全功能支持；自定义命令 `.opencode/command/*.md`。
- Zotero 中文社区用户指南；mgmeyers/obsidian-zotero-integration（Better BibTeX 本地 API 路线）。
- TutorLite 源码：`src/acp-session.ts`（四个缺口）、`src/views/chat-view.ts`（流式现状）、`src/library-index.ts`、`src/notebook-labels.ts`、`src/anchors.ts`；HANDOFF.md 维护约定。
