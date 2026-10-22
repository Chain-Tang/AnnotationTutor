# Tutor AI 作图研究工作台

这套工作台把可重复观察、团队推断和产品决定分开记录。研究阶段保持 BoardDocument schema v4；候选模型输出只有在用户明确确认后才进入作品。

## 当前可运行基线

- `benchmark-v1.json`：60 个固定任务，24 个二次元、24 个结构力学、12 个通用任务。
- `experiment-record.schema.json`：每次实验记录模型版本、提示词版本、种子、延迟、费用、失败码、输出和人工评分。
- `provider-scorecard.csv`：模型横评总表，空白项表示尚未取得证据，不以猜测填充。
- `user-study-session.md`：第 5 周六名评审者的统一观察模板。
- `plan-status-2026-09-16.md`：六周计划的证据化状态、缺口与后续顺序。
- `mechanics-core-v1.json` 与 `npm run research:mechanics`：结构力学权威语义 fixture 和关系 F1 基线。
- `artist-strategy-v1.json` 与 `npm run research:artist-strategies`：6 个任务×3 种 AI 画笔策略的同条件协议矩阵；当前只验证实验接线，不包含视觉质量结论。
- `artist-live-v1/`、`artist-live-summary-latest.json` 与 `npm run research:artist-summary`：18 格真实 Provider 结果、阶段截图、人工评分和发布决定。
- `provider-evidence-2026-09-16.md`、`final-decision-2026-09-16.md`：官方能力/许可证据与三个独立产品版本的阶段结论。
- `npm run research:check`：离线检查任务数量、ID、字段和引用约束。

## 观察证据

- 当前 Tutor 已有 Artboard、图层、九类原生材质笔刷和 schema v4；旧 AI 入口主要围绕 Markdown/PDF 覆盖层。
- OpenAI 图像 API 文档提供生成、编辑、遮罩与多轮图像工作流，可作为云端编辑基线。
- Gemini 原生图像、BFL API、Qwen-Image、FLUX 和本地 ComfyUI/Diffusers 仍需在同一任务集上实测，尚不能从文档直接推断 Tutor 的最终质量、延迟或费用。
- Qwen-Image 仓库声明 Apache-2.0，强调中文文字与图像编辑；每个具体模型/权重仍需保存精确版本及许可证快照。
- 阿里云 Qwen Image 3.0 的 OpenAI 兼容接口已验证为同步 `/images/generations`：文生图不传 `image`，图生图传 1–3 张 `image`；兼容模式不支持 mask、partial image 或 `/images/edits`，结果 URL 仅保留 24 小时。
- 真实 1K 冒烟样本显示：1024×1024 头像、1024×1024 参考图编辑和 768×1280 全身图均成功；服务精确遵守自定义宽高。成功样本延迟为 26.5–67.9 秒。
- 815 KB PNG 参考图在兼容同步链路连续两次约 60 秒断开，重编码为 74.6 KB JPEG 后 40.2 秒成功；因此参考图上传副本需要体积治理。
- 纯图像结构力学样本虽然正确画出 A 铰、B 滚动和跨中 P，却擅自增加反力、跨度和方程，证明像素质量不能代替工程语义边界。
- 第一轮离线结构模板在前 6 个核心题上的平均关系 F1 为 76.5%；据此修正语义与结果协议后，固定基准已扩展至完整 24 题并达到关系/结果类型 F1 100%。新增覆盖多跨拓扑、两跨桁架、门式刚架、三铰拱、斜向力、局部/三角分布、弹簧、单位、澄清、参考图/上下文门禁、非法引用拒绝和不执行求解。该结果证明固定规则回归集通过，不代表未见自然语言或模型 Provider 的泛化准确率。
- Qwen `anime-01` 在关闭思考、Direct 提示扩写下的三个固定种子均一次成功，延迟为 16.8–17.6 秒，三张均满足头像任务。人物性别呈现、发型、眼睛和服饰差异明显，说明文字生成质量稳定不等于角色身份一致。
- OpenCode `mimo-v2.5-free` 的 BoardArtist 真实探针已验证图像输入和原生铅笔路径输出。初次少样例与规划器输出因非法 `brush` 组合被拒绝；加入完整材质路径正例后，三种策略单阶段均成功，延迟 30.1–52.8 秒。该证据只证明协议兼容，不构成视觉质量排名。
- 完整 18 格真实矩阵中 11/18 协议成功；成功结果都可原生编辑，但没有任何单元达到视觉 4/5。规划器成功率最高（83.3%）却没有带来更高视觉均分，并显著增加总延迟，因此当前模型被拒绝为生产默认。
- ControlNet 和 SAM 2 适合做条件约束与选区实验，但不会进入插件主包。
- PyNite 是未来求解联动候选；当前结构图只表示和校验题意，不输出工程求解结论。

## 推断

- 二次元成图、原生可编辑笔触和结构力学语义图的失败模式不同，单一模型和单一输出格式难以同时达到目标。
- 对可编辑画笔而言，批量类型化操作、分阶段检查点和整体撤销比逐点模拟鼠标更稳定、延迟更低。
- 对结构图而言，让模型输出严格语义 JSON，再由确定性渲染器生成符号，能把“理解题意”和“画得规范”分开测试。
- M4/16GB 是否适合某个本地模型属于待测事实；超过 14GB 可用内存或 120 秒预览门槛的模型应路由到外部 GPU companion。

## 已作产品决定

- Studio 显示实际路由模式，不隐藏自动路由结果。
- AI 画笔使用构图、大形、细节三阶段检查点，最多三轮；中途取消不修改作品，确认后一次写入历史。
- Studio AI 画笔可显式选择单一长提示、少样例模板或规划器＋三阶段工具；每次结果 provenance 记录实际策略。当前三者都仅供实验，尚无生产默认。
- 结构示意图先校验再预览，用户确认后才加入；未提供的数值保持 `P/q/M/L` 等符号，不执行反力、内力或变形计算。
- 图像 Provider 与本地 loopback Provider 使用统一接口；权重、ComfyUI、ControlNet、SAM 2 不打入主包。
- 图像候选在 schema v4 研究阶段保存为外部实验资源，不伪装成原生 paint layer；通过研究门槛后再决定 schema v5 的栅格资源清单。
- 当前 Vault 的首个云端实验 Provider 为 `qwen-image-3.0`。端点、独立密钥、精确宽高、1–6 候选、负面提示词、种子、提示词扩写、思考和水印均由前端配置；Tutor 将结果 URL 立即下载到 Vault，并将输出限制在 Qwen 的 1K 计量档（总像素不超过 2,250,000）。
- Qwen 参考图大于 512 KB 时，仅上传副本会在客户端重编码为最长边 1024 的 JPEG；原始作品与已保存候选不变。Studio 提供“快速预览”（Direct＋关闭思考）和“精细生成”（Agent＋思考）预设，但保留所有单项参数。
- 结构力学正式输出不路由到纯图像模型；Qwen 成图只可作为视觉参考，正式结果仍使用 `MechanicsDiagram` 校验和确定性矢量渲染。
- 不从零训练模型。只有稳定失败超过 15%，且累积至少 1,000 条经授权、被接受或人工修正的轨迹后，才讨论工具调用 SFT 或风格 LoRA。

## 六周执行门

1. 第 1 周：运行 `research:check`，为当前 Tutor 完成 60 条基线；每条失败必须有归一化失败码。
2. 第 2 周：所有候选先跑单种子低分辨率；各路线前两名再跑三种子。保留费用、地域、数据留存、内容安全和许可证证据。
3. 第 3 周：以 `BoardArtistSession` 比较长提示、模板少样例、规划器＋工具三种策略；只允许九类原生笔刷和有界批量操作。
4. 第 4 周：以 `MechanicsDiagram` 计算节点/构件/支座/荷载/标签关系 F1；关键引用错误直接拒绝渲染。
5. 第 5 周：三名插画/设计用户和三名结构力学学习者或教师完成固定任务；只记录可观察行为与原话，分析另列。
6. 第 6 周：完成 Provider 推荐、许可证清单、成本延迟报告和失败库；三个产品版本独立决策。

## 资料来源

- [OpenAI 图像生成文档](https://developers.openai.com/api/docs/guides/image-generation)
- [Gemini 原生图像生成](https://ai.google.dev/gemini-api/docs/image-generation)
- [Qwen-Image](https://github.com/QwenLM/Qwen-Image)
- [阿里云 Qwen Image 3.0 API 参考](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)
- [ComfyUI API v2](https://github.com/Comfy-Org/docs/blob/main/openapi-v2.yaml)
- [ControlNet](https://github.com/lllyasviel/ControlNet)
- [SAM 2](https://github.com/facebookresearch/sam2)
- [FLUX 图像编辑说明](https://github.com/black-forest-labs/flux/blob/main/docs/image-editing.md)
- [PyNite](https://github.com/JWock82/Pynite)
