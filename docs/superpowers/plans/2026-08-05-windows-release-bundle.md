# Windows 一键发布包与多模态模型路由实施计划

**目标：** 交付 Windows x64 Slim/Full 两种可复现发布包；双击 BAT 后由本地监督进程完成首次模型设置、MinerU 启停、端口选择和浏览器打开，并在批改读取图片后按需切换到可选视觉模型。

**边界：** 数据写入 `%LOCALAPPDATA%\CourseAgent`；发布包不含 Workspace、学生材料或密钥；本工作不实现 M6 备份恢复、安装器或自动更新。

## Task 1：统一模型配置与密钥

- [x] 先写配置兼容、OpenAI-compatible 模型构建、DPAPI 抽象和系统 API 的失败测试。
- [x] 建立主模型及可选视觉模型配置；默认主模型为 `deepseek-v4-flash` / `https://api.deepseek.com`。
- [x] 使用 Windows 当前用户 DPAPI 保存密钥，并保持旧 `deepseekApiKey` 只读兼容及一次性迁移。
- [x] 所有 Agent 与身份识别复用统一主模型；系统 API 不暴露密钥。

## Task 2：视觉切换与设置界面

- [ ] 先写读取图片后的下一轮模型切换、无视觉模型受控降级和流事件测试。
- [ ] 每次 Agent 运行从主模型开始；成功读取图片后，本次运行剩余轮次使用视觉模型。
- [ ] 无视觉模型时返回 `VISION_MODEL_NOT_CONFIGURED`，要求证据不足或教师确认。
- [ ] 增加 `/setup`、`/settings/models`、设置导航、连接测试及 `model_switch` 会话展示。

## Task 3：监督进程与 MinerU

- [ ] 先写端口选择、单实例、子进程回收、硬件检测和 MinerU backend 请求测试。
- [ ] `start-course-agent.bat` 仅启动内置 Node 监督进程；默认 3001，冲突时选择 3002–3010。
- [ ] GPU/LMDeploy 自检通过时选择 `hybrid-engine`，否则选择 `pipeline`，并随 `/tasks` 显式提交。
- [ ] 暴露脱敏的运行状态；所有服务只监听环回地址。

## Task 4：发布构建与文档

- [ ] 新增 `scripts/build-release.ps1` 与 `npm run release:win`，支持 `slim|full|all`。
- [ ] 固定并校验 Node 24.11.1、Python 3.12.10、MinerU 3.2.1 及下载 SHA-256。
- [ ] 生成发布 manifest、SHA256SUMS、第三方声明和 MinerU 许可证；扫描并拒绝敏感/开发数据。
- [ ] 更新架构、存储、开发、测试、运维和里程碑文档，只描述已交付事实。

## Task 5：验收

- [ ] 运行 `npm run check`、`npm run build`，从干净树构建 Slim/Full 包并检查 ABI、清单和敏感数据。
- [ ] 在中文及空格路径解压，验证首次设置、端口回退、单实例、退出回收、设置重启和数据持久化。
- [ ] 使用真实 DeepSeek 验证主模型；使用真实 MinerU 验证 DOCX/PDF、GPU 与强制 CPU；验证 Full 本地模型和 Slim 下载缓存。
- [ ] 验证视觉模型切换或未配置时的受控证据不足，并回归 M4/M5 与真实浏览器交互。
