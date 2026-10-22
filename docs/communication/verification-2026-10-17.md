# 多库通信升级验证记录

日期：2026-10-17（Asia/Shanghai）。版本：Obsidian Tutor 0.6.0、Codex host plugin 0.5.0。

## 已完成的代码与打包验证

- `pnpm typecheck`：通过，包括插件、production、浏览器扩展、脚本语法与四种语言键检查。
- `pnpm test`：248 个文件、3,397 项测试通过。包括通信核心、Markdown 版本冲突、发送身份、撤权、取消、持久回执、库间固定路由、凭据加密、独立 Tutor 会话与宿主生命周期。
- `pnpm package`、`pnpm package:verify`：通过；281 个密封文件，ZIP 与分发目录一致。
- `annotation-tutor-lite-0.6.0.zip` SHA-256：`fe09639140f90f176dc555fc597574b46b65dffdda74a4ffd3a9f4ab1d05bf24`。

完整回归曾暴露三个提取式宿主测试夹具缺少新通信停止方法，现已补齐，并加强“通信停止未完成时立即暂停输入、等待索引后再切换目录”的断言；生产代码原有同步暂停顺序保持。

## 真实持久 Codex 会话

通过现有 Codex 登录启动两个独立 App Server 进程，只使用本次明确建立的专用线程，未列举或读取其他聊天。

| 验证 | 结果 |
| --- | --- |
| 新建线程、保存绑定、关闭进程 | 通过 |
| 首轮提供公开定义与测试口令 | 回答区分“数值同一性”与“性质相似性”，并确认“河流-17” |
| 关闭首轮进程，重新恢复同一线程 | 通过 |
| 次轮只问前一轮口令 | 准确返回“河流-17” |
| 总耗时 | 36.686 秒 |

线程：`01a1458d-7b03-7931-bfe3-f1b57c523eff`。两轮：`01a1458d-911f-7313-b7cc-138db970184f`、`01a1458d-d7e6-7ca1-9669-eff399cb724f`。原始临时 QA 文件已清理；本页保留该次实测摘要。真实库内公开消息与收据另存于 [live-verification-2026-10-17.json](live-verification-2026-10-17.json)。

实测发现 `thread/start` 返回后尚无可恢复历史时，直接终止进程会留下空线程。实现现通过官方 `thread/inject_items` 写入仅包含空间 ID 和授权边界的公开初始化材料，再持久保存绑定；此步骤不调用模型。新增测试验证物化失败不会保存成功绑定。

## Codex 插件安装

原个人源入口 `/Users/mac/plugins/tutor` 是指向 `/Users/mac/.agents/plugins/plugins/tutor` 的符号链接。保留入口，将作者源从0.3.0更新至0.5.0；23个文件哈希全部与仓库构建包一致。完整旧源已备份至本机临时 QA 目录。

随后使用官方 `codex plugin add tutor@personal --json` 成功刷新安装副本，返回版本0.5.0、路径 `/Users/mac/.codex/plugins/cache/personal/tutor/0.5.0`。没有直接改写托管缓存，也没有重启桌面或读取配对凭据。当前已运行聊天的工具目录仍需在宿主刷新后核验，不能仅凭源文件更新假定热加载成功。

## 两个 Obsidian 库

升级前两库均为0.5.4、Tutor已启用、无活动对话，Board MCP关闭。目标仅为用户指定的“所作”和“psychological plugin”。安装使用项目已有事务安装器，自动备份并验证启动健康，保留库内资料与设置。

两库均已通过事务安装与Obsidian加载健康检查。首次安装备份分别为 `1792168372444-352bbf1f-3ddf-4a99-8e3d-2f8f0b1248f0` 与 `1792168492203-fcfb1a37-4444-403e-97ea-4e647456a94e`，位于 `~/Library/Application Support/Tutor/backups/installations/`。

“所作”创建了明确标记的公开验证空间 `communication-qa-20261017`，并建立真实专用线程 `01a14594-f8db-7950-bc8b-b49983cfa2d0`：

- 第一条Tutor主动请求完成，Codex按上下文v1区分两种同一性并记下“溪流-26”。
- 通过Obsidian修改该空间 `context.md` 的阶段摘要，加入明确标记的公开校验词“桥梁-42”；`syncContext`登记为v2。
- 第二条请求完成，恢复同一Codex会话并读入v2，准确回答“溪流-26；桥梁-42。”；两条原请求的收据为completed，回复各自保留v1/v2。
- `conversation.md`已生成请求、回复与投递状态。这些测试材料没有写入学习者掌握程度或其他笔记。

跨库实测发现renderer的默认 `fetch` 产生浏览器Origin/CORS语义。Peer现改用固定127.0.0.1的Node HTTP传输，保留服务端对浏览器Origin的拒绝、体积限制与取消。新增真实HTTP回归将全局fetch设置为抛错、服务端拒绝Origin，配对与后续MCP仍成功，且全局fetch调用数为0。

最终传输修复已安装到两库，二者均为构建 `1792168921961-dda93c03`，Obsidian加载健康检查通过；安装备份分别为 `1792168955212-5f5ec70b-98f4-4a95-a404-9eb28ea4cff7` 和 `1792169063951-718cc25f-707c-4faa-ade3-1cda5a31f452`。

已另建可继续使用的 `philosophy-process-relations`（哲学学习协作），背景仅使用本次用户明确提出的问题；专用线程 `01a1459b-7825-7123-94a9-5c787ab431b0`。记忆与对话位于 `Agent Memory/communication/philosophy-process-relations/`。“所作”的课程协作说明已更新，完整旧稿保留在项目基线中。

用户已解锁并明确批准仅协作消息配对、加入公开验证和哲学学习两个空间。配对已建立并核验：`communication:true`，文档读取/写入、学习记忆与学习证据权限均关闭，文档数为0。第二库能看到两个获准空间，且其主动发给中心专用Codex的请求实际completed，答复为“溪流-26；桥梁-42。”。

两条Tutor互发请求已实际到达并进入处理，但原有OpenCode模型未返回回复。2026年10月17日的宿主独立公开自检确认固定诊断为 `provider-access-403`；没有输出服务商错误原文或读取凭据。失败请求保留，未自动重试。

用户随后明确选择让**协作中的Tutor单独使用现有Codex登录**。新增独立运行器按本Tutor身份、中心与空间保存持久线程，和协调Codex线程分开；日常聊天及绘图模型不变。另修正OpenCode教学适配器误用绘图角色的问题，并增加固定白名单失败分类，禁止错误原文进入公共收据。

独立Tutor运行器已单独真实验证：首轮回答“4”并记住“独立-17”，关闭运行、移除随机工作目录后，使用新运行器恢复同一线程，准确返回“独立-17”；耗时31.240秒。结果保存在 [independent-tutor-verification-2026-10-17.json](independent-tutor-verification-2026-10-17.json)。

## 最终两库验收

追加版本已安装到两库，构建均为 `1792211267340-21d6e03f`，启动健康检查通过。最终安装备份为 `1792211304626-996f014f-6348-4600-a201-1ba124dbb09d`（所作）和 `1792211374552-205a978b-6d73-401c-b51b-6d73733d67b5`（psychological plugin）。两库的协作引擎均已设为Codex，日常聊天仍为原来的OpenCode与原模型。

| 实际请求方向 | 结果 |
| --- | --- |
| psychological plugin Tutor → 所作 Tutor | 回复“4”，请求completed |
| 所作 Tutor → psychological plugin Tutor | 回复“6”，请求completed |
| psychological plugin Tutor → 原协调Codex | 回复“溪流-26；桥梁-42。”，请求completed |
| 重建两库通信服务后 → 所作 Tutor | 回复“青竹-42”，请求completed，沿用原线程 |
| 重建两库通信服务后 → psychological plugin Tutor | 回复“桃花-61”，请求completed，沿用原线程 |

所作Tutor线程为 `01a14820-df5e-7db3-a703-ee0c706bc8b7`，第二库Tutor线程为 `01a14820-ca20-7873-ac44-e43dc9804d15`，均与原协调Codex线程不同；重建服务前后ID一致。恢复后仅消息配对和两个获准空间自动可用。旧403失败请求仍原样保留，验收使用明确的新消息ID，没有自动重试历史模型调用。

最终公开收据、回复、权限与线程对比见 [live-verification-2026-10-17.json](live-verification-2026-10-17.json)。正式使用空间是“哲学学习协作”；公开验证空间及测试代号不属于学习者事实。程序未增加全库读取或自动反思功能。
