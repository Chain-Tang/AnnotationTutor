# 精准共画与多 Agent 升级执行方案

2026-09-20。以用户确认的 M0 → M6 为范围。几何保持 v5，原墨、资产和角色版本不批量转换。每个阶段的发布状态以 [验证记录](tutor-upgrade-status.md) 为准，已有代码不等于验收通过。

## 依赖与交付顺序

| 阶段 | 实现入口 | 必须通过的交付条件 |
|---|---|---|
| M0 | `tutor-task`、`tutor-conversation`、Studio 候选工作流 | 稳定目标、实际模型、阶段/失败可见；候选插入指定层、保存与重开 |
| M1 | `excalidraw-surface`、`excalidraw-agent` | 公开 API；类型化操作；ID/样式/连接保留；版本冲突、单次原生撤销、保存重开 |
| M2 | `tutor-mcp`、`board-mcp`、`tutor-codex`、`host-plugins/tutor` | 正式 SDK、配对与撤销、客户端隔离、取消、Codex↔Tutor 实际模型流程 |
| M3 | `board-live-paint`、`board-layer-renderer`、`ink-transcript` | 活动笔触缓存、图层隔离、透明锁定/选区/擦除；原墨保留、校正转写与定位 |
| M4 | `board-vector-edit`、`board-vector-inspector`、`board-character-parts` | 锁定保护、不可变资产版本、只改选中部件、整组撤销、角色保存再插入 |
| M5 | `platform-entry`、`mobile/`、`android-companion/` | 移动分支不执行桌面依赖；中英本机/文件识别；指纹拦截旧结果；Android 真机门槛 |
| M6 | `tutor-a2a`、`tutor-a2a-client`、`tutor-collaboration` | A2A 1.0 正式 SDK；共享任务与事务；并发去重、取消/重连、HTTPS 来源限制、预算 |

## 确定性提交规则

1. 入口先解析语义，再选择工具。外部服务直接使用明确工具参数时不重复猜测目标。
2. 请求绑定画布 ID 与基准修订；运行中切换活动窗口不能改变提交目标。
3. 专家只返回草稿。Tutor 或外部主 Agent 决定采用后，通过同一个类型化 `ChangeSet` 提交。
4. 宿主给出作者身份，对同一画布串行校验与提交。选中人类对象需在已有授权范围内；锁定层和部件不允许修改。
5. 取消、服务失败和版本冲突保留已有作品。重复提交使用同一变更 ID；不因结果不确定再次生图。
6. 一个任务最多三个参与者、两个并行专家、两级委派、12 次模型调用、100 次工具调用及五分钟总时限。现有绘图修正仍限制一次；重试内部调用的精确计量需补齐发布门。

## 验收矩阵与发布节奏

- 每阶段先跑对应单元测试，再在真实 Obsidian 测试库操作。最终统一运行 `pnpm typecheck`、`pnpm test`、`pnpm build`、安装文件/ZIP/许可证/凭据检查。
- 性能分冷启动、缓存后、应用渲染与端到端笔尖延迟，不能相互替代。桌面 p95 16.7ms、Android 33ms；固定对象/部件全部通过，自然语言局部修改至少 95%。
- 既有数学关系与 60 个研究任务保留；追加局部修改、Excalidraw、双 Agent、移动用例。人物实验沿用协议≥95%、视觉任务≥80%达4/5、首笔p95≤5秒的独立发布门。
- 预览构建可以交付已通过的桌面范围。Android 真机、远程 HTTPS、自然语言大样本与复杂人物门未过时，保持未通过标记；不能称为 M0—M6 全部完成。
- 发布包必须附范围、模型、设备、失败原因、校验哈希、迁移和回滚说明。不可回溯伪造未保存的逐阶段快照。

## 真实环境脚本

`verify-upgrade-m0.mjs` / `verify-studio-sidebar.mjs` → `verify-upgrade-m1.mjs` / `verify-upgrade-m1-model.mjs` → `verify-tutor-mcp-host.mjs --codex-plugin` / `verify-tutor-codex.mjs` → `verify-upgrade-m3.mjs` → `verify-upgrade-m4.mjs`。

脚本位于 `scripts/`，只应在明确的合成 QA 资料上执行；不要对学生真实画作重置场景。Android 与远端服务必须使用实际设备/端点补验，fixture 测试单独标注。

打包执行 `node scripts/package-upgrade.mjs`，安装后执行 `node scripts/check-upgrade-package.mjs /absolute/vault`。Android ZIP 只含源码，不含 APK。最终范围与未通过门见验证记录，不将预览构建宣称为全部里程碑正式发布。
