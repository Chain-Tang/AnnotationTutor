# Tutor × Codex 通信、会话、记忆与多库边界审计

核查日期：2026-10-16（Asia/Shanghai）。状态：**当前工作树的只读技术审计 + 官方资料核对；不是部署验收。**

范围：`/Users/mac/Tutor` 的 A2A 服务/客户端、MCP、会话、任务协调、任务日志、专家结果存储、host 插件及直接依赖。未修改代码，未安装插件，未连接或配对真实 Tutor，未读取真实 Vault、配置或凭据。仓库 HEAD 为 `ba52e369e7c15be939de599859273a313f28d691`，但工作树含既有和并行产生的未提交修改；行号对应本次读到的工作区内容，不能视为该 commit 的不可变源码引用。

## 1. 主结论

当前代码足以让 Codex **发现并选中一个本地 Vault 的 Tutor、在 Obsidian 配对后读取指定资料、发起独立教学/评审任务、查询并收回结果**。也有反向 Tutor → 临时 Codex 专家的委派，以及 A2A 1.0 的入站/出站适配器。

它尚不能被描述为“所有 Vault 的 Tutor 和 Codex 已共享长期记忆、共同理解和连续目标”。实际共享的是本次显式传入的文本、获授权的资料片段及有限学习证据。协议 ID、硬盘文件、下一次模型输入、学习者实际理解，是四个不同层面。

可以立即开始的方案是：由主对话维护一份有版本、有来源、有共享范围的背景/目标说明，每轮明确传入，再收回结果、分歧与未知。结构化契约见 [[协作契约草案]]，其中新增字段和自动化保证均标为拟议。

## 2. 版本不能混称

| 对象 | 本次核查值 | 证据及含义 |
| --- | --- | --- |
| A2A 官方发布规范 | `1.0.0`，通信版本为 major.minor `1.0` | [官方 latest 指向 1.0.0](https://a2a-protocol.org/latest/specification/)，[固定版规范](https://a2a-protocol.org/v1.0.0/specification/) §§3.6、8.3；不能用软件版本替代协议版本 |
| 当前 A2A SDK 包 | `@a2a-js/sdk 1.2.0` | [package.json:53](/Users/mac/Tutor/package.json:53) |
| Tutor Agent Card 自报软件版本 | `0.3.0`；接口 `JSONRPC` / `protocolVersion:1.0` | [tutor-a2a.ts:8](/Users/mac/Tutor/src/tutor-a2a.ts:8)，这个 `version` 是 agent 软件版本，不是仍使用 A2A 0.3 |
| 当前仓库包 | `0.5.4` | [package.json:3](/Users/mac/Tutor/package.json:3)，不证明用户已安装此版本 |
| 仓库 host 插件包 | `0.4.4` | [plugin.json:4](/Users/mac/Tutor/host-plugins/tutor/plugin.json:4)，不等于本会话已加载插件版本 |
| 当前 MCP SDK 包 | `@modelcontextprotocol/sdk 1.30.0` | [package.json:54](/Users/mac/Tutor/package.json:54) |
| 当前 SDK / connector 最高已知 MCP 版本常量 | `2025-11-25` | [types.js:2](/Users/mac/Tutor/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js:2)、[connector.cjs:12770](/Users/mac/Tutor/host-plugins/tutor/scripts/connector.cjs:12770)；本次未握手，实际协商值未核验 |
| MCP 官方 latest | `2026-07-28` | [官方当前规范](https://modelcontextprotocol.io/specification/2026-07-28)；不得把新规范能力视为当前 SDK 已升级 |

本次打开官方页面后确认：新 MCP 规范已转向自包含请求的核心；与当前实现相应的 [2025-11-25 架构](https://modelcontextprotocol.io/specification/2025-11-25/architecture) 仍描述初始化协商与会话。报告不能把两个版本的语义混成“当前实现”。当前代码也未证明实现了新版 MCP Tasks 扩展；`tutor_start_task` 是 Tutor 自己的应用工具名。

## 3. A2A、MCP 与共享记忆的分工

**A2A 协议本身。** A2A 支持代理间消息、任务、状态及产物；内容可以是文本、文件或结构化数据，metadata 可带额外上下文。`contextId` 关联相关交互，`taskId` 标识一项工作；服务端可以利用上下文 ID 维护历史，但并非必须拥有相同内部记忆。`SendMessage` 幂等也不是协议一律保证。依据：[A2A 1.0.0](https://a2a-protocol.org/v1.0.0/specification/) §§3.3、3.4、4.1。

**MCP 协议本身。** MCP 暴露工具、资源等能力，由 host 决定聚合哪些上下文并控制跨服务器边界；连接服务器不等于服务器能看到整个聊天或其他服务器。依据：[MCP 当前架构](https://modelcontextprotocol.io/specification/2026-07-28/architecture)。MCP 的传输授权和应用内部文档授权也是不同层次；当前 Tutor 用本机自定义 Bearer 配对，不是完整 OAuth 授权服务器。依据：[MCP 授权规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) 与下文实现。

**应用契约。** 背景、目标、版本、共享许可、学习证据、分歧、写回和撤销的具体含义必须由应用约定及实现。把这些内容写成 JSON 可以传输，不能因此自动获得校验、长期保存、上下文注入或删除回执。A2A 与 MCP 可以组合，不需要为了编课程先开发一套跨库代理网络。参见 [官方分工说明](https://a2a-protocol.org/latest/topics/a2a-and-mcp/)。

## 4. 当前实现的三条路径

| 路径 | 实际行为 | 限制 |
| --- | --- | --- |
| Codex → host connector → 某 Vault Tutor MCP | stdio connector 发现实例并转发至该库的 loopback `/mcp`；先配对，再调用受限工具 | 一个 connector 进程只有一个 selected/remote，不是自动多库聚合 |
| Obsidian Tutor → Codex App Server 专家 | 临时目录、独立 ephemeral thread、一次授权上下文和任务，回交文本产物，由 Tutor 汇总 | 不进入当前 Codex 桌面聊天，不继承其历史，也不自动写记忆 |
| A2A 入站 / 出站 | 入站以同一任务与事务核心提供 JSON-RPC；出站连接明确配置的远端 HTTPS agent | 不是已配置的 Tutor 网络；本机 Tutor 的 HTTP 地址被生产出站构造器拒绝，测试才可放行 |

证据：[connector-source.mjs:10](/Users/mac/Tutor/host-plugins/tutor/scripts/connector-source.mjs:10)、[:27](/Users/mac/Tutor/host-plugins/tutor/scripts/connector-source.mjs:27)、[:54](/Users/mac/Tutor/host-plugins/tutor/scripts/connector-source.mjs:54)；[tutor-codex.ts:29](/Users/mac/Tutor/src/tutor-codex.ts:29)、[:56](/Users/mac/Tutor/src/tutor-codex.ts:56)、[:69](/Users/mac/Tutor/src/tutor-codex.ts:69)；[tutor-a2a.ts:10](/Users/mac/Tutor/src/tutor-a2a.ts:10)、[tutor-a2a-client.ts:10](/Users/mac/Tutor/src/tutor-a2a-client.ts:10)、[main.ts:1503](/Users/mac/Tutor/src/main.ts:1503)。

反向 Codex adapter 明确请求禁用 MCP servers、插件、web search、shell/apps/多代理等入口，拒绝额外操作审批；上下文截至 32000 字符、任务截至 16000。运行时返回 artifact 包含 threadId/turnId，但没有用它们去 resume 既有聊天的调用链；专家结果落盘 schema 也不保留这两个 ID。见 [tutor-codex.ts:41](/Users/mac/Tutor/src/tutor-codex.ts:41)、[:55](/Users/mac/Tutor/src/tutor-codex.ts:55)、[:69](/Users/mac/Tutor/src/tutor-codex.ts:69)、[:73](/Users/mac/Tutor/src/tutor-codex.ts:73)、[tutor-result-store.ts:13](/Users/mac/Tutor/src/tutor-result-store.ts:13)。官方 App Server 确有独立的 start/resume/fork 机制，不能因 API 支持 resume 就说本 adapter 已使用：[OpenAI App Server](https://learn.chatgpt.com/docs/app-server)。

## 5. A2A 当前覆盖与上下文限制

### 5.1 入站服务

- Card 宣告流式支持、无推送；入站只收 `ROLE_USER` 的 text parts。绘图变更通过特定 metadata 路径提交；不是完整接收所有 A2A parts。见 [tutor-a2a.ts:8](/Users/mac/Tutor/src/tutor-a2a.ts:8)、[:20](/Users/mac/Tutor/src/tutor-a2a.ts:20)。
- 新消息转到 `tutor_start_task`；带 taskId 的消息转到 `tutor_supply_input`，commit 是另一分支。读取/取消/订阅都按配对 clientId 查任务，A2A 没有绕过 MCP 授权另建写入口。见 [:17](/Users/mac/Tutor/src/tutor-a2a.ts:17)、[:27](/Users/mac/Tutor/src/tutor-a2a.ts:27)、[:56](/Users/mac/Tutor/src/tutor-a2a.ts:56)。
- **`contextId` 当前等于 `task.id`，history 永远返回 `[]`。** 如果 taskId 与 contextId 同时给出但不同，服务拒绝；如果只给 contextId，代码并不按其查找或继承会话，而走新任务分支并返回新的 task-based contextId。见 [:9](/Users/mac/Tutor/src/tutor-a2a.ts:9)、[:25](/Users/mac/Tutor/src/tutor-a2a.ts:25)、[:31](/Users/mac/Tutor/src/tutor-a2a.ts:31)。
- 这不能满足“用同一 contextId 在多个任务之间自动延续背景”的期望。官方允许服务端不接受客户端 contextId，但要求无法接受时拒绝，而不是静默换一个；该仅 contextId 分支属于需要处理或明确约束的规范差距。这里是源码逻辑对照，不是已做完整 A2A 一致性认证。[A2A §3.4.1](https://a2a-protocol.org/v1.0.0/specification/#341-context-identifier-semantics)
- 当前自定义 metadata 只被消费为 action/changes/targetId/source；任意 background/goals 等 metadata 不会自动注入本次推理。`referenceTaskIds` 也没有被此服务用来读取历史。需要先作为 prompt 内的文字或授权文档传入。见 [:26](/Users/mac/Tutor/src/tutor-a2a.ts:26)、[:32](/Users/mac/Tutor/src/tutor-a2a.ts:32)。
- messageId 按 clientId 去重，复用不同内容会拒绝；pending 最多 100、已收消息映射最多 200，存在内存里。不能据此许诺跨重启永久去重。见 [:12](/Users/mac/Tutor/src/tutor-a2a.ts:12)、[:23](/Users/mac/Tutor/src/tutor-a2a.ts:23)、[:33](/Users/mac/Tutor/src/tutor-a2a.ts:33)、[:35](/Users/mac/Tutor/src/tutor-a2a.ts:35)。

`tutor_supply_input` 仅接受仍为 `input-required` 且保留原 inputs 的任务。完成的普通教学回答不能靠 taskId 继续；进一步询问宜开新任务并带上摘要。多次 refine 时当前代码也是原始 prompt 加本次追加文字，不是累计所有 refine 的完整对话。见 [tutor-mcp.ts:198](/Users/mac/Tutor/src/tutor-mcp.ts:198)、[:199](/Users/mac/Tutor/src/tutor-mcp.ts:199)、[:210](/Users/mac/Tutor/src/tutor-mcp.ts:210)。

### 5.2 出站 adapter

出站只连明确配置的 HTTPS origin，拒绝重定向、跨 origin 和含用户名/密码/query/hash 的 endpoint；仅接受同源 `JSONRPC 1.0` 接口。它将 authorized context 截 16000、prompt 截 16000，作为文本发出；记录 local/remote task ID 映射后轮询已知任务。见 [tutor-a2a-client.ts:8](/Users/mac/Tutor/src/tutor-a2a-client.ts:8)、[:15](/Users/mac/Tutor/src/tutor-a2a-client.ts:15)、[:24](/Users/mac/Tutor/src/tutor-a2a-client.ts:24)、[:39](/Users/mac/Tutor/src/tutor-a2a-client.ts:39)、[:42](/Users/mac/Tutor/src/tutor-a2a-client.ts:42)。

它不传课程级 contextId，也没有接续普通远端多轮对话的逻辑。远端 input-required 变为本地错误；单次等待上限约 180 秒。远端文件产物不自动下载，text/data 产物有数量和体积限制。映射存在后能查询原任务，不能由此推出“服务重启会自动恢复所有协作任务、未记录 remote ID 的不确定发送也能完全恢复”。见 [:31](/Users/mac/Tutor/src/tutor-a2a-client.ts:31)、[:40](/Users/mac/Tutor/src/tutor-a2a-client.ts:40)、[:47](/Users/mac/Tutor/src/tutor-a2a-client.ts:47)、[:52](/Users/mac/Tutor/src/tutor-a2a-client.ts:52)、[:56](/Users/mac/Tutor/src/tutor-a2a-client.ts:56)。

## 6. 多 Vault、权限与身份

### 6.1 发现与路由

`instanceId` 是 Vault 绝对 basePath 字符串的 SHA-256 前 24 位；发现文件包含 version/id/name/port/pid/startedAt，不包含记忆或 token。它依赖路径，不是跨机器/搬迁稳定的 Vault UUID；两个相同名字的库不能靠 name 区分。见 [tutor-discovery.ts:6](/Users/mac/Tutor/src/tutor-discovery.ts:6)、[main.ts:1631](/Users/mac/Tutor/src/main.ts:1631)。

connector 验证发现文件的 ID/端口/PID 并检查进程存在；无选择且仅有一个实例时可自动选中，多实例要求显式选择。它以 `TUTOR_INSTANCE_ID` 初始化，也可由 `tutor_connect(instanceId)` 改当前选择。其余代理工具参数不含实例 ID，全部送给当前 `selected`。见 [connector-source.mjs:11](/Users/mac/Tutor/host-plugins/tutor/scripts/connector-source.mjs:11)、[:13](/Users/mac/Tutor/host-plugins/tutor/scripts/connector-source.mjs:13)、[:20](/Users/mac/Tutor/host-plugins/tutor/scripts/connector-source.mjs:20)、[:44](/Users/mac/Tutor/host-plugins/tutor/scripts/connector-source.mjs:44)、[:54](/Users/mac/Tutor/host-plugins/tutor/scripts/connector-source.mjs:54)。

因此“多库”当前是**发现并逐库选中操作**，没有自动把多库内容拼给一个模型。可以设想多个独立 connector 各固定一个 `TUTOR_INSTANCE_ID`，这是已有初始化入口可支持的配置路径；本分支没有配置或运行验收。共用单 connector 时应避免并行切库。

### 6.2 权限具有代码检查

- 本地服务只绑定 `127.0.0.1` 随机端口，拒绝浏览器 Origin 与非精确 loopback Host；公开 Card GET 不授权读资料。见 [board-mcp.ts:70](/Users/mac/Tutor/src/board-mcp.ts:70)、[:150](/Users/mac/Tutor/src/board-mcp.ts:150)、[:153](/Users/mac/Tutor/src/board-mcp.ts:153)。
- 配对弹窗勾选来源文档并切换 write、learningMemory、learningEvidence；targets 从被选文档对应的场景派生，humanObjectIds 取配对时已有的画布选区。需要改对象时应先选对象，再打开配对授权。默认不勾选文档，write/memory/evidence 均 false；正常生成 read:true grant。文档、场景和任务查询有独立的范围与所有权校验。见 [tutor-pairing-modal.ts:13](/Users/mac/Tutor/src/tutor-pairing-modal.ts:13)、[:21](/Users/mac/Tutor/src/tutor-pairing-modal.ts:21)、[tutor-mcp.ts:33](/Users/mac/Tutor/src/tutor-mcp.ts:33)、[:57](/Users/mac/Tutor/src/tutor-mcp.ts:57)、[:135](/Users/mac/Tutor/src/tutor-mcp.ts:135)、[tutor-task.ts:175](/Users/mac/Tutor/src/tutor-task.ts:175)。
- token 为随机 32 字节，服务仅保留 SHA-256 hash；connector 按实例保存私有凭据。不要把凭据文件带入共享记忆或教学文档。见 [tutor-access.ts:5](/Users/mac/Tutor/src/tutor-access.ts:5)、[connector-source.mjs:49](/Users/mac/Tutor/host-plugins/tutor/scripts/connector-source.mjs:49)。
- 撤销会移除配对、取消该 client 的任务并让旧 grant closure 拒绝调用；全局 read-only 只关闭 write，不关闭读取。重新 repair 配对也不自动撤销所有旧 grant。见 [main.ts:1594](/Users/mac/Tutor/src/main.ts:1594)、[:1626](/Users/mac/Tutor/src/main.ts:1626)、[tutor-mcp.ts:42](/Users/mac/Tutor/src/tutor-mcp.ts:42)、[:121](/Users/mac/Tutor/src/tutor-mcp.ts:121)、[connector-source.mjs:45](/Users/mac/Tutor/host-plugins/tutor/scripts/connector-source.mjs:45)。

`clientId` 是配对调用方身份，不是请求自己指定的用户/聊天身份；grant 中没有全局 vaultId/agentId/sessionId。`tutor_status` 也不返回 instanceId，因此主对话应另记所选实例与 source。见 [tutor-grant.ts:5](/Users/mac/Tutor/src/tutor-grant.ts:5)、[tutor-mcp.ts:133](/Users/mac/Tutor/src/tutor-mcp.ts:133)。

## 7. `read_memory` 的准确答案

在审查的 `src` 与 host 插件中**没有名为 `read_memory` / `readMemory` 的通用工具实现**。相近的功能如下：

| 工具 | 当前真实数据范围 | 不能解释成什么 |
| --- | --- | --- |
| `tutor_get_context` | 授权 Markdown 文档的指定文字切片，单次最高 16000 字符，返回 revision | 仅给 source 就自动加载整篇长文、全库或全部背景；需要时可按范围多次读 |
| `tutor_read_learning` | `learningMemory` 授权后，按 grant.documents 过滤 `librarySnapshot.annotations`；每页 30 项；每项 selectedText + reviewSummary + userNoteSummary，最高 8000 字符 | 全部 MemoryCell、profile、完整对话或其他 Vault 的长期记忆 |
| `tutor_get_learning_context` | 另需 read + learningEvidence + 授权来源；有限 episodes/证据投影、revision 与可选完整性问题 | 自动获取用户所有背景、稳定掌握程度或心理特征 |

证据：[tutor-mcp.ts:135](/Users/mac/Tutor/src/tutor-mcp.ts:135)、[:136](/Users/mac/Tutor/src/tutor-mcp.ts:136)、[:137](/Users/mac/Tutor/src/tutor-mcp.ts:137)、[main.ts:1623](/Users/mac/Tutor/src/main.ts:1623)、[learning-context.ts:12](/Users/mac/Tutor/src/learning-context.ts:12)、[:17](/Users/mac/Tutor/src/learning-context.ts:17)。

`tutor_read_learning` 返回只有 id/source/text，没有专门的 revision、completeness 或 nextOffset。空列表不能证明“从未学习”。学习证据投影最多 3 个较新 episode，每 episode 选有限证据，summary 最长 2000 字符，明确区分自评/帮助与掌握；该投影不读取 chat logs、support stores，也不纳入推断心理特征。这不保证摘要传给模型后不会被后端保存。见 [learning-context.ts:17](/Users/mac/Tutor/src/learning-context.ts:17)、[:22](/Users/mac/Tutor/src/learning-context.ts:22)、[:34](/Users/mac/Tutor/src/learning-context.ts:34)、[:45](/Users/mac/Tutor/src/learning-context.ts:45)。`tutor_get_context.start` 当前上限 100000，宿主文本上下文只接受 `.md`，见 [tutor-mcp.ts:26](/Users/mac/Tutor/src/tutor-mcp.ts:26)、[main.ts:1567](/Users/mac/Tutor/src/main.ts:1567)。

启动任务时：读取所选 source（或场景 source）的**开头**最多 16000 字符，若单独获准再追加 learning evidence summary；并没有调用 `host.memory` 把所有批注记忆自动带入。完成前复核 evidence revision，但这里并未冻结完整原文 revision。见 [tutor-mcp.ts:175](/Users/mac/Tutor/src/tutor-mcp.ts:175)、[:185](/Users/mac/Tutor/src/tutor-mcp.ts:185)、[:192](/Users/mac/Tutor/src/tutor-mcp.ts:192)。

外部独立任务不接管侧栏会话；Direct adapter 每次构造自己的 messages，ACP adapter 每次开新 session 且 `denyTools:true`。见 [tutor-service.ts:14](/Users/mac/Tutor/src/tutor-service.ts:14)、[tutor-agent-adapters.ts:7](/Users/mac/Tutor/src/tutor-agent-adapters.ts:7)、[:19](/Users/mac/Tutor/src/tutor-agent-adapters.ts:19)、[:37](/Users/mac/Tutor/src/tutor-agent-adapters.ts:37)。普通本地侧栏 ACP 的更宽文件/MCP 能力不能推广给配对外部客户端。

## 8. 会话 ID、聊天持久化与模型输入

| 对象 | 当前含义 | 证据 |
| --- | --- | --- |
| `conversationId` | UI 内存会话 UUID，reset/restore 会重新产生，非跨重启稳定会话 | [tutor-conversation.ts:143](/Users/mac/Tutor/src/tutor-conversation.ts:143)、[:147](/Users/mac/Tutor/src/tutor-conversation.ts:147)、[:488](/Users/mac/Tutor/src/tutor-conversation.ts:488) |
| `ChatLog.id` | 当前 Vault 的持久聊天日志 ID，与 conversationId 分离 | [main.ts:660](/Users/mac/Tutor/src/main.ts:660)、[model.ts:177](/Users/mac/Tutor/src/model.ts:177) |
| ACP `sessionId` | 后端新建的运行会话，prompt/cancel 使用；不是 A2A contextId | [acp-session.ts:211](/Users/mac/Tutor/src/acp-session.ts:211)、[:317](/Users/mac/Tutor/src/acp-session.ts:317) |
| `taskId` | 一次工作 UUID，带 client/agent/parent/target revision | [tutor-task.ts:8](/Users/mac/Tutor/src/tutor-task.ts:8)、[:61](/Users/mac/Tutor/src/tutor-task.ts:61) |

聊天日志默认启用，保存在本 Vault `<memoryRoot>/chats/<CHAT-id>.md`，默认保留 30 个 session。保存 role/text/time/taskId；不是完整 events/metadata/执行状态的归档。restore 把 turn 还原为 complete 消息，不能证明中断语义和后端会话一并恢复。见 [settings-config.ts:326](/Users/mac/Tutor/src/settings-config.ts:326)、[store.ts:616](/Users/mac/Tutor/src/store.ts:616)、[main.ts:667](/Users/mac/Tutor/src/main.ts:667)、[tutor-conversation.ts:494](/Users/mac/Tutor/src/tutor-conversation.ts:494)。

本地 UI 每轮向 runner 投影最近 40 条非 streaming **消息**，不是 40 轮问答。普通 ACP 复用活 session，并把未见历史按最后 20 条/16000 字符重放；独立外部任务另走前述新会话路径。见 [tutor-conversation.ts:240](/Users/mac/Tutor/src/tutor-conversation.ts:240)、[main.ts:2015](/Users/mac/Tutor/src/main.ts:2015)、[:2054](/Users/mac/Tutor/src/main.ts:2054)。

附带发现：`capChatLog()` 定义了 50 条/20000 字符裁剪，但在 `src` 未见调用；不能据常量声称磁盘和 restore 永远只载入这些量。见 [chat-log-file.ts:109](/Users/mac/Tutor/src/markdown/chat-log-file.ts:109)、[store.ts:632](/Users/mac/Tutor/src/store.ts:632)。聊天类型与 MemoryCell 明确分离，不能把原始聊天自动视为学习掌握证据。见 [model.ts:193](/Users/mac/Tutor/src/model.ts:193)。

官方 OpenAI 文档亦区分显式传历史、API conversation/response 延续与 App Server thread 的继续机制；它们不自动把外部 Tutor 的状态映射为当前 Codex 聊天记忆。参见 [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)、[App Server](https://learn.chatgpt.com/docs/app-server)。这里是边界说明，不是声称 Tutor 使用了所有这些 API。

## 9. 任务与产物究竟保存在哪里

| 存储层 | 已实现范围 | 不应许诺 |
| --- | --- | --- |
| Coordinator 内存 | 默认任务超时 300000 ms，最多 200 task；每 task 最近 128 events；client+key 去重；容量满会裁掉已终结根任务树 | 永久保留所有任务/历史；仅知道 ID 即可读别人的任务 |
| Metadata journal | `<memoryRoot>/tasks/task-index.json` 和 `remote-index.json`，各最多 200 条；记录状态、身份、metrics 与 remote 映射 | 完整 prompt、模型上下文或完整回答恢复 |
| 专家结果 store | `<memoryRoot>/learning/v2/expert-tasks/<rootTaskId>.json`；显式 Tutor 委派流程保存 root+children；只保留完成任务的 text artifacts | 所有外部 MCP/A2A 推理任务都有完整持久结果 |
| 图形事务 journal | 版本、changeset、提交/保存回执及特定恢复 | 通用 Markdown 记忆写回，或取消就回滚已落盘的修改 |

证据：[tutor-task.ts:35](/Users/mac/Tutor/src/tutor-task.ts:35)、[:113](/Users/mac/Tutor/src/tutor-task.ts:113)、[:179](/Users/mac/Tutor/src/tutor-task.ts:179)；[tutor-journal.ts:8](/Users/mac/Tutor/src/tutor-journal.ts:8)、[:16](/Users/mac/Tutor/src/tutor-journal.ts:16)、[:24](/Users/mac/Tutor/src/tutor-journal.ts:24)、[:26](/Users/mac/Tutor/src/tutor-journal.ts:26)；[main.ts:1394](/Users/mac/Tutor/src/main.ts:1394)、[:1400](/Users/mac/Tutor/src/main.ts:1400)、[:1509](/Users/mac/Tutor/src/main.ts:1509)；[tutor-mcp.ts:61](/Users/mac/Tutor/src/tutor-mcp.ts:61)。

专家结果每 task 最多 8 个文本产物、每段 text 最多 60000 字符；读文件上限 1000000 字节。保存前校验任务树/同客户端/同目标，拒绝较旧版本覆盖，支持 `.previous` 备份、compareWrite 和已有 `.deleted` 屏障。最多恢复最近 40 个有效 group，排除重复 task ID 的歧义；不是把其余文件自动删除。见 [tutor-result-store.ts:7](/Users/mac/Tutor/src/tutor-result-store.ts:7)、[:19](/Users/mac/Tutor/src/tutor-result-store.ts:19)、[:45](/Users/mac/Tutor/src/tutor-result-store.ts:45)、[:49](/Users/mac/Tutor/src/tutor-result-store.ts:49)、[:66](/Users/mac/Tutor/src/tutor-result-store.ts:66)。

恢复非终结任务通常标 interrupted/failed 并清产物，不重跑中断模型；已有图形 receipt 则按真实提交状态恢复。外部 `tutor_task_status` 找不到任务时，只有获授权图形事务元数据的特定恢复，没有从 metadata index 恢复所有推理回答的通用入口。见 [tutor-task.ts:72](/Users/mac/Tutor/src/tutor-task.ts:72)、[tutor-mcp.ts:217](/Users/mac/Tutor/src/tutor-mcp.ts:217)。

普通 task key 去重只核对 client+key，不核对 prompt 内容；A2A message 映射另检查签名但受内存保留限制。不要变更 prompt 却复用同一个 key，也不要把绘图事务幂等推广成通用记忆写回幂等。见 [tutor-task.ts:42](/Users/mac/Tutor/src/tutor-task.ts:42)、[tutor-a2a.ts:23](/Users/mac/Tutor/src/tutor-a2a.ts:23)、[tutor-mcp.ts:64](/Users/mac/Tutor/src/tutor-mcp.ts:64)。

## 10. 停止、撤销、删除与忘记

关闭侧栏只改变 UI 订阅；新聊天 reset 会清当前会话并更换 ID，但不自动删除旧 ChatLog。关闭 `persistChatLog` 停止后续保存/启动恢复，也不删除现有日志。见 [tutor-conversation.ts:123](/Users/mac/Tutor/src/tutor-conversation.ts:123)、[:488](/Users/mac/Tutor/src/tutor-conversation.ts:488)、[main.ts:660](/Users/mac/Tutor/src/main.ts:660)、[store.ts:638](/Users/mac/Tutor/src/store.ts:638)。

删除单个 ChatLog 当前只删文件并清 currentLog 指针，不同时清空可见 transcript 和活 ACP session；“删除历史条目”也不等于清除当前模型上下文。见 [chat-view.ts:500](/Users/mac/Tutor/src/views/chat-view.ts:500)。

撤销配对停止后续本地访问并取消任务；取消不能回滚已经提交的图形，receipt 仍权威，可能显示 committed-after-cancel。见 [main.ts:1594](/Users/mac/Tutor/src/main.ts:1594)、[tutor-task.ts:138](/Users/mac/Tutor/src/tutor-task.ts:138)、[:165](/Users/mac/Tutor/src/tutor-task.ts:165)。

本地 v3 episode 有专门 forget 路径、删除屏障与上下文失效处理，但它不是“所有聊天/专家产物/远端副本统一遗忘”。当前专家结果 store 会识别 `.deleted`，本次未发现专用专家结果删除 UI/API。上述函数也不调用所有远端提供方的历史删除 API；不能承诺接收方已经遗忘。见 [learning-commands-v3.ts:96](/Users/mac/Tutor/src/learning-commands-v3.ts:96)、[learning-v3.ts:196](/Users/mac/Tutor/src/learning-v3.ts:196)、[learning-record-read.ts:122](/Users/mac/Tutor/src/learning-record-read.ts:122)、[learning-invalidation.ts:22](/Users/mac/Tutor/src/learning-invalidation.ts:22)、[tutor-result-store.ts:55](/Users/mac/Tutor/src/tutor-result-store.ts:55)。

## 11. 本次验证结果与证据等级

执行了现有测试，未新增测试、未启动真实 Obsidian，也未调用付费模型：

```text
pnpm exec vitest run tests/tutor-a2a.test.ts tests/tutor-mcp.test.ts \
  tests/tutor-conversation.test.ts tests/tutor-result-store.test.ts \
  tests/tutor-journal.test.ts tests/tutor-collaboration.test.ts tests/tutor-codex.test.ts

实际存在并执行 5 个 test files：115 passed，5 failed。
5 个失败全在 HTTP 监听前触发：listen EPERM: operation not permitted 127.0.0.1。
其中 A2A 4 项、MCP HTTP 1 项；不能判为已通过，也不能据此归因为实现缺陷。
tutor-collaboration.test.ts / tutor-codex.test.ts 在本仓库没有同名测试文件，未执行。
```

为取得无监听依赖的清晰结果，另执行实际存在的纯单元测试范围：

```text
pnpm exec vitest run tests/tutor-conversation.test.ts tests/tutor-result-store.test.ts \
  tests/tutor-journal.test.ts tests/tutor-task.test.ts
4 test files passed；107 tests passed。
```

两次有重叠，**不能相加成 222 个不同测试**。这些结果说明相应单元行为通过，并不能证明当前桌面安装、运行权限、跨库连接、真实 A2A 互操作或真实模型输出已经验收。README 的历史 QA 陈述也不能替代本次运行验证；见 [host README:22](/Users/mac/Tutor/host-plugins/tutor/README.md:22)。

本审计分支未调用运行诊断。主对话随后实际调用：`tutor_diagnose` 返回 `Tutor unavailable: open Obsidian and enable Tutor MCP.`，`tutor_instances` 返回 `instances: []`。因此本次没有发现可连接实例，尚未核验配对或资料授权；其他静态能力不能写成已连接。

## 12. 可以开始什么，尚不能声称什么

**现在可开始：**查证原著和书目；编写课程；以明确来源/版本的 Markdown 作为背景与目标记录；在核实实例和配对后按指定文档逐库请教 Tutor；将每轮结果、分歧和下一步显式交接；由获授权的主对话写入“所作”并回读核验。

**尚不能说已实现或已验收：**跨库共同长期记忆；A2A contextId 的跨任务会话恢复；通用 `read_memory` 或学习记忆写入；稳定跨搬迁 Vault UUID；自动背景/目标同步和冲突合并；当前聊天被反向 Codex 专家接管；所有外部任务永久保存；端到端撤销/遗忘回执；已连接“所作”或读完所有学习档案；最新 MCP 规范完整兼容。

主对话已核实课程目标路径为“所作／哲学学习”。实例与授权、真实多库切换、远端 A2A 配置和模型服务保留政策仍未运行验收。静态代码能力与运行结论应分别报告。

## 13. 官方来源索引

全部于 2026-10-16 实际打开正文；不只依据搜索摘要。

| 来源 | URL | 用于核查 |
| --- | --- | --- |
| A2A 最新规范入口 | [正文](https://a2a-protocol.org/latest/specification/) | 当日 released version 为 1.0.0 |
| A2A 固定版规范 | [正文](https://a2a-protocol.org/v1.0.0/specification/) | context/task/message/parts、幂等、版本语义 |
| A2A 与 MCP | [正文](https://a2a-protocol.org/latest/topics/a2a-and-mcp/) | 两类协议的互补分工 |
| MCP 当前规范 | [正文](https://modelcontextprotocol.io/specification/2026-07-28) | latest 版本及新核心概况 |
| MCP 当前架构 | [正文](https://modelcontextprotocol.io/specification/2026-07-28/architecture) | host/client/server 与跨服务隔离 |
| MCP 当前授权 | [正文](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) | 传输层授权与 OAuth 机制 |
| MCP 实现对应旧版架构 | [正文](https://modelcontextprotocol.io/specification/2025-11-25/architecture) | 当前 SDK 与新规范的差别 |
| OpenAI MCP 文档 | [正文](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) | stdio/HTTP 和多服务器配置；配置共享不推出记忆共享 |
| OpenAI App Server | [正文](https://learn.chatgpt.com/docs/app-server) | thread/turn 与 start/resume/fork 的区别 |
| OpenAI Conversation state | [正文](https://developers.openai.com/api/docs/guides/conversation-state) | 显式历史与 API 状态延续边界 |

本审计采用 OpenAI Docs 技能的官方来源范围；没有用第三方资料判断 OpenAI 产品行为。源码 hash 与测试原始摘要另见 本附录末尾的复核记录。


## 独立复核记录

该审计与用户说明经过另一代理逐项对照源码。复核确认：当前A2A上下文没有跨任务延续、学习摘要按授权文档过滤、反向Codex会话独立、重启不恢复所有模型输入。课程整合时补入主对话实测连接状态。现有测试结果仅用于相应单元行为，不代表真实多库互操作已通过。
