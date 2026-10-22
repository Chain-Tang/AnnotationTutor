# 第二批优化与源码归档 · 2026-10-14

接续[首批核验与升级](optimization-verification-2026-10-14.md)。产品版本仍为 0.5.4 开发候选；本轮实施启动、设置页、场景派生、覆盖率和源码归档改进，不把程序回归等同于全部真实产品验收。

## 改动

### 启动与皮肤加载

- 自定义皮肤扫描由 onload 的串行等待移到 layout-ready 后的可取消 idle 任务，内置皮肤即用。
- `SkinLoader` 扫描共享一次进行中的读取，模板创建串行去重；创建和重扫的代际避免旧结果覆盖新皮肤。
- 皮肤扫描失败保留已有注册表；卸载后的延迟结果不再修改 CSS、注册表或设置页。
- 内存诊断仅保存固定阶段、状态和毫秒耗时，最多 32 条，不保存路径、配置、凭据或错误正文。在已加载的测试库可读取：

  ```js
  app.plugins.plugins["annotation-tutor-lite"].startupDiagnostics()
  ```

- 凭据迁移、绘图事务和学习/结果恢复仍保留必要就绪屏障。恢复等待期间卸载会取消后续注册；已开始的持久化先完成再清理，支持会话晚恢复不会重建计时器，layout 初始化取消后不再触发模型热身/预翻译或发布旧索引。没有真实 Obsidian 冷启动耗时测量，因此不宣称某个启动降幅。

### 设置页

- 图像连接、MCP 状态与官方 Clipper 条件区的 **9 处**全页 display 改为局部刷新。
- 后台模型/皮肤/索引刷新保留未提交输入、原凭据绑定、焦点、选区与滚动；DOM 移位引起的 blur 不会保存草稿，异常也会解除临时保护。
- 无设置行的搜索控件保留新表的事件处理器，避免刷新后仍操作旧 AnnotationTable；过期 proposal 差异结果不能写入已经切换的设置页。
- 语言切换完整重译。后台刷新仍重建当前页的非编辑区域，其余完整刷新入口没有一概替换。

### 记忆单元到场景

- 场景与索引共享原始文件快照、脏文件代际及刷新队列；Vault 事件立即失效缓存，与自动刷新开关分离。
- 1,000 个 cells / 500 个 scenes 的无变化同步是 **0 read / 0 process / 0 write**。新增一个已有概念的 cell 后，同步加索引刷新只需 **2 次 vault.read + 1 次 vault.process**，更新一个 scene。
- 同 ID 手写场景、损坏的场景和暂时不完整的 cell 保留；变更代际、失败重试、目录重命名及根切换有回归覆盖。
- 交叉复核发现旧 Unicode slug 与 ASCII scene schema 冲突，中文概念会写出不可解析的文件。本轮保留中文/日文标题，Unicode 和过长概念采用规范化概念键的稳定哈希 ID；短 ASCII 标题的既有 slug 不变，手工与自动场景采用同一规则。旧无效资料仍由损坏文件保护保留，不自动改名或覆盖。
- 手动“重建索引”先完整修复场景，再重建索引；自动/内部刷新继续增量。
- 解析和概念分组仍遍历内存资料，不能宣称完整流程为 O(delta)。scene 更新原子检查 auto 标签；删除只能先读取并核对归属再调用 vault.delete，宿主没有 conditional delete，任意外部并发删除的原子性未被宣称。

### 覆盖率与 CI

使用与 Vitest **4.1.8** 完全匹配的 `@vitest/coverage-v8`，采集 src 与 extension/src 的全量覆盖率，输出 HTML、LCOV 和 JSON summary。配置依据：[Vitest v4 覆盖率选项](https://v4.vitest.dev/config/coverage)。

初次实测（212 文件 / 3003 用例通过）为：statements 61.86%、functions 60.50%、branches 60.14%、lines 65.62%。门槛取实测整数下限，分别为 61/60/60/65，另为网页桥接、凭据、绘图事务、任务与文档修改设置更高的逐文件门槛；不自动降低阈值。

Linux CI 用 `pnpm test:coverage` 替代重复的普通测试，Windows/macOS 保留普通测试；Linux 上传覆盖率产物，所有平台继续发布事务、package 和封包验证。运行路径/手动抽取宿主的方法不全部计入 V8 源码覆盖率，覆盖率不能取代真实 shell、canvas、设备与模型交互验收。

### 扩展解析与发行许可证

- 干净安装核验发现扩展的 Readability 0.5.0 受 CVE-2025-2792 影响，特制网页标题可能导致正则表达式过度回溯。采用官方修复版本 **0.6.0**，其余注册表依赖没有扩展升级范围。依据：[Mozilla Readability 安全公告](https://github.com/mozilla/readability/security/advisories/GHSA-3p6v-hrg8-8qj7)。
- 新增实际 offscreen 入口的文章、相对 URL、GFM 表格、长标题与空解析回退测试；新的扩展 lock 干净安装报告 **0 个已知漏洞**。
- 原发行包许可证清单遗漏已打包的扩展解析依赖。本轮从扩展构建 metafile 收集实际依赖，扩展自带独立许可证清单，整体发行包也合并 Readability、Turndown 和 GFM 插件的通知文件。
- 封包校验检查扩展依赖版本、合并清单及许可证文件；新增 3 项缺失/不完整许可证的发布回归，发布测试共 **33 项**。

## 源码归档范围

采用明确文件清单归档当前产品源码、测试、构建/恢复工具、离线字体及许可证、浏览器扩展、宿主插件和 Android 源码。保留所有既有工作区内容，不用 git add -A 批量纳入资料。

本机审计、存储迁移/恢复报告、研究生成媒体、dist 产物及历史 QA 候选快照不进入源码基线。历史 QA 仍在原路径保留，需要作为另一批证据单独审查；当前文档引用可在本工作区复查，源码快照不等于这些私有历史资料已适合公开。

归档前检查明确范围的源码凭据模式、完整文件依赖，并从干净导出的源码树复跑检查。这个模式检查不是全库秘密审计证明，也不证明历史配置备份没有明文。

独立复核确认源码、测试、脚本和构建资产没有遗漏；660 个文本文件的常见凭据模式检查未命中。`research:check` 依赖有意排除的 latest/live 历史研究运行记录，不属于本轮独立源码构建与 CI 的可复跑检查。

## 最终验证

最终工作区与独立导出的源码目录均通过以下检查：

| 检查 | 结果 |
| --- | --- |
| 插件、扩展类型检查及构建脚本语法 | 通过；71 个 JavaScript 脚本 |
| Vitest 全量回归 | **222 文件 / 3083 用例通过**；比首批增加 80 例 |
| V8 覆盖率 | statements **63.39%**、functions **62.58%**、lines **67.71%**；branches 工作区 **60.85%**、独立目录 **60.84%**，所有全局与关键文件门槛通过 |
| 发布事务、恢复、封包负向回归 | **33/33 通过** |
| 独立源码冻结安装 | 根 pnpm lock 从已有缓存独立安装，扩展 npm lock 干净安装；没有复用原工作区 node_modules 或私有 QA |
| 独立源码完整 package / package:verify | 通过；**279 文件 / 27 项打包依赖 / 3 项扩展依赖**，ZIP 与封存目录字节相同 |

独立源码验证目录为 `/private/tmp/tutor-optimization-source-UTiWqW`，构建 ID 为 `optimization-stage2-sourcecheck`。该次 ZIP 大小 **15,151,713 字节**，SHA-256 为 `88d7a5b21b72aafc4d3ce7720755b11e2d50867030b6f8d594e8896651db86d6`。最终工作区发行包随本地源码提交重新构建，其字节记录以 `dist/package-verification.json` 为准，不将不同 build ID 的 ZIP 混作同一产物。

源码基线采用本地分支 `codex/optimization-20261014`，归档清单包含 **902 个现存文件与 2 个旧图标删除**，保留既有开发成果与本轮升级。发布包和本机审计不进入 Git；历史 QA 快照留在原工作区。本轮没有推送、发布或安装到真实 Vault，三平台 CI 配置尚待远端实际运行。Android 与宿主插件的源码纳入基线，不宣称本轮额外完成其设备验收。

可复跑：

```bash
pnpm install --frozen-lockfile
npm --prefix extension ci
pnpm typecheck
pnpm test:coverage
pnpm test:release
pnpm package
pnpm package:verify
```
