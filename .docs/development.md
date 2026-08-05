# 本地开发

## 环境

- Windows 11；
- Node.js 24.x；
- npm；
- PowerShell；
- TypeScript ESM。

切换Node.js版本后，`better-sqlite3`可能发生ABI不匹配。出现`NODE_MODULE_VERSION`错误时运行：

```powershell
npm rebuild better-sqlite3
```

不要为解决本地ABI问题提交生成的二进制文件。

## 初始化与常用命令

```powershell
npm install
python -m pip install -r requirements.txt
npm run dev
npm run start
npm run typecheck
npm test -- --run
npm run check
npm run build
```

- `dev`：监听模式启动入口；
- `start`：运行当前入口；
- `check`：类型检查后运行一次全部测试；
- `build`：生成`dist/`。

M1资料规划和M2课程答疑都从`workspace/config/app.json`读取`deepseekApiKey`；未配置时资料规划使用确定性本地规划，课程答疑 API 返回`MODEL_NOT_CONFIGURED`。M2网络搜索默认使用本机 Python 的`ddgs`包，不需要搜索密钥；`webSearch.enabled`可关闭，`pythonCommand`可指定 Python 路径。该本地文件已被Git忽略，密钥不得写入仓库、日志或文档。

M4额外读取`mineru`配置。MinerU必须由用户单独启动，`baseUrl`只允许`http://127.0.0.1`、`localhost`或环回IPv6；默认轮询1秒、超时3600秒、最多自动提交3次，暂时性故障默认按5秒、30秒、2分钟序列退避且受提交次数上限约束。未配置时默认连接`http://127.0.0.1:8000`；服务未启动会进入等待转换状态并保留原件。旧式`.doc`不受支持，需先转换为`.docx`或`.pdf`。

提交前至少执行`npm run check`和`npm run build`。

## 当前代码布局

```text
src/
├─main.ts
├─core/
│  ├─agent-router.ts
│  ├─agent-runtime.ts
│  ├─message-bus.ts
│  ├─tool-registry.ts
│  └─workspace.ts
└─schemas/
   ├─messages.ts
   └─tools.ts

tests/
└─core.test.ts
```

目标目录和未来文件见`plan.md`及`.docs/architecture.md`。只有实现对应能力时才创建目录，不提前铺设空模块。

## TypeScript约定

- 使用严格类型和ESM；本地模块导入保留`.js`后缀。
- 外部输入先通过Zod或等价Schema解析，不能使用类型断言代替运行时校验。
- 构造函数注入模型、时间、文件和外部Provider，测试不得依赖真实凭据。
- 一个文件承担一个清晰职责；跨层共享类型放在`src/schemas/`。
- 错误使用具体类型，调用方只能捕获自己能够处理的错误。

## 添加功能的顺序

1. 确认任务涉及的架构和领域文档；
2. 写能够重现需求或缺陷的失败测试；
3. 定义或更新输入输出Schema；
4. 在Service实现最小确定性逻辑；
5. 用Tool、Agent、API或Channel进行薄适配；
6. 运行定向测试，再运行`npm run check`和`npm run build`；
7. 同步更新受影响文档。

## 配置与密钥

非敏感默认值维护在`config.example.json`，本机值维护在`workspace/config/app.json`。新增配置时：

- 在Schema中定义类型、默认值和范围；
- 同步更新示例配置和相关测试；
- 记录会改变行为的重要字段；
- Secret、Token、EncodingAESKey和模型密钥只从被Git忽略的本地配置或凭据存储读取。

禁止提交`workspace`中的课程资料、学生作业、正式结果、会话、数据库、日志和任何密钥。调整`.gitignore`前先检查是否会意外跟踪这些内容。

## Web 路由

- `/`：教师工作台，读取 `GET /api/dashboard`；页面进入时加载，用户可手动刷新。
- `/knowledge`：课程资料库；可用 `?course=<courseId>` 直接选中课程。
- `/qa`：课程答疑；可用 `?course=<courseId>&session=<sessionId>` 打开上下文。

Dashboard 不需要模型密钥即可显示；模型配置状态仅来自 `/api/system/model` 的安全摘要。修改前端路由时，同时更新 `src/api/web-assets.ts` 的直接访问入口和对应测试。

## 排查顺序

1. 运行失败的最小测试；
2. 检查Node/npm版本和原生模块ABI；
3. 检查`workspace/config/app.json`与环境变量；
4. 检查逻辑ID到Workspace路径的解析；
5. 检查job状态、租约和结果哈希；
6. 最后检查模型或外部Channel。

M2 的前端入口是 <http://127.0.0.1:3000/qa>。它通过 POST SSE 接收回答与工具活动；浏览器端不能改用环境变量或在请求中提交模型密钥。

排查过程中不得把学生正文、密钥或完整外部回调复制进Issue、日志或测试fixture。
