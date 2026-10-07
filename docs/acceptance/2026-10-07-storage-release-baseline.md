# 存储与 Windows Release 检查记录

检查日期：2026-10-07（Asia/Singapore）。本记录是易用性 review 前的基线检查，不是完整试用验收报告；尚未进行页面交互截图、新版 Release 构建或真实模型验收。

## 检查方法与边界

只读检查两套 Workspace 的目录、SQLite 表计数与状态，并运行 SQLite `quick_check`。使用当前源码 `MaterialService.getActiveReleaseSnapshot` 和 `readReleaseContent` 校验 active 知识版本及正文，不输出课程正文、学生信息、对话或配置密钥。未启动生产服务，未修改业务文件、数据库状态或 active 指针。

此前已有多项未提交源码、测试和文档变更。它们保留在原处，不属于本次新实现。依赖环境曾出现 Node ABI 137 与 SQLite 模块 ABI 141 不匹配；两次 rebuild 未解决，随后复用本地旧发布目录中同版本 better-sqlite3 12.11.1 的 ABI 137 二进制，恢复只读检查。该变动只影响被忽略的 node_modules，不能替代新版发布包的 ABI 验证。

## 两套数据目录

开发数据位于仓库 `workspace/`；Windows 启动器默认数据位于 `%LOCALAPPDATA%\CourseAgent\workspace`，本机解析为 `C:\Users\ALmerb\AppData\Local\CourseAgent\workspace`。二者不是同一套数据。

计数只包含业务目录，不包含 `.gitkeep`。

| 项目 | 开发 Workspace | Windows 启动器 Workspace |
|---|---:|---:|
| 课程 | 1 | 1 |
| 评分表 Assignment | 1 | 1 |
| 答疑会话文件 | 3 | 3 |
| 知识 release 目录 | 1 | 1 |
| 知识 staging 目录 | 3 | 0 |
| 单份批改会话 | 6 | 7 |
| 批改 Agent run | 5，均 completed | 7，均 completed |
| Agent 事件 | 741 | 182 |
| 批次 | 0 | 1，completed |
| 批次成员 | 0 | 6，均 needs_review |
| 批量上传草稿 / 项 | 无对应表 | 1 / 6 |
| SQLite quick_check | ok | ok |

两处都存在本地配置文件；本次未展示其内容，也未测试模型连接或凭据是否可用。

### 开发 Workspace

- 转换状态：4 个 ready、1 个 conversion_failed、1 个 waiting_for_converter。
- 批改状态：3 个 draft_ready、1 个 needs_review、2 个 not_started。
- 作业名称状态：1 个 resolved、3 个 failed、2 个 pending。
- active 指针目标目录存在，但当前源码读取 active 快照时返回 `Knowledge release integrity validation failed`。目录存在不代表可供答疑使用；本次未进一步判定哪个文件与哈希不一致，不能断言正文损坏或删除。

开发数据包含失败与等待状态。后续需要验证页面是否明确给出重新转换、手动命名、发布有效资料等恢复入口，不应只显示状态码。

### Windows 启动器 Workspace

- 7 个会话均转换 ready、名称 resolved。
- 2 个 draft_ready、5 个 needs_review；仍需教师核对，不应当作已确认成绩。
- active 快照通过当前源码校验，8 篇正文逐篇通过读取与哈希校验。
- 批次 completed 表示调度处理完成，其 6 个成员仍是 needs_review。后续界面和说明必须解释教师复核尚未完成，避免将“批次完成”误认为“成绩确认完成”。

SQLite quick_check 仅说明数据库结构检查通过，不证明所有正式成绩文件、审计或业务关联一致。上述知识校验也不能替代成绩结果校验。

## Release 状态

- 当前仓库根目录 `release/` 为空。
- `gh release list --limit 5` 未返回 GitHub Release。远程仓库为 `https://github.com/Tucyan/lyagent`，GitHub CLI 当前账户为 Tucyan。
- 发现旧发布产物位于 `.worktrees/windows-release-bundle/release/`，保留 slim、full ZIP 和已解压目录，无需重新下载才能检查。
- 该 worktree HEAD 为 `882e7d1`（2026-08-20）；当前主工作目录 HEAD 为 `4b03cdd`（2026-09-24），且存在未提交修改。此信息不能精确证明 ZIP 来源提交，但足以表明旧包不能被当作当前源码的验收产物。

| 包 | 压缩大小 | ZIP 条目数 | 声明解压总大小 | 外部校验 |
|---|---:|---:|---:|---|
| course-agent-v0.1.0-win-x64-slim.zip | 771,486,824 字节 | 99,386 | 2,370,317,396 字节 | 与 SHA256SUMS.txt 不一致 |
| course-agent-v0.1.0-win-x64-full.zip | 2,010,100,488 字节 | 99,489 | 3,808,886,879 字节 | 与 SHA256SUMS.txt 一致 |

这里的大小和条目数来自 ZIP 中央目录，未证明全部条目可成功解压。

slim 实测 SHA-256：

```text
0b35f47a4b12e1dea129f482233781142ef1a94e89f17b3ee9a43fb4a65efc61
```

旧校验文件声明的 slim SHA-256：

```text
dea9f694f087613a413be8c47b553474a99ba6504f10e05b55236af3b8f210b3
```

full 实测及声明 SHA-256 一致：

```text
863f6e7010baf41ea0e5fdf9a5845ae20c7446550a490003be32d46d24429348
```

哈希不一致可能意味着包被重新生成后未同步校验文件，也可能意味着其他改动；本次没有证据判定原因。不能直接采用旧 slim 包作为可靠交付，也不能只更新哈希掩盖此问题。

旧包 manifest 声明版本 0.1.0、Windows x64、Node 24.11.1 / ABI 137、Python 3.12.10、Docling 2.118.0 和 Docling Serve 1.28.0。slim 不内置模型，full 内置模型；本次未完整验证已解压目录中的每个文件或启动转换器。

## 解压方案实测与结论

尝试 1 次：使用 Windows 自带 `C:\Windows\System32\tar.exe` 将旧 slim ZIP 解压到全新临时目录 `%TEMP%\course-agent-ux-extract-20261007`，限定 60 秒。60 秒后仍未完成，已停止进程；stderr 记录了条目文件名读取警告。该目录只有部分文件，不得启动或用于验收；本次保留现场，未自动删除。

由于约十万文件条目与数 GB 输出，大量文件创建可能影响耗时，但本次没有磁盘或扫描器测量，不能确认具体瓶颈。此轮 tar 尝试未成功，按用户原要求先停止并交接。

### 用户授权后追加的 WinRAR 实测

用户随后明确提出使用 WinRAR，并给出预计解压时间 4～7 分钟。本机已安装 `C:\Program Files\WinRAR\WinRAR.exe`；对同日校验通过的旧 full 包再次复核外部 SHA-256 后，以 `x -y -ibck -cfg-` 和带双引号的源、目标路径解压，使用隐藏进程、7 分钟上限及独立全新目录。

- 解压包：`.worktrees/windows-release-bundle/release/course-agent-v0.1.0-win-x64-full.zip`。
- 完整输出目录：`C:\Users\ALmerb\AppData\Local\Temp\course-agent-winrar-full-20261007-194931`。
- 解压耗时：202.49 秒，约 3 分 22 秒；WinRAR 退出码为 0。
- 输出普通文件数：99,489；包内 SHA256SUMS.txt 的 99,488 个清单文件全部存在，剩余文件为校验清单自身。
- 启动 BAT、release manifest、Node EXE、Python EXE、应用 launcher/main、SQLite 原生模块及 Docling Serve 包入口共 8 个关键文件 SHA-256 均匹配包内清单。
- 未对全部 99,488 个文件逐一重算 SHA-256，也未启动应用或转换器；不能据此宣称运行验收通过。

WinRAR 方案已经在本机实测成功，[AGENTS.md](../../AGENTS.md) 已改为优先使用它，并记录 7 分钟上限及失败后的人工交接规则。不同包和磁盘可能耗时不同，不能从这次成功推断一定比 tar 更快：tar 试验使用 slim 包和更短上限，两次试验条件不同。没有修改旧 ZIP 或校验文件，也没有关闭安全软件。新解压目录仍是旧版本，不能作为当前源码的发布产物。

## 后续易用性 review 范围

后续测试使用独立合成 Workspace，避免更改现有课程和学生数据。重点覆盖首次设置、创建课程、导入与发布、无可用资料的答疑、评分表编辑与冻结、转换失败恢复、单份与批量复核、导出和页面切换。

当前源码已看到需要复现的提示风险：公共 ApiError 将错误码、内部字段路径及原始校验文本拼入可见 message；部分页面直接使用服务端 message；评分表校验和教师复核原因可能直接展示英文消息或枚举。它们目前只是源码 review 线索，尚未实施修复或完成浏览器验证。

后续交付需要分别提供：合理的源码修改及失败测试回归；从新版 Release 解压起的详细使用说明；真实页面交互与恢复流程报告及合成数据截图。没有运行的步骤必须明确记为未验证，不能用旧发布包截图证明新版行为。
