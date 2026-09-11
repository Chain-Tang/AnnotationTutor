# 表格与 PDF 批注：实现笔记与遗留问题

> 状态：截至内部构建 `0.2.0-t23`（`src/main.ts` 的 `ATL_BUILD_STAMP`）
> 日期：2026-09-03
> 行号基于 t23 的工作区快照；工作区尚有大量未提交改动，行号会漂移，定位请以「文件 + 函数名」为准。

> **2026-09-08 / 0.2.1 更新：** 下文保留为 t23 历史快照，不能当成当前
> 工作区已经实现的功能清单。五份 docs 已对照阅读；本轮仅处理桌面表格/PDF
> 交互，不扩展为 Pad 手写、场景提案或其它路线图实施。
>
> 本轮根因与修复：
> - PDF rail 每次布局刷新销毁卡片，拖动事件随后操作已脱离 DOM 的旧节点。
>   新 `CardPool` 保留卡片身份及输入草稿；`card-drag.ts` 使用 Pointer Events，
>   处理多指针、取消和父级缩放，布局期间不重置正在拖动的卡片位置。
> - quiet 皮肤隐藏拖动柄，六个按钮挤占顶部空白。现提供独立的整行拖动柄。
> - 表格仍在源文件写 standalone id，CM widget 又遮蔽源码 decorations。
>   现停止新表格写 id，补充无 id 文本回退与独立 `TableHighlighter` 几何层。
> - 在 Obsidian 1.13.7 的实际单元格中确认：编辑状态同时有一个
>   `display:none` 预览副本与可见 CM 编辑器。旧匹配命中隐藏副本，Range 尺寸为零。
>   过滤隐藏节点后，同一条中文批注得到 6 段非零高亮，不必先退出单元格。
> - 表格点击在 pointerup 分辨拖动，保留原生选字；消费随后的 click，避免双重切换。
>   页面重绘只观察 CM 内容，不改写 widget 子树；异步重试有上限，不保留过期坐标。
> - 三条 rail 共用保留式卡片；PDF 相同 marks 不再无谓重建文字层。
>   PDF 选字拖动不再触发便签点击；PDF 聊天读取增加二进制守卫。
>
> 验证边界：新增 happy-dom DOM 回归（真实卡片/rail，模拟几何与 Obsidian 图标接口）。
> 实际 Obsidian 中已通过合成 Pointer Events 验证表格高亮点击、便签打开和
> 拖动中刷新后仍为同一 DOM 节点（位移 80×40）；测试位移已还原。
> 自动化会话的 `document.visibilityState` 为 `hidden`，PDF.js 页面绘制停留加载态，
> 因而本轮 PDF 的前台物理鼠标拖动仍需用户确认，不能把 DOM 回归称为真机端到端。
>
> 保留限制：表格匹配限单元格内引用，跨格不拼接误匹配；重复文本仍按匹配顺序
> 分配，尚无完整的行/列语义身份。迁移只删除索引明确标记为 generated 的 id，
> 不扫描删除无法确认归属的孤儿 token。PDF 仍依赖 PDF.js DOM，不抽取整份正文。

---

## 0. 一条共同主线

插件的默认锚定策略是：把 `^ann-YYYYMMDD-NNN` 这样的 **block id 写进源 Markdown**，之后所有能力（高亮、跳转、修复、删除清理）都靠这个 id 定位。

**表格和 PDF 都是这个策略失效的场景**，但失效的原因完全相反：

| | 表格 | PDF |
|---|---|---|
| 能不能写进源文件 | 能写，但**写了就出错**（渲染成可见单元格文本 / 被外部工具搬走） | **根本不能写**（二进制，插件无写入能力） |
| 最终定位手段 | 纯文本搜索（`selectedText`） | 页码（`anchor.page`） |
| 源文件里留下什么 | 一个字符都不留 | 一个字符都不留 |
| 共同结论 | **批注文件（`Agent Memory/annotations/*.md`）是唯一真相源** | 同左 |

两者都指向同一个设计收敛点：*不要把状态寄存在你不拥有的文件里*。

---

## 1. 表格批注

### 1.1 遇到的问题（三条根因）

**(a) Obsidian 把表格行尾的 `^id` 渲染成可见的单元格文本。**
普通段落末尾的 ` ^ann-…` 会被 Obsidian 当作 block id 语义隐藏掉；但在表格行里它落进单元格，用户直接看到一串 `^ann-20260831-001`。判定见 `src/editor.ts` 的 `isTableRow`（`/^\s*\|/`）。

**(b) 外部 rewriter 会把行尾 id 拖到行中（pipe 之前），还会复制到多行。**
本 vault 的笔记被外部工具反复重排（表格对齐/格式化）。一旦 id 变成 `| 焦虑激活 ^ann-… | ECR-R |` 这种形态，**所有基于行尾正则 `\s+\^([\w-]+)\s*$` 的匹配全部失明**——`detectBlockId`、`planDecorations` 主循环、`MarginRail` 的 `lineByBlock` 都看不到它。同时 rewriter 还会把专门锚行（表格下方单独一行 ` ^id`）吸进表格或直接删掉。

**(c) Live Preview 的表格 widget 由 CodeMirror 独占 DOM，而且只在光标离开表格时才存在。**
两层打击：

- widget 替换了源码行 → 落在那些行上的 CM decoration **不可见**；
- 退而求其次直接往 widget DOM 里注入 `<span>` → **CM 会静默回滚**；
- 更麻烦的是：光标在表格内时 `contentDOM` 里根本没有 `<table>`，只有可编辑源码；而「源码态 ↔ widget 态」的切换**不产生任何 CM update 事件**（`docChanged` / `viewportChanged` / `geometryChanged` 全为 false）。

### 1.2 技术手段

**① 三处「表格禁写」**，覆盖所有会往源文件写 id 的路径：

| 路径 | 位置 | 守卫 |
|---|---|---|
| 编辑器内创建 | `main.ts` `createAnnotationFromEditor` | `!isTableRow(endLineText)` |
| Reading view 创建 | `main.ts` `createAnnotationFromReading` | `!isTableRow(lines[block.endLine])` + `vault.process` 内二次 `!detectBlockId(target)` |
| 锚点修复 | `main.ts` `repairAnchor` | `!isTableRow(lineText)` |

注意：`anchor.blockId` **仍然会生成并写进批注文件**，只是不写进源 Markdown。这就是提交 `1c49781 fix: table annotations work without any in-doc anchor` 标题的含义——索引/锚点数据里保留逻辑 id，文档里一个字符都不落。

**② 单向 strip-only 迁移**：`src/editor.ts` `migrateInRowBlockIds(lines, knownIds)`

把已经污染在表格行里的 id 清掉，**什么都不写回去**。设计要点：

- 只处理 `isTableRow` 为真的行，段落/标题里的 `^id` 一律不动；
- 只认两类 id：索引里已知的 `knownIds`，以及匹配 `ORPHAN_ANN_ID`（`/^ann-\d{8}-\d{3}$/`）的孤儿 id；
- **绝不误伤裸 `^`**：数学里的 `x^2`、脚注 `[^1]` 必须原样保留（有专门测试）；
- 剥除正则用后向否定前瞻 `(?![A-Za-z0-9_-])`，防止 `^ann-…-001` 命中 `^ann-…-0011`；
- **幂等**：无变化时返回入参原数组引用（`changed: false`），有变化时二次调用不再改动；
- 调用方 `main.ts` `migrateTableAnchors` 用 `vault.process` 保证原子性，且 `changed === false` 时返回原 `data` 不落盘；
- `migratingFiles` 集合守卫：迁移自己的写入不得再触发 `vault.on("modify")` → watcher → reconcile 的自激回路。

**为什么是「只剥不插」而不是「迁移到表格下方的专用锚行」**：

1. **插到哪里都是错的**——行尾渲染成单元格文本；专用锚行会被外部 reformatter 吸进表格或删掉；
2. **插了也没用**——三条渲染管线现在都能不靠 in-doc id 工作（见 ③）；
3. **写了就会自己咬自己**——往用户笔记里插字符 = 触发 modify 事件 = 可能再次触发迁移，而每次插入又可能被外部工具再重排，形成插件与 rewriter 的无限拉锯。

所以最终答案是**单向收敛**：只把文档往「无 id」的稳态推，稳态即不动点。

> 化石证据：`migrateTableAnchors` 的 docstring 至今还写着 "Move annotation ids that ended up inside table rows **onto dedicated anchor lines below their table**"——那是上一版方案的残留，实现里一行插入代码都没有。见 §3.1。

**③ 三条渲染管线全部退化为纯文本搜索**

| 管线 | 载体 | 表格兜底 |
|---|---|---|
| Source / Live Preview 源码态 | CM `Decoration`（`decorations-plan.ts` `planDecorations`） | block id 在全文找不到时，走**全文文本搜索**；`fallbackCursor` 让同一段文字的多条批注落在不同位置 |
| Live Preview 渲染态 | **自建覆盖层**（见 ④） | `locateInRaw` → `locatePartial` 两级匹配 |
| Reading view | 直接包 `<span>`（`reading-highlight.ts`） | 三层：行内任意位置扫 token → section 失配时对整个 preview root 重试 → 文档级纯文本兜底 |

**④ Live Preview 覆盖层**（`src/margin-rail.ts` `decorateTables` / `buildTableHighlight`，CSS 在 `styles.css` 的 `.atl-table-hl*`）

既然不能改 widget DOM，就在它**上面盖一层**：

- 独立 `div.atl-table-hl` 挂到 `view.dom`，`position:absolute; inset:0; pointer-events:none`；
- 每个高亮片段是一个绝对定位的 `div.atl-table-hl-strip`，`pointer-events:auto` 单独恢复；
- 几何来源：`createTreeWalker(table, SHOW_TEXT)` 收集全部文本节点 → 拼成一条 `raw` 串 → 匹配出 span → 按节点切片建 `Range` → 对 `range.getClientRects()` 的**每个** rect 画一个 strip（跨行/跨单元格自然得到多个）→ 坐标减去 `view.dom` 的 rect 换算成相对定位；
- `rect.width < 1 || rect.height < 1` 的片段直接丢弃（widget 未 hydrate 时的典型形态）。

**⑤ 容错文本匹配 `locatePartial`**（`src/reading-highlight.ts`）

精确匹配（`locateInRaw`，含空白/CJK 换行两种归一化）失败后的救命逻辑。两类真实场景会让选区**永远无法按原样渲染**：选区尾部拖进了只在源码里存在的东西（`^id` 锚行、跨到下一格的 pipe），或者外部 rewriter 事后截断了单元格。两者的共性是：**选区的一个前缀仍然存在于渲染文本中**。

算法：

- `keep(ch)` 只保留数字、拉丁字母、`codePoint > 127`（覆盖全部 CJK/emoji/重音字母），**丢掉所有标点、空格、pipe、`^`** → `| esteem | Maslow (1943) |` 与渲染后的 `esteem Maslow 1943` 变得可比；
- 全程 **codepoint 安全**：遍历用 `codePointAt` + `String.fromCodePoint` 推进，needle 用 `[...text]` 展开，绝不切断代理对；
- 因为 `joined.indexOf` 返回 UTF-16 偏移而 `starts/ends` 按 codepoint 索引，中间有一次显式换算 `cpIndex()`；
- 门槛 `minLen = max(8, ⌈n/2⌉)`：存活不足一半就放弃，避免把不相干的片段点亮；
- 精确命中优先，否则**二分查找最长存活前缀**（`includes` 对前缀长度单调，二分成立）；
- 尾部标点扩张 `extend()`：把 span 尾端拉过右括号、逗号等，使视觉上属于匹配部分的标点也被高亮。

**⑥ 入库前净化 `cleanSelection`**（`src/editor.ts`）

block id 永不渲染，把它存进 `selectedText` 会让**任何**渲染视图都匹配不上。所以入库前先丢掉纯锚行、再剥掉最后一行的 `^id` 后缀。

**⑦ 创建后主动把光标移出表格**（`cursorOutsideTable` + `setCursor`）

针对 1.1(c) 的「光标在表内 → 无 `<table>` → 覆盖层无处可画」。创建后把光标移到表格块的下一行（表格到文末则退到上一行，整文件都是表格则退到第 0 行），widget 立刻渲染，高亮立刻可见。代价：用户能感知到光标跳了一下。

**⑧ 重绘触发集合：刻意不含 `ResizeObserver`**

覆盖层的重绘由四种**只会收敛、不会自激**的信号驱动：

- `update()`（doc / viewport / geometry / config / expanded 变化）；
- `scrollDOM` 的 `scroll` 监听（passive）；
- `MutationObserver` 观察 `contentDOM`，`{ childList, subtree, characterData }`——`characterData` 是必需的，因为 CM 会「外科式」刷新单元格（只换文本节点、不移除 `<table>`），否则覆盖层会在重建后停留在陈旧状态或变空；
- 有界重试 `setTimeout`。

全部收敛到 `schedule()`，内部用 `requestAnimationFrame` + 单飞闸门防止同帧多次 render。

**⑨ per-mark 滞回（防闪烁）**

CM 重建表格 widget 时会出现**单元格瞬间为空**的中间态。如果这时整体清空覆盖层，高亮会消失长达数秒（用户报告的「两个状态」症状）。所以拆成两半：

- **失效即删**：mark 已不存在（批注被删、样式被关闭）的 strip 立刻 `remove()`，不留幽灵高亮；
- **存活则保留**：某 mark 这一帧算不出新 strip 时，**不动它的旧 strip**，等重试画出新的再替换；
- **例外**：`tables.length === 0`（源码态）时必须整体清空，因为此时覆盖层下方是可编辑源码，留着 strip 会盖在错误的文本上。

**⑩ 有界重试**

Obsidian 在光标离开后**异步** hydrate 表格 widget，早画会量到空单元格，而且之后可能没有任何 mutation 来触发重绘。所以：只要有 mark 缺新 strip，就 400ms 后再 `schedule()`，**上限 8 次（≈3.2s）**，双闸门（计数 + 定时器句柄）防重复挂载；`configChanged` 时重置预算——上一批（可能永远匹配不上的）状态花掉的额度，不能饿死一条新批注。

**⑪ strip 用 `mousedown` 而非 `click`**

如果用 `click`：CM 的 root `mousedown` 会先把光标移进单元格 → 表格翻回可编辑源码态 → widget 销毁 → strip 在 `click` 触发之前就没了。所以在 `mousedown` 阶段就 `preventDefault()` + `stopPropagation()`（与 `MarkerWidget` 同样的手法）。

**⑫ 卡片锚定也要认覆盖层**

`anchorFor()` 的候选元素选择器同时覆盖 `contentDOM` 里的 `[data-atl-id]` 和覆盖层里的 `[data-atl-id]`，id 经 `CSS.escape` 后插入；取**最后一个**命中元素，以对齐多行 span 的末尾。边注卡片的行号同样靠文本找（`selectedText` 首行在全文里线性扫描），因为表格 mark 必然没有 block id。

### 1.3 走过的弯路

**弯路一：往 widget DOM 里注入 `<span>`。**
`1c49781` 采用的就是这个方案，注释里当时还乐观地写着「包裹 widget 自己的 DOM 能让高亮和点击切换照常显示」。实际被 CM 静默回滚。工作区版本把它整段换成覆盖层，`highlightFirst` 的 import 也随之换成 `locateInRaw, locatePartial`。

**弯路二（t20 轮，已回退）：`ResizeObserver` + 焦点微调，导致无限渲染循环。**
两个独立错误叠加：

- **无限循环**：`ResizeObserver` 回调里拿 `entry.contentRect`（content box）去比一个存下来的 `getBoundingClientRect()`（border box）。表格有边框，两者**永不相等** → 每次回调都判定「变了」→ 调 `schedule()` → render 重建 observer → 再次回调。日志表现为 `held=3` 持续震荡、`first@` 不断跳动。
- **焦点竞态**：在 t+0 加了 `editor.focus()`，而 `views/note-panel.ts` 本来就在 t+0 做 `textarea.focus()`——两次抢焦点互相打架。

修复方式是**整体回退到 t19**：把 `ResizeObserver` 那段和 `tableSizes` 字段一起删掉，焦点微调也去掉。留在代码里的防御痕迹（8 次重试硬上限、`configChanged` 才重置预算、`schedule()` 的 rAF 单飞、日志签名去重、`refreshDecorations` 改成 leaf-explicit 不看活动视图/焦点）都是这一轮的产物。

**教训**：`ResizeObserver` 驱动的「尺寸变化 → 重绘 → 布局变化 → 尺寸变化」天然是自激回路；覆盖层的触发集合必须只包含离散事件 + 有界定时器。

---

## 2. PDF 批注

### 2.1 遇到的问题

**关键前提（先验证过才动手）**：Obsidian 的原生 PDF 视图是用**定制版 PDF.js 直接渲染进 DOM**，不是 iframe。所以 `textLayer` 存在、`window.getSelection()` 能拿到选中的 PDF 文本。这一条是方案可行的承重墙——如果是 iframe，选区根本跨不过去。

在此基础上遇到的问题：

**(a) PDF 是二进制，插件写不进去**，所以永远不可能有 `^blockId`。真正的定位符是**页码**。

**(b) `blockId` 非空是个硬不变量。** `markdown/annotation-file.ts` 的 `parseV2Annotation` 会**直接拒绝** `blockId` 为空的批注——一条没有 blockId 的 PDF 批注会在重新解析时被当成损坏文件，**从索引里静默消失**。

**(c) `openAnnotation` 会把 PDF 误判成 `source_missing`。** 原逻辑是「非 `.md` 一律标记源文件丢失」。PDF 批注只要在 dashboard 上被点开一次，就会被**永久打上损坏标记**——这是数据污染，不是显示问题。

**(d) 【严重】`deleteAnnotation` 会损坏 PDF 文件本身。** 完整调用链：

| 位置 | 事实 |
|---|---|
| `main.ts` `deleteAnnotation` | `bareBlockId(record.anchor)` → `"p3"` |
| `main.ts` `fileAt` | 只判 `instanceof TFile`，**不看扩展名** → 返回 PDF 的 TFile |
| `memory-policy.ts` `shouldRemoveAnnotationBlockId` | PDF 批注的 `anchorOrigin` 是 `"generated"`，第一关放行 |
| 同上，`.some()` | 比较 `candidate.anchor === record.anchor`，而 `IndexRecord.anchor` 是**字符串**（`model.ts`），值为 `^p3` |
| `main.ts` | `vault.process(file, data => stripBlockIdTokens(data, blockId))` |

`vault.process`（`obsidian.d.ts`）的语义是「read, modify, and save」，**总会写回**，即使 `stripBlockIdTokens` 在 PDF 字节里什么都没匹配到。

**触发条件**：删除任意一条「所在页没有其他批注」的 PDF 批注——也就是最常见的情况。只有当同一页存在 ≥2 条批注时（anchor 字符串都是 `^p3`，`.some()` 命中）才侥幸不触发。

> 审计过程中一度有过分歧：一种说法认为 `.some()` 比较的是 anchor **对象**、恒为 false、bug 无条件触发。这是错的——`IndexRecord.anchor` 是字符串，所以 bug 是**有条件**的。这个区别直接决定了测试怎么设计（必须覆盖「独占一页」和「同页两条」两个分支）。

**(e) PDF 原始字节被喂进 LLM prompt。** 两条路径：

- `views/chat-view.ts` 把 `record.sourceFile` 直接当 `notePath`，再调 `main.ts` `noteContent()` → 只判 `instanceof TFile` 就 `vault.read()` → 乱码灌进聊天上下文，把 `NOTE_CONTENT_BUDGET`（6000 字符）整个占满；
- `main.ts` `readVaultFileForAgent` 有 vault 边界守卫和 `.obsidian` 守卫（防 prompt injection 偷 API key），但**没有二进制守卫**，而且这条路径**没有任何长度上限**。

**(f) 笔记本导出里的死链。** `markdown/notebook.ts` 的 `blockLink` 产出 `[[Papers/foo.pdf#^p3|…]]`。PDF 没有 `^block` 目标，Obsidian 只认 `#page=N`——链接点了没反应（不崩，但废）。

### 2.2 技术手段

**① 数据模型：`Anchor.page` + `p<N>` 占位符**

```ts
export type Anchor = {
  blockId: string;
  selectedText: string;
  /** PDF sources only: 1-based page the selection was made on. */
  page?: number;
};
```

`blockId` 对 PDF 存 `p<N>`（页码未知时存 `"pdf"`），**纯粹为了满足 (b) 的非空不变量**；`page` 才是真正的定位符。这个取舍写进了 `model.ts` 的类型注释里。

**② 页码解析规则抽成纯函数**（`src/pdf-anchor.ts`）

Obsidian 用的是定制版 PDF.js，**哪个标记携带页码没有保证**。所以把「DOM 遍历收集候选」和「接受/拒绝规则」拆开：

- DOM 遍历留在 `main.ts`（`pdfPageOf`）：从 `selection.anchorNode` 往上找 `[data-page-number]` 和 `.page` 容器的 id；
- 规则在 `pdf-anchor.ts`：`parsePdfPage(candidates)` 按序取第一个可用值（`data-page-number` 优先于容器 id），拒绝空/非数字/0/负数——**一个陈旧或外来的属性永远不能变成锚点**；`pageIdDigits` 用全串匹配 `/^page(\d+)$/`，所以 `page12-extra` 不会被误读成第 12 页。

这样拆的收益：规则可以在 `environment: "node"` 下直接单测，不需要 jsdom（本仓库的既定测试约定）。

**③ PDF 视图识别：匹配文件扩展名，不匹配 view-type 字符串**

Obsidian 没有公开其 PDF 阅读器的 view-type 字符串。所以 `pdfViewContaining(target)` 用 `workspace.iterateAllLeaves` 遍历所有 leaf，判定条件是 `view instanceof FileView && view.file?.extension === "pdf" && view.containerEl.contains(target)`。不依赖任何未文档化的常量。

**④ 右键菜单链式共存**

Reading view 的菜单在显示时会 `preventDefault()`，所以 PDF 的处理器挂在同一次 `contextmenu` 后面、开头判 `event.defaultPrevented` 即返回——对 Markdown 完全惰性，只在 PDF 上生效。两个功能互斥且不需要额外的类型判断。

**⑤ 空选区留诊断埋点，而不是瞎猜兜底**

选中为空时不弹菜单（与 Reading view 行为一致），但会往 `debug-create.log` 写一行 `domPathOf(target)`——祖先 `tag.class` 链。这样一旦 PDF.js 的 DOM 形状变了导致选区取不到，日志能直接告出**实际**结构，而不是让人靠猜去加兜底分支。页码解析失败同样打点（`pdf page-unresolved …`）。

**⑥ 序列化：`#page=N` 片段 + 扩展名必须存活**

批注文件里的「Open in source」链接对 PDF 走 `[[Papers/Attention.pdf#page=3|Open in source]]`。**扩展名不能被剥掉**——那正是 Obsidian 用来判断「该开 PDF 阅读器还是开笔记」的依据（Markdown 分支相反，必须剥掉 `.md`）。frontmatter 增加条件性的 `page:` 字段，Markdown 输出保持逐字节不变。

**⑦ 跳回源文件：`eState.page`**

`revealPdfPage` 用 `leaf.openFile(file, { eState: { page } })`——这是 Obsidian 自己的机制，不是插件去操作 PDF.js。

**⑧ 三处二进制守卫（t23）**

| 位置 | 改动 |
|---|---|
| `main.ts` `deleteAnnotation` | 条件从 `file &&` 改成 `file?.extension === "md" &&`——不变量是**只向 Markdown 写回**，顺带覆盖未来可能出现的图片/epub 源 |
| `main.ts` `noteContent` | PDF 直接返回 `[PDF source: body text not extracted]`，不读文件。选中文本来就单独进 prompt（`chat-prompt.ts` 的 `Selected text:` 段），模型不会瞎 |
| `main.ts` `readVaultFileForAgent` | PDF 返回 `null`，与既有 `.obsidian` 拒绝语义一致 |

**⑨ 死链修复：`pdfPageFromBlockId`**

索引记录里不带 `page`（只有 anchor 字符串 `^p3`），所以在 `pdf-anchor.ts` 加了 `pdfBlockId` 的逆函数，从占位符反解页码，`blockLink` 据此产出 `[[…pdf#page=3|…]]`，页码未知时退化为纯文件链接。

### 2.3 实测证据：损坏是真的

用 vault 里 `Book World.pdf` 的**副本**（原件未动，scratch 在 `E:\atl-pdf-scratch`）照 `vault.process` 的语义做了一次 UTF-8 往返，**transform 是 no-op**——`stripBlockIdTokens` 在 PDF 里什么都匹配不到：

```
before: 4322766 bytes  a9705baf32cf696fb9bff95c10f8901175c23ce4241f68db278df7984c0e2a69
after:  6878282 bytes  8857a6870ea97d8dba7af3b160303851f2e009e57ae5d8b92ea03b7bf2c82b42
size delta: +2555516 (+59%)
first differing byte offset: 10
differing byte positions: 4294842
header still %PDF-: true      trailer still has %%EOF: true
startxref=4205380 → 原本指向 "xref"，往返后指向 " /Te"    BROKEN
```

三个结论：

1. **损坏是结构性的**：`startxref` 指向的交叉引用表定位失效，PDF 阅读器无法解析。而 `%PDF-` 头和 `%%EOF` 尾都还在——所以它表面上**看起来还像个 PDF**，这正是这个 bug 阴险的地方（用户可能几天后才发现）。
2. **损坏与 transform 改没改内容无关**：no-op 也照样毁掉文件。所以修复只能是**阻止这次写入**，不能指望把 transform 写得更聪明。
3. `vault.read` / `vault.process` 是**纯文本 API**，对任何二进制 vault 文件都必须先按扩展名守卫。这条已经写进项目记忆，未来加图片/epub/音频批注时会再次适用。

---

## 3. 当前仍存在的问题

### 3.1 表格

| # | 问题 | 位置 | 严重度 |
|---|---|---|---|
| T1 | **「创建后高亮不立即显示，要先点别处」仍未根因定位。** 已 park，方案是先加纯埋点（mark 缺失时 dump 目标单元格文本头 + editor 焦点/选区状态），复现一次取真值，区分「widget 未 hydrate」/「文本匹配失败」/「几何错位」三种可能，再用**单一机制**动手。`railDebug` 埋点通道就是为它留的 | 内部任务 #13 | 高（用户可感知） |
| T2 | **`knownIds.size === 0` 早退让 orphan 清理在生产路径上几乎不可达。** 纯函数特意支持传空集合来清孤儿 id（有测试覆盖），但调用方在集合为空时直接 return。而孤儿的最典型成因恰恰是「批注被删后索引记录消失」→ 此时集合很可能为空 → 孤儿永久留在单元格里。纯函数与调用方契约不一致 | `main.ts` `migrateTableAnchors`（t23 快照 :1921） | 中 |
| T3 | **docstring 与实现不符**：`migrateTableAnchors` 的注释还写着 "Move … onto dedicated anchor lines below their table"，实现里一行插入代码都没有（§1.2 ② 的方案转向残留） | 同上（:1907-1908） | 低（误导后续维护者） |
| T4 | **迁移只在 `file-open` 和插件启动时跑。** 外部 rewriter 在笔记已打开时重排是本 vault 的常态，但 `modify` 事件后没有任何地方重新调用迁移 → 行中 id 残留要等到下次打开该文件才被清 | `main.ts`（两个调用点） | 中 |
| T5 | **滞回 hold 住的旧 strip 没有 TTL。** 被 hold 的 strip 坐标基于上一次表格布局；若 hold 期间表格重排而新 strip 始终算不出来（如 rewriter 把单元格文字改到存活不足一半），旧 strip 会**停在错误坐标上**，直到 mark 失效或表格消失 | `margin-rail.ts` `decorateTables` | 中 |
| T6 | **被高亮的单元格文本无法用鼠标选中/复制。** strip 是 `pointer-events:auto` + `mousedown` 阶段 `preventDefault`（§1.2 ⑪ 的必然代价）。对「想复制表格里那段被批注的文字」的用户是负体验 | `margin-rail.ts` `buildTableHighlight` | 中（设计权衡，非 bug） |
| T7 | **`locatePartial` 的短选区没有兜底。** `minLen = max(8, ⌈n/2⌉)` 意味着有效字符 < 8 的选区根本没有 partial 匹配，只剩 `locateInRaw` 的精确/空白容错。纯符号选区（`|---|---|`、公式片段）会被 `keep()` 过滤到门槛以下 → 永不匹配 | `reading-highlight.ts` | 中 |
| T8 | **`locatePartial` 只取第一个匹配。** 表格中同一短语出现在多行时永远高亮第一处；`buildTableHighlight` 会遍历所有 `<table>`，但同一张表内不做多命中 | 同上 | 低 |
| T9 | **跨单元格误匹配被固化为期望行为。** `raw` 是整表文本拼接，所以匹配可能把两个不相干单元格的文本连起来命中（视觉上同时高亮两格）。测试 "matches across cell boundaries where punctuation differs" 把它写成了预期，但它本质是一种误匹配容忍 | `margin-rail.ts` / `reading-highlight.ts` | 低 |
| T10 | **`isTableRow` 只认行首 `\|`。** GFM 允许省略首尾 pipe（`a | b`），这种表格不被识别 → 会被当普通段落，id 写进行尾并渲染成可见文本。反之，以 `\|` 开头的非表格行会被误判 | `editor.ts` | 低 |
| T11 | **CRLF 笔记在迁移写入后被规范成 LF。** `vault.process` 里 `split(/\r?\n/)` 但回写用 `join("\n")`；`changed === false` 时返回原 `data` 避免了无谓写入，但一旦 `changed === true`，整文件行尾就变了 → 外部 diff 工具会报整文件改动 | `main.ts` `migrateTableAnchors`（:1925-1926） | 低 |
| T12 | **`CSS.escape` 覆盖不全。** 本轮只修了 `margin-rail.ts` `anchorFor` 和 `main.ts` `syncReadingHighlights` 两处；`main.ts` `decorateReadingView` 的两处、`reading-rail.ts` 的两处仍是裸插值。当前 id 形态（`ANN-YYYYMMDD-NNN`）在 CSS 属性选择器里合法所以不出错，属未完成的一致性收尾 | 多处 | 低 |
| T13 | **覆盖层里 `atl-hl-wavy` 没有真正实现。** `styles.css` 中 `.atl-table-hl-strip.atl-hl-wavy` 写的是 `border-bottom: 2px dotted`，与 `.atl-hl-dotted` **完全相同**（普通文本的 `.atl-hl-wavy` 用的是正确的 `text-decoration: underline wavy`）。表格里的波浪线下划线实际显示为点线 | `styles.css`（:61-67） | 低 |
| T14 | **`MarginRail` / `decorateTables` / `buildTableHighlight` 完全没有单测**（需要 DOM + CM `EditorView`，而 `vitest.config.ts` 是 `environment: "node"`）。滞回、有界重试、MutationObserver、strip 几何全部只能真机验证 | — | 中（回归风险） |
| T15 | **`tables × marks` 笛卡尔积 + 全表 TreeWalker。** 每条 mark 都完整遍历每张表的所有文本节点；大表格 × 多批注 × 每 400ms 重试 → 主线程压力。strip 坐标还依赖 `view.dom` rect 的瞬时值，任何未被观察到的布局变化（字体加载、窗口 resize、侧栏动画）都会让它错位 | `margin-rail.ts` | 中（性能/正确性） |

### 3.2 PDF

| # | 问题 | 严重度 |
|---|---|---|
| P1 | **没有 in-PDF 高亮覆盖层。** 这是「方案一（最小可用）」**故意**不做的：批注存下来了、能跳回对应页，但 PDF 里看不到高亮痕迹。要做到需要自绘覆盖层并跟踪 PDF.js 的滚动/缩放/页面重排，复杂度和 §1.2 ④ 的表格覆盖层同级甚至更高 | 中（功能缺口，非缺陷） |
| P2 | **页码解析依赖 PDF.js 的 DOM 形状，本质脆弱。** `[data-page-number]` 和 `.page` 容器 id 都不是 Obsidian 的公开契约，Obsidian 升级换 PDF.js 版本就可能失效。已用 §2.2 ⑤ 的埋点降低排障成本，但没有第二套解析路径 | 中 |
| P3 | **聊天里 PDF 批注没有正文上下文。** 守卫（§2.2 ⑧）挡住了乱码，但模型现在只拿得到用户选中的那一段 + `[PDF source: body text not extracted]`。要真正解决需要 PDF 文本抽取（Obsidian 内部有 PDF.js，但没有公开的文本抽取 API），或者引入外部解析 | 中 |
| P4 | **`readVaultFileForAgent` 拒绝 PDF 后，agent 无法读论文正文。** 拒绝是对的（否则灌入无上限乱码），但 agent 复审 PDF 批注时只能依赖批注文件自带的上下文。与 P3 同源 | 中 |
| P5 | **`anchorOrigin` 对 PDF 恒为 `"generated"`，语义不准确。** 它本来是「插件写进文档的 id，删除时可回收」的意思；PDF 根本没有写入动作。目前靠 `deleteAnnotation` 的 `.md` 守卫兜住，但语义上应该有个 `"external"` / `"none"` 之类的值 | 低 |
| P6 | **笔记本里 PDF 页的 slug 带 `-pdf` 后缀**（`slugify` 只剥 `.md`），页面文件名形如 `pages/Papers-Attention-pdf.md`，标题显示为 `Attention.pdf`。确定且无歧义（若剥掉 `.pdf` 会与同名 `.md` 笔记的页面撞车，反而更糟），但观感一般 | 低 |
| P7 | **真机端到端验证尚未完成**（内部任务 #24）：需要重载 Obsidian → PDF 里选中记批注 → 从 dashboard 删除 → 确认 PDF 仍能打开且大小未变；同时回归验证 Markdown 批注删除后源文件里的 `^id` 仍被正确剥掉。机制层面已用 §2.3 的实测证明，但 UI 链路我无法自己驱动 | 高（交付前必做） |

### 3.3 两者共通

| # | 问题 | 说明 |
|---|---|---|
| C1 | **纯文本锚定的鲁棒性是整个方案的地基。** 表格完全依赖 `selectedText` 匹配，PDF 的选中文同样是唯一的内容锚。一旦外部工具改写了单元格文字、或用户在 PDF 里选了不同粒度的一段，定位就退化。`locateInRaw` → `locatePartial` 是两级容错，但**没有第三级**（如模糊匹配/相似度阈值），也没有「定位失败」的用户可见反馈——批注只是安静地不再高亮 |
| C2 | **「源文件不可信」这个前提没有被系统化。** 目前是逐处打补丁（三处禁写、三处二进制守卫、两层文本兜底）。缺一个集中的 `SourceKind`（`markdown` / `pdf` / 未来 `image`、`epub`）抽象，让每条读写路径在入口处一次性声明能力，而不是各自判扩展名。下次加入新的非 Markdown 源时，同样的坑会再踩一遍 |
| C3 | **覆盖层/几何类逻辑缺乏自动化验证。** 表格覆盖层（T14）和 PDF 页码解析（P2）都属于「只能真机验证」的部分，而真机验证依赖人工步骤，回归成本高 |

---

## 4. 方法论复盘

t20 那一轮（§1.3 弯路二）的失败比成功更有信息量，教训有三条，已直接影响 t22/t23 的做法：

1. **不要一次叠三个未验证的机制。** t20 同时引入了 `ResizeObserver` 重绘、焦点微调、以及尺寸缓存字段，出问题时无法归因。PDF 那一轮刻意**只加一条新通路**（右键 → 面板 → 保存），其余全部复用既有链路。
2. **埋点要能区分假设，而不是确认结论。** t20 的日志只报「高亮数量在震荡」，无法区分是尺寸比较错了还是别的；真正定位靠的是把 `contentRect` 和 `getBoundingClientRect()` 的差值打出来。PDF 的空选区埋点（`domPathOf`）就是照这个标准设计的——它输出**实际 DOM 结构**，能直接证伪「textLayer 不存在」这类猜测。
3. **部署前必须读懂新日志。** t20 是部署后才在日志里看到 `held=3` 震荡的，而当时没有停下来分析就交付了。t23 的做法是先离线复现机制（§2.3 的 SHA-256 + `startxref` 实测），拿到确定的因果再动手。

还有一条关于**审计**的：三个并行审查 agent 对 `shouldRemoveAnnotationBlockId` 的行为给出了**互相矛盾**的结论（§2.1 (d)）。矛盾点最终靠直接读 `model.ts` 里 `IndexRecord.anchor` 的类型声明解决——是 `string` 不是对象。**二手结论必须落到类型声明或实测数据上才能写进文档或用来指导修复。**
