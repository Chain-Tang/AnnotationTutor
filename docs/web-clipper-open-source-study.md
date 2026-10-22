# Tutor Web Clipper：开源项目借鉴研究

日期：2026-09-14

## 结论

正式架构采用“双入口”：官方 Obsidian Web Clipper 负责默认、跨浏览器的模板化剪藏；Tutor 原有的“Readability → Turndown → localhost bridge → Markdown + 原始 HTML”保留为 Advanced Clipper，负责页内问答、逐条高亮备注和证据快照。两者写入后统一进入 Tutor 的 API/OpenCode 分析路由。

## 可借鉴项目

| 项目 | 可借鉴能力 | Tutor 建议 | 许可注意 |
| --- | --- | --- | --- |
| [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper) | 模板、变量、过滤器、条件/循环；Schema.org 与 CSS selector 元数据；跨 Chromium/Firefox/Safari 构建 | **已选为默认入口**；Tutor 生成版本化 JSON 模板并监听带 `tutor_capture: official-v1` 的笔记，不复制或 fork 官方源码；Interpreter 默认关闭 | MIT；官方扩展独立安装，Tutor 仅提供兼容模板与后处理 |
| [Hypothesis Client](https://github.com/hypothesis/client) | Range、TextPosition、TextQuote、MediaTime 多 selector 组合，按精确到模糊逐级回退；quote mismatch 校验 | 将现有 exact/prefix/suffix 扩展为 DOM range + text position + text quote；重访页面时先校验原文，再逐级降级，保存锚点健康状态 | BSD-2-Clause；保留版权及许可声明 |
| [Zotero Connectors](https://github.com/zotero/zotero-connectors) | URL 匹配后再运行站点 translator 检测；浏览器注入层、后台协调层、本地连接器分层；结构化书目元数据 | 不照搬 600+ translators；建立小型 site adapter 注册表，先覆盖论文、新闻、视频、通用文章，输出统一 metadata envelope | AGPL；架构可借鉴，若复制/改造代码需评估整个衍生作品的开源义务 |
| [SingleFile](https://github.com/gildas-lormeau/singlefile) | 自包含 HTML、资源内联、frame/多 tab、取消与自动保存；明确区分可读正文与忠实归档 | 将“正文 Markdown”和“证据快照”分层；可选接入其外部扩展/CLI，而不是直接把 AGPL 核心嵌入 Tutor | AGPL-3.0；优先做可选互操作，避免直接复制核心代码 |
| [MarkDownload](https://github.com/deathau/markdownload) | 剪藏前 Markdown 预览与微调、选择区剪藏、路径和文件名参数化、跨浏览器发布 | 增加保存前预览/编辑与附件路径规则；这是低风险、高感知收益的改进 | Apache-2.0；复用时保留 NOTICE/许可要求 |

## 推荐路线

### P0：先修正确性与隐私

- 四个功能入口独立选引擎：侧边栏、审阅、画板、网页插件。
- 网页 AI 必须显式开启；先保存原文，再调用模型，失败不影响剪藏。
- 将网页正文视为不可信输入，用边界标签包裹，禁止网页内容改变系统指令。
- 对每次 AI 分析记录引擎、模型、时间、源 URL 与内容摘要哈希，便于复现和审计。

### P1：模板与元数据

- 支持 `title/url/domain/author/published/selection/highlights/content`。
- 读取 OpenGraph、标准 meta、JSON-LD/Schema.org，保留字段来源与冲突。
- 模板匹配按域名或 URL 规则，保存前给出 Markdown 预览。

### P2：锚点与双向回链

- 保存 TextQuote + TextPosition + DOM Range 三类 selector。
- 在网页端显示“已同步到 Vault”的状态与对应笔记链接。
- 页面变化后标记锚点为 exact/recovered/orphaned，不静默错挂。

### P3：可靠归档与队列

- 增加离线发送队列、幂等 capture id、指数退避与可见失败原因。
- 大页面使用分块或压缩传输，桥接端验证内容长度与 hash。
- 忠实快照作为可选能力；优先与 SingleFile 互操作，再决定是否自研资源内联。

## 不建议直接照搬

- 不把 API key 放进浏览器扩展；模型调用继续由 Obsidian 宿主统一执行。
- 不默认对所有剪藏运行 AI；成本、隐私和提示注入风险都要求 opt-in。
- 不用单一 XPath 作为永久锚点；动态 DOM 下过于脆弱。
- 不直接嵌入 AGPL 的 Zotero/SingleFile 大块代码，除非项目明确接受对应分发义务。
