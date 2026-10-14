# Provider 能力、许可与部署证据

核验日期：2026-09-16。这里只记录官方资料可确认的事实；价格、地域、数据留存和账户可用性在真正接入时必须再次核验。

| Provider / 路线 | 官方证据 | 当前判断 |
| --- | --- | --- |
| OpenAI GPT Image | [官方图像生成指南](https://developers.openai.com/api/docs/guides/image-generation)和 [GPT Image 2 模型页](https://developers.openai.com/api/docs/models/gpt-image-2)描述生成与编辑端点。 | 保留为云端高质量生成/编辑横评候选；未配置凭据，所以本轮不伪造质量、延迟或费用数据。 |
| Google Gemini 原生图像 | [官方图像生成文档](https://ai.google.dev/gemini-api/docs/image-generation)说明原生多轮生成/编辑、1K–4K 输出和多参考图；生成图包含 SynthID。 | 保留为角色一致性和多参考候选；未配置凭据，尚未实测。 |
| Qwen Image 3.0 API | 当前 Vault 已完成 11 次脱敏记录；8 次返回图像、3 次失败。兼容接口可生成和参考图编辑，但不支持 mask。 | 当前 Tutor 默认云端位图 Provider；适合成图候选，不用于工程语义或原生笔触。 |
| Qwen-Image 开放权重 | [官方仓库](https://github.com/QwenLM/Qwen-Image)与仓库 LICENSE 提供权重/代码许可证据。 | 可进入本地 companion 评估，但具体版本、依赖和权重许可证仍需逐项快照。 |
| FLUX.1 Kontext dev | [官方模型卡](https://github.com/black-forest-labs/flux/blob/main/model_cards/FLUX.1-kontext-dev.md)和[许可证](https://github.com/black-forest-labs/flux/blob/main/model_licenses/LICENSE-FLUX1-dev)明确为非商业/非生产用途。 | 不能作为 Tutor 免费产品的默认生产本地模型；仅限研究。API 商业模型需按 API 条款单独评估。 |
| FLUX.2 klein 4B | [官方仓库模型表](https://github.com/black-forest-labs/flux2)列出 4B/4B Base 为 Apache-2.0，并支持生成及单/多参考编辑。 | 新增为本地 companion 优先候选；仍需在 M4/16GB 的 14GB/120 秒门槛上实测。 |
| ComfyUI | [官方 API v2 规范](https://github.com/Comfy-Org/docs/blob/main/openapi-v2.yaml)提供版本化作业接口。 | 继续作为外部 loopback 执行器，不进入插件主包；模型许可由具体工作流决定。 |
| OpenCode + mimo-v2.5-free | 18 格真实 BoardArtist 实验：11/18 协议成功，0 个单元视觉均分达到 4/5。 | 保留为免费实验 Provider，不作为复杂人物生产默认。 |

## 隐私和边界决定

- 云端操作只上传当前 Artboard、明确选区和用户选择的参考图；不上传整个 Vault。
- Provider 设置由用户控制，密钥不写入实验记录、作品 provenance 或公开导出。
- 公开导出继续移除源路径、隐藏图层和模型上下文。
- 未取得官方证据的留存周期一律标为 `TBD`，不得用“通常不会保存”等推测替代。

