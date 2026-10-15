# 三平台 CI 失败修复 · 2026-10-15

按授权推送 `codex/optimization-20261014`，初始源码提交为 `f21e6db`。
[首轮运行](https://github.com/Chain-Tang/AnnotationTutor/actions/runs/38683842158)的 Linux 和 macOS 完成类型检查、全量回归、发布回归、封包验证与产物上传；Windows 在测试阶段出现 4 个 suite 和 37 项用例失败，后续发布步骤因此没有执行。

## 修复

- 私有凭据、支持记录和桌面状态的写入原本都尝试以只读目录句柄执行 fsync，Windows 不支持这条路径。统一平台处理后，所有平台仍先同步文件，再原子替换；POSIX 继续同步目录并传播失败，Windows 明确省略 Node 无法提供的目录同步，不承诺等同 POSIX 的目录落盘保证。
- Windows 不提供 `O_NOFOLLOW`。私有文件读取统一在打开前拒绝符号链接，打开后比对文件句柄与前后目录项的 bigint dev/ino 身份，拒绝替换竞争，并在读取前后检查大小。实际链接和打开前后替换的回归保留；POSIX 同步失败仍不能报告成功。技术依据：[Node 22 文件打开常量](https://nodejs.org/download/release/v22.21.1/docs/api/fs.html#file-open-constants)。
- Windows checkout 的 CRLF 导致五个源码抽取测试无法定位方法或剥离 import。读取 fixture 时统一换行，并以 `.gitattributes` 约束源文本使用 LF；没有批量 renormalize 历史文件或修改二进制。
- Vitest 的文件 URL alias 使用 `fileURLToPath`；恢复文件名使用 `basename`；POSIX 权限位只在支持的平台断言，加密、Vault 隔离与真实链接安全检查继续执行。
- CLI 查找按传入的平台选择路径与 PATH 语义，避免在 Windows 执行 macOS 模拟用例时拼出反斜杠路径；新增 Windows 路径回归。

## 本地验证

- 插件、扩展类型检查与 71 个脚本语法检查通过。
- 全量 **223 文件 / 3096 用例通过**；V8 statements 63.40%、functions 62.58%、branches 60.89%、lines 67.73%，原覆盖率门槛均通过，没有降低阈值。
- 发布/恢复/封包回归 **33/33 通过**。
- 在独立临时树把 `src/main.ts` 和 `scripts/obsidian-eval.mjs` 实际转为 CRLF 后，五个相关 suite 的 **68 项测试通过**。

修复后的远端结论以[该分支 CI 运行列表](https://github.com/Chain-Tang/AnnotationTutor/actions/workflows/ci.yml?query=branch%3Acodex%2Foptimization-20261014)中对应提交的三平台结果为准。本记录保留首轮失败与修复依据，不把本机通过视为 Windows 实机或远端通过。
