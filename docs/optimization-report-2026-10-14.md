# 优化报告 — Annotation Tutor Lite

> 日期：2026-10-14 · 基线：工作区 @ `3dd08bd` 之上（manifest 0.5.4，未提交）
> 方法：客观检查（typecheck/test 实跑）+ 两路深度审查（巨型文件代码质量、工程化与仓库卫生），关键论断逐条复算，全部给出 file:line 或实测数字证据。

> 后续核验与升级：[2026-10-14 核验记录](optimization-verification-2026-10-14.md)。下文保留原始审查；其中 HEAD 不可构建、wiki 版本、同名测试缺失和画板双写的推论已被后续实测修正，不能继续按原结论执行。

---

## 0. 健康基线（实测通过项）

| 项 | 结果 |
| --- | --- |
| `pnpm typecheck`（strict + noUncheckedIndexedAccess + noImplicitOverride） | ✅ 0 错误 |
| `pnpm test` | ✅ **207 文件 / 2952 用例全绿**，12.6s |
| tsconfig 严格度 | ✅ 良好（含 isolatedModules、noFallthroughCasesInSwitch） |
| 依赖健康 | ✅ 9 个 runtime 依赖全部有引用者，无死包 |
| web-bridge 安全面 | ✅ loopback + Host 白名单 + Origin 白名单三重校验（`src/web-bridge/server.ts:93-95`） |
| 监听器泄漏 | ✅ 基本无（`board-controller.ts:2082` 统一 `listen()` cleanup；main register 配对）；五个巨型文件中 `any` 逃逸 0 处 |

结论：**代码正确性纪律很好，主要风险不在逻辑，而在版本管理、性能与结构。**

---

## 1. P0 · Git 状态：HEAD 不可构建，工作区是"孤岛"

**这是全项目最高优先级问题，其他优化都应排在它后面。**

- 最后提交 `3dd08bd`（0.2.4，2026-09-11）；manifest/package.json 已是 **0.5.4**。约 33 天、3 个 minor 版本的全部工作只存在于这台机器（未提交：478 个 status 条目，展开后约 3700+ 未跟踪文件；`src/` 仅 **90/252** 个文件被跟踪，`scripts/` 仅 5/65，`tests/` 未跟踪 149）。
- **致命证据（已复算）**：已跟踪的 `scripts/build.mjs:1,8,9` import 了 `collect-licenses.mjs`、`release-transaction.mjs`、`release-state.mjs`——三者全部 `??` 未跟踪。**任何 clone（含 GitHub CI）在 HEAD 上 `pnpm build/typecheck/test` 必然失败**；CI 目前应为持续红色或从未在新代码上跑过。
- `extension/icons/` 半损坏：`generate-icons.mjs`、`icon.svg` 已被删除但仍被跟踪（状态 `D`，需 `git rm` 或恢复）；`icon-master.png` 等替代素材未跟踪。
- **隐私泄漏风险**：`storage-cleanup-report.json`、`storage-migration-report.json`（92K，含 `/Users/mac/Library/Caches` 等绝对路径）、`storage-restore.py`、`design-qa.md`、`.codex-audit/`、`.trae/` 均为未跟踪的本机产物，一旦 `git add -A` 会连同机器路径一起进公开仓库（本仓库是 GitHub 公开项目）。

**行动清单（按序）**：
1. 先补 `.gitignore`：上述 6 类本机产物 + `research/` 内的二进制/runs（只保留脚本与结论文档）。
2. 处理 `extension/icons/` 的 D 条目（`git rm`）。
3. 分批提交真实源码增量：`src/` → `tests/` → `scripts/`（优先三个被 import 的 .mjs）→ `docs/` → `assets/fonts`（发布必需，13M，建议单独一次提交）→ `extension/`、`android-companion/`、`host-plugins/`。
4. 推送并确认 CI 转绿之前，冻结一切"重构类"优化。

---

## 2. P1 · 性能：启动路径与热路径

### 2.1 启动阻塞（插件产品最伤体验的指标）

`main.ts:483-1140` 的 `onload` 约 **657 行**，且串行等待磁盘 I/O：`settingsFile.read()` → `credentials.initialize()` → `surfaceTransactions.initialize()`（:485-502）之后**同步构造 20+ 子系统**（VaultStore、TutorConversation、InspirationBoards、SkinLoader…）并注册 25 个命令。

- 建议：核心路径（locale、命令、view 注册）保留即开；credentials/MCP/clipper/learning/board 改为 `app.workspace.onLayoutReady` 或 idle 惰性初始化。Obsidian 启动时长直接计入用户第一感知。

### 2.2 热路径三处（已实读代码确认）

| 问题 | 证据 | 修法 |
| --- | --- | --- |
| Tutor 批量提交时全量序列化比较 | `board-controller.ts:1386-1387`：changed 循环对每个对象做 `JSON.stringify([anchor,bounds,strokeWidth])` 双向构造；且 :1385 在校验前无条件 `this.draw()` | 字段级比较 + `Set<id>`；把重绘移到校验通过后 |
| changed 循环内 N 次布局读取 | `board-controller.ts:1391` 逐对象调用 `drawingSpace()`，内部 `getBoundingClientRect`（:4285-4287，对 CM 行版本还会 querySelectorAll 全部行 :4317） | 循环外计算一次并复用 |
| JSON 深拷贝滥用 | `copy()`（`board-controller.ts:118`）全文件 **34 处**，含整文档克隆 `bundle()`（:1368）；`board-anchors.ts:6` 还有第二份同构 helper | 统一 `structuredClone`（`main.ts:540` 已示范），删重复 helper |

### 2.3 产物体积

- `main.js` **5.5MB**（desktop.js 5.1M、含 map 后 dist 更大）；`scripts/build.mjs:30` 只有 `sourcemap: true`，**发布构建未开 minify**（已核实无 minify 选项）。
- 发布包 25M 中 `assets/fonts/` 占 **13M（约 52%）**。
- 建议：发布目标开 `minify: true`（esbuild 单行改动）；字体做子集化或首用下载；`@a2a-js/sdk`/`@modelcontextprotocol/sdk` 是否可 external/懒载值得量化一轮。

### 2.4 工作区磁盘

`dist/` 实测 **1.1G**：`private-baselines` 580M + `milestones` 289M + 17 个历史 ZIP（每版 15M）。虽被 gitignore，但拖慢每次构建/备份且易被误打包。建议：历史 ZIP 只留最新 2 个 + 已发布版本迁到 GitHub Release 附件；baselines 移出 `dist/` 并入统一的 research 数据目录（同时纳入 ignore）。

---

## 3. P1 · 文档口径失真（对外事实源已全面滞后）

| 文档 | 写的 | 实际 |
| --- | --- | --- |
| `CHANGELOG.md` | 最新条目 0.2.4（2026-09-08） | manifest 0.5.4，**0.3.x–0.5.4 无变更记录** |
| `README.zh-CN.md:74` | "源码版本 0.2.4"、"87 个测试文件、876 项测试" | 207 文件 / **2952** 用例 |
| `HANDOFF.md` | "Current version 0.1.5、≈272 tests" | 严重过期 |
| `docs/wiki/*`（创作者 wiki） | 已声明"以 manifest/Releases 为准"，但内容基于 0.4.3 口径 | 需随 0.5.4 校准 |

对一个正在被创作者对外传播的产品，这是事实源事故：发布前至少补齐 CHANGELOG 的 0.3.0→0.5.4 段落，并修正 README/HANDOFF 数字。

---

## 4. P2 · 结构与可维护性

### 4.1 God Class（拆分候选，按风险收益排序）

| 文件 | 现状 | 拆分建议 |
| --- | --- | --- |
| `src/board-controller.ts`（5410 行） | `BoardLayer` 单类 **233 方法 / ~60 字段** | ① 指针手势 ② 属性面板 DOM ③ 参考图生成（:1590-1770）④ Surface 适配（:1377-1520）⑤ 剪贴板 |
| `src/main.ts`（5303 行，~150 方法） | 组合根 + 所有编排混在一起 | annotation-crud、learning-runner、agent-capture、startup（与 2.1 惰性化顺势做） |
| `src/views/board-view.ts`（2817 行，180 方法） | renderShell/AI 面板/保存管道同体 | shell-ui、ai-panel、save-pipeline |

注意：`board-controller` 有 170 用例的测试保护（实测 10.5s，最慢的测试文件），拆分时以现有测试为安全网；**先补 `board-view.ts` 的测试再动它**（当前无同名测试文件）。

### 4.2 i18n 三套机制并存

- `i18n.ts` 567 键 + `board-i18n.ts` 254 键 + `upgrade-i18n.ts` 138 键 ≈ **959 键 × 4 locale 全量进 bundle**。
- 同类两套类型策略：`i18n.ts:10` 用 `Record<string,string>`（无编译期 locale 完整性检查），`board-i18n.ts:294-295` 用 typed keys（有）。
- **真 bug**：`i18n.ts:2348` 占位符用 `String.replace`，同名占位符第二次出现不会被替换 → 改 `replaceAll`。
- **破坏多语言**：`settings.ts:1283/1297/1301-1308/1489`、`main.ts:493-494` 硬编码中文（已抽查确认），而同文件另一处却正确使用 `t()`。
- 建议：统一 typed dict；按 locale 懒载；把硬编码中文收进字典（这也是创作者 wiki 里"四种界面语言"卖点的品质底线）。

### 4.3 重复样板与低效重绘

- abort+modal 样板重复 5+ 次（`board-controller.ts:514-516、1459-1495`；`main.ts:1477、1851、1902`）→ 提取 `withAbortModal()`。
- 设置页任一开关触发整页 `this.display()` 重绘 **21 处**（settings.ts），54 个 Setting 全量重建、丢滚动/输入状态 → 局部更新。

---

## 5. P2 · 工程配置缺口

- **typecheck 覆盖不全**：tsconfig `include` 只含 `src/**`、`tests/**` → `extension/src`（14 个 ts）与 `scripts/` 从不检查。
- **CI 缺口**（`.github/workflows/ci.yml`，三平台矩阵已具备）：不跑 `pnpm package`（发布事务 release-transaction 从未被 CI 验证）、不构建 `extension/`、无 coverage 阈值、无 artifact 上传。
- **测试缺口**（大文件无同名测试）：`views/board-view.ts`(2817)、`board-i18n.ts`(1088)、`margin-card.ts`(646)、`translation-controller.ts`(447)、`web-bridge/server.ts`(209)、`surface-transaction-journal.ts`(238)。优先补 **board-view**（拆分前置）与 **web-bridge/server**（安全边界）。
- vitest 无 coverage reporter/阈值配置。

---

## 6. 行动优先级总表

| 优先级 | 事项 | 量级 |
| --- | --- | --- |
| P0 | 补 .gitignore → git rm 已删图标 → 分批提交/推送 → 恢复 CI 绿 | 半天，风险最高、必须最先 |
| P1 | 发布构建 minify；onload 惰性化；validateDraft/drawingSpace/copy() 热路径三板斧 | 各 0.5–2 天 |
| P1 | CHANGELOG 0.3–0.5.4 补齐 + README/HANDOFF/wiki 数字校准 | 半天 |
| P2 | i18n：replaceAll 修复 + 硬编码中文入字典（小）；typed dict 统一 + locale 懒载（中） | 1–3 天 |
| P2 | CI 加 package 校验与 coverage；tsconfig 扩 extension/；补 board-view 与 web-bridge 测试 | 1–2 天 |
| P1 | 点评失败回滚 `agent_requested` 状态（7.2，真 bug）；点评复用持久 ACP 会话 | 各 0.5–1 天 |
| P1 | 保存链去全库重建化：Notice 前置、目录/输出并行、增量重建、合并三次 rebuild（7.1） | 1–2 天 |
| P2 | 预翻译有界并发（7.3）；watcher 增量 + 代际守卫（7.4）；画板双写合并（7.5） | 各 0.5–1 天 |
| P3 | God Class 渐进拆分（先 board-controller，后 main，board-view 需先有测试） | 持续，搭车做 |
| P3 | dist/private-baselines/milestones 磁盘治理 | 半小时 |

---

## 7. 功能工作流阻断分析（第二批，逐条代码实证）

### 7.0 先记正例（不要动这些已验证的好设计）

- 便签面板**先 close 再 await onSubmit**，`submitted` 标志防重复提交（`src/views/note-panel.ts:100-112`）——AI 长任务不锁弹窗 UI。
- watcher：300ms 防抖 + 路径批处理 + 自写守卫（`src/watcher.ts:16-26`、`src/store.ts:74,189-201`）。
- 翻译快路径命中缓存（`src/translation-controller.ts:283-287`）；预翻译 hash 短路 + 按批渐进发布词表（:169-176、:219）。
- 画板渐进渲染成熟：rAF + 8ms 步预算 + 128 对象批 + worker 轮廓预备 + 代际取消（`src/views/board-view.ts:2059-2141`）。
- 全部磁盘写走 vault 异步 API；唯一同步 fs 是 Windows CLI shim 解析（`src/acp-runner.ts:287`），一次性开销可忽略。

### 7.1 每次保存 = 全库重建（最大感知延迟来源）

时间线：`finishCreate`（`src/main.ts:2827-2835`）= 写批注 → upsert → `commit()` → Notice → 可选 `await askAgent`。

- `commit`→`rebuildIndex`（:3724、:3700-3722）→ `store.rebuildLibrary`：**五个目录连续 await 串行扫描**（`src/store.ts:544-549`；目录内 `listMarkdownFiles` 已用 `Promise.all` :798，目录之间没有），再串行写索引缓存 + 最多 6 个输出文件（:552-556、:705-740）。
- 勾选"保存并请求点评"时，一次点击触发**两次全库重建**：`commit()`（:2833）+ `askAgent` 内 `commit()`（:2934）。
- 影响：成本随记忆库文件数线性增长（批注+cell+scene+profile+proposal 全部重读）；推算 1000 文件级可到秒级，Notice 与后续步骤全部排在链后。

建议（按风险递增）：① Notice 前置、rebuild 移出提交链（fire-and-forget + single-flight）；② 五目录 `Promise.all`、六个输出并行写；③ 增量重建（单文件变更只 upsert 内存快照与相关索引行，全量保留给手动命令）；④ 合并 :2833/:2934/:3008 三次重建为一次。

### 7.2 点评流程：成功尾部 5 步串行、失败状态悬挂、每次 spawn 子进程

- 成功路径 `main.ts:3002-3008`：`writeReview` → `setTaskStatus` → `createMemoryCell` → `syncScenesFromCells`（`store.ts:391-403` 又**重读全部 cells** + 逐个串行写 scene）→ `rebuildIndex` 全库。前三步互不依赖可并行，重建应只在末尾一次。
- **悬挂状态（真 bug）**：`askAgent` 执行前把批注置 `agent_requested`（:2926-2928），而 timeout/failed/needs-key/empty 分支（:2988-3000）只弹 Notice 直接 return，**不回滚状态**——唯一的解除路径是后续写入 review（`src/markdown/annotation-file.ts:334`）。失败后批注在总览/最近学习里长期显示"已请求"，误导用户（`markdown/overview.ts:168、248`）。
- **OpenCode 点评每次重新 spawn**：`runAcpReview` 一次性子进程 + 握手（`acp-runner.ts:295-320`）；而仓库已有持久 `AcpSession`（握手只跑一次，`acp-session.ts:198-200、300`）。点评路径复用持久会话可省下每次数百 ms 至秒级的启动成本。

### 7.3 整篇预翻译完全串行

`translation-controller.ts:194-221`：`for (batch of batches)` 逐批 `await captureText`，上限 30 批（`pretranslate.ts:33`）→ 长文档 = 30 次模型往返串行，分钟级。建议 2–3 批有界并发，保留现有 partial 发布与 needs-key 早退。

### 7.4 watcher 的二次放大

- `onMemoryChanged`（`main.ts:3730-3737`）：flush 后一律 `rebuildIndex(false)` **全库**——外部 agent 连续写入 = 每 300ms 一轮全量重读。建议按变更路径增量加载。
- 自写守卫是固定 1500ms 窗口（`store.ts:74`）：大库上单次 rebuild 时长可能超过窗口，令守卫失效并造成输出文件自触发。建议改为"写批次代际"判定而非固定时长。

### 7.5 画板保存双写与串行 flush

- `save()`（`board-controller.ts:3991-4025`）：先落盘一次（:3997），再 `await ensureBoardFonts`/SVG 测量（:4002-4022）后**第二次带 preview 落盘**（:4024）。sequence 守卫丢弃中间态已经做得好；手写文字未变时可跳过第二写（比较文字集合 hash）。
- 切换/销毁 `board-controller.ts:776-780`：`for...await` 串行 flush 每个 layer + repository，可并行。
- `validateDraft` 热路径三处（全量 JSON.stringify、循环内 drawingSpace、copy×34）见 §2.2，属同源问题。

---

## 附：证据与验证方式

- typecheck/test 为本机实跑（exit 0）；文件行数、体积、`git status` 计数均为命令实测。
- 两个子代理的结构性论断（HEAD 不可构建、无 minify、src 跟踪比、i18n replace、硬编码中文、validateDraft 热路径、copy 34 处）已由主代理逐条 `sed/grep` 复算确认。
- 未验证而仅引用的数字：未跟踪文件"约 3700+"来自代理 `-uall` 展开统计，量级可信、精确值以你的 `git status` 为准。
