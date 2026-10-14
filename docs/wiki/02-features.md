# 02 · 核心功能拆解

以下描述已实现的功能，不代表全部真实交互已验收。2026-10-12 的开发候选为 C66；安装版本及未通过项以 [最新核对报告](../qa/implementation-status-20261012/report.md) 为准。

## 1. 学习批注（核心动作）

- 选中文字，按 `Ctrl/Cmd + Shift + L` 添加批注，写下自己的理解。
- 支持三种材料：**Markdown 笔记、Markdown 表格单元格、可选中文字的 PDF**。
- 源文本处插入 Obsidian 块 ID（`^ann-YYYYMMDD-NNN`）锚定，编辑原文不丢失关联；批注本体是 `Agent Memory/annotations/` 下的独立 Markdown 文件，含原文引用、我的理解、Agent Review、Dialogue 区段。
- 点击高亮重新打开便签；可启用「页边批注」获得可拖动便签卡片。
- 皮肤：简洁、纸张、便利贴、叶片或自定义；默认隐藏工具按钮，鼠标移入才显示（键盘与触摸仍可访问）。
- PDF 与 Markdown 共用一套高亮颜色变量与样式；**批注保存在 PDF 之外，不改写原始 PDF 文件**。
- 保存批注不需要 AI、不需要网络。

## 2. AI 导师点评与对话

- 「Ask agent to review current annotation」：引擎读取批注，判断理解正确/部分正确/不正确，把点评写入文件的 Agent Review 区段。
- 可以在批注内与导师对话，轮次保存到文件的 `## Dialogue` 区段，重载不丢失。
- 元数据与「我的理解」归插件/用户所有，Agent Review 归代理所有，互不覆盖。
- **引擎二选一**（设置 → General）：
  - **Direct API**：自备 OpenAI 兼容端点、模型与密钥；C66 使用系统加密的 Vault 外凭据存储，插件配置保留引用。历史安装版本需单独核对，不能声称都已迁移。
  - **OpenCode**：使用已登录的 `opencode` CLI（经 ACP），设置时会真实验证可执行文件、模型目录、握手与一次最小模型往返。

## 3. 学习闭环（记忆系统）

```
批注 → AI 点评 → 提炼记忆单元 → 自动聚合成场景 → 学习者画像 → 笔记本 → SM-2 复习 → 循环
```

- **记忆单元（memory cell）**：原子化、有证据支撑的记忆，含概念、摘要、类型（understanding/misconception/goal/difficulty/strategy/progress）、置信度、来源批注链接。可手动创建，也可由点评自动提炼。
- **SM-2 间隔重复**：与 Anki 同源算法（SuperMemo 2）；「Review due cells」按 Again/Hard/Good/Easy 评分调度，参数存在记忆单元 frontmatter 里。
- **场景（scenes）**：两个以上共享概念的记忆单元自动聚合成场景；手写场景不会被自动覆盖。
- **学习者画像（profile）**：可审计的纯 Markdown，每条 claim 附证据链接；偏好文件默认禁止代理写入。
- **学习笔记本（notebook）**：`Agent Memory/Notebook/` 下的 Notebook.md、按文档的 pages、按主题的 chapters、基于真实复习表现（reps/lapses）的强项/弱项总结；两条点击即可从笔记本回到原文。
- **确认模式**：记忆写入可切到 confirmation，所有变更先进入 proposals 队列，由你批准/拒绝。
- 新自然学习流程使用受限、版本化学习证据，区分自评、提示后完成与未使用插件提示完成；先从极限与连续六主题、54 个模板验证。复习次数不是客观掌握证明，完整真实交互和长期学习效果仍未通过。

## 4. 灵感画板 / Tutor Studio

- 命令面板「新建 Tutor 无限画板」进入独立 Studio；与文档覆盖层共用笔迹与历史协议。
- 左侧竖栏画笔迹、写文字、画图；右侧 Tutor 对话与画板共用模型/API/历史，**流式回复、逐步画图**。
- C66 代码包含十种内置笔刷类型：画笔、钢笔尖、铅笔、马克笔、荧光笔、粉笔、蜡笔、水彩、墨笔、油画；属性面板提供算法预览和尺寸/流量/稳定器等参数。笔感与性能通过范围须单独核对。
- Studio 提供 Artboard、矢量/绘画/组图层、透明像素锁定、剪贴、旋转、镜像、单轴对称、裁切、渐变、吸管、本地分享。
- **数学作图**：直接在右侧说「画 sin(x)/x 在 0 附近的极限图，标出空心点」，Tutor 识别意图后打开画板，曲线/坐标轴/辅助线由宿主统一计算，结果可编辑、整轮撤销。
- 导出：PNG、JPEG、WebP、SVG、PDF、OpenRaster（.ora）、可编辑 .tutorboard；高级笔刷用 .tutorbrush 数据包（无脚本、带 SHA-256 与许可信息）。
- 公开分享默认移除源文档路径、识别服务信息和隐藏图层。
- 画板默认跟随 Tutor 侧栏的引擎/连接/模型，可在设置中改为独立配置。

## 5. 网页剪藏与阅读辅助

- 默认走官方 **Obsidian Web Clipper** 跨浏览器界面；在设置 → TutorWeb 导入 Tutor 版本化模板后，剪藏可经 Direct API 或 OpenCode 分析。
- 仓库内 Chromium 扩展保留为可选的「Tutor 高级网页插件」：页内问答、逐条高亮备注、原始 HTML 快照。
- 阅读辅助：行内释义（`Alt + T`，macOS `⌘ + Shift + T`）、整篇笔记预翻译（`Ctrl + Alt + T` / `⌘ + Shift + Y`）、打开时自动预翻译；不包含整份 PDF 正文抽取。

## 6. 其他事实

- 四种界面语言：English、简体中文、繁體中文、日本語。
- 外部智能体接口：文件协议及 MCP/A2A 适配；只允许获授权的客户端读取限定材料或提交校验后的图形变更。新版学习证据使用独立只读授权，不向专家共享私有关怀数据，不允许外部工具直接改写学生证据。宿主兼容性以实际验收范围为准。
- 运行环境：Obsidian 1.12.4+，桌面端（macOS/Windows/Linux）；终端用户无需安装 Node.js。
- 许可：MIT，© 2026 Chain；仓库 `Chain-Tang/AnnotationTutor`。
