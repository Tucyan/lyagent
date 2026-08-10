# 课程辅助智能体MVP完整实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务实施；所有实施步骤使用 `- [ ]` 跟踪，完成一个可验证步骤后再进入下一步。

**Goal：** 在个人 Windows 主机上交付一套边界受控、结果可追溯、崩溃后可恢复的课程资料整理、课程答疑和作业辅助批改系统。

**Architecture：** 系统采用 Channel → Message Bus → Agent Router → Agent Runtime → Tool Registry → Local Services → Workspace 的单体分层结构。Agent 只负责语义判断，路径、身份、分数、版本、幂等、发布和复核规则全部由程序执行；正式数据使用不可变发布版本，运行状态使用 SQLite，二者通过原子文件写入和启动协调保持一致。

**Tech Stack：** Windows 11、Node.js、TypeScript、Pi SDK、Fastify、React、Vite、SQLite、better-sqlite3、p-queue、unified/remark、fast-glob、Zod、Pino、Vitest。

---

## 0.1 MVP边界与交付节奏

本计划把原有大范围交付拆成两个连续边界：

- **MVP Core：** 本地Web管理端、Markdown资料导入、只读课程答疑、评分表设计、单份及批量批改、教师Review、JSON/Markdown/CSV导出；
- **MVP Integration：** 企业微信接入。只有完成接入方式技术验证，并证明本地进程能够可靠收发、验签和去重消息后，才进入正式实现。

实施形成7个可独立验收的纵向里程碑：

1. M1：课程资料库导入、发布与浏览；
2. M2：基于本地课程资料的Web答疑；
3. M3：评分表设计、校验与版本发布；
4. M4：单份作业批改、教师Review与导出；
5. M5：批量批改、暂停恢复与班级汇总；
6. M6：本地备份、恢复与可重复运行；
7. M7：企业微信课程答疑。

详细范围、用户验收步骤和通过标准以`docs/superpowers/plans/2026-08-02-course-agent-milestones.md`为准。每个里程碑必须形成完整可运行功能，由用户明确标记为`accepted`后才允许开始下一里程碑。



## 一、项目概述



本项目面向课程教学场景，在个人Windows主机上实现一套轻量级多智能体系统。



系统包含四个Agent：



```text

课程辅助智能体系统

├─资料导入Agent

├─课程答疑Agent

├─评分表设计Agent

└─作业批改Agent

```



其中：



- 资料导入Agent负责将未经处理的原始Markdown资料整理为结构清晰的本地知识库。

- 课程答疑Agent通过类似“查阅书籍”的方式浏览本地知识库，并接入企业微信。

- 评分表设计Agent辅助教师生成支持加分制和减分制的评分标准。

- 作业批改Agent按照评分表并发批改Markdown报告，输出评分、证据、理由和置信度。



MVP明确不引入：



- RAG；

- Embedding；

- 向量数据库；

- Redis；

- 分布式任务系统；

- 旧式二进制`.doc`导入；Markdown、DOCX和PDF通过发布包内置的Docling转换，初版不内置LibreOffice兼容层；

- OCR；

- 作业查重；

- 代码执行；

- Linux服务器部署；

- 复杂数据库设计。



---



# 二、核心设计原则



## 2.1 参考nanobot的轻量架构



整体结构参考nanobot的分层思想：



```text

Channel

   ↓

Message Bus

   ↓

Agent Router

   ↓

Agent Runtime

   ↓

Tool Registry

   ↓

Local Services

   ↓

Workspace

```



各层职责分离：



| 层级 | 职责 |

|---|---|

|Channel|接收企业微信或Web消息|

|Message Bus|统一消息格式|

|Agent Router|选择目标Agent|

|Agent Runtime|运行Pi Agent循环|

|Tool Registry|为不同Agent注册工具|

|Local Services|实现文件、评分、批改等业务逻辑|

|Workspace|保存资料、作业、结果和会话|



不让Channel直接调用模型，也不让Agent直接访问无约束的操作系统能力。



## 2.2 文件系统优先



MVP主要数据存储在本地文件夹中：



- 课程资料；

- 图片；

- 知识库目录；

- 作业要求；

- 评分表；

- 学生作业；

- 批改结果；

- Agent会话记录。



SQLite仅负责保存批改任务的运行状态。



## 2.3 Agent使用受控工具



Agent不能直接调用原始Node.js文件API，而是通过受控工具访问中间层：



```text

Agent

  ↓

Tool

  ↓

Service

  ↓

Filesystem

```



资料导入Agent可以执行读写操作，但写入范围受到严格限制。



答疑Agent具有知识库逻辑只读权限，但不能直接获取任意本地路径。



评分表设计Agent和作业批改Agent只能修改自己负责的结构化结果，不能使用通用文件写入工具。



## 2.4 Agent负责判断，程序负责约束



模型负责：



- 内容理解；

- 目录规划；

- 评分判断；

- 理由生成；

- 证据选择；

- 不确定性判断。



程序负责：



- 路径权限校验；

- 文件写入；

- 分数计算；

- 总分校验；

- 评分项完整性检查；

- 置信度范围检查；

- 并发控制；

- 失败重试；

- 结果保存。

## 2.5 可信上下文与对象身份

课程、导入任务、作业、批次和学生身份不由模型自由填写。Channel或管理端完成用户身份校验后，由程序创建不可变的可信上下文：

```ts
interface ToolContext {
  agentKey:AgentKey;
  courseId?:string;
  importId?:string;
  assignmentId?:string;
  batchId?:string;
  studentId?:string;
  sessionId:string;
  actorId:string;
}
```

规则：

- Agent可见工具只接收当前操作需要的业务字段；
- Service从`ToolContext`读取对象身份，不根据模型参数切换课程、批次或学生；
- 如果兼容层仍收到模型提供的ID，必须与上下文逐项相等，否则拒绝执行；
- 每个批改任务由`assignmentId + batchId + studentId`唯一标识；
- `courseId`、`importId`、`assignmentId`、`batchId`和`studentId`必须通过Zod字符白名单校验，禁止路径分隔符、冒号、控制字符和Windows保留名称。

## 2.6 Windows路径安全

简单执行`path.resolve()`并检查字符串前缀不足以构成安全边界。所有文件工具统一通过`Workspace`和`SafeFilesystem`执行以下检查：

1. 拒绝绝对路径、UNC路径、设备路径、盘符路径和NTFS ADS；
2. 对每个已存在路径段执行`lstat`，拒绝符号链接、junction和其他reparse point；
3. 对真实父目录执行规范化校验，确认其仍位于被授权根目录内；
4. Windows路径比较使用大小写不敏感的规范形式；
5. 创建文件时使用受控父目录和临时文件，不跟随调用方提供的链接；
6. 文件名、扩展名、单文件大小、目录深度、文件总数和批次总大小均设置上限；
7. 任何校验失败都记录安全事件，但日志不得包含学生报告正文或密钥。

安全测试至少覆盖`..`、绝对路径、大小写变体、UNC、设备路径、ADS、符号链接、junction、嵌套reparse point和校验后替换路径的竞争场景。

## 2.7 文件与SQLite一致性

SQLite保存任务控制状态，文件保存大体积内容和不可变结果。跨两种存储不假装使用单一事务，而是采用可协调协议：

```text
生成结果到同目录临时文件
→fsync并原子rename为最终JSON/Markdown
→计算并保存resultHash
→SQLite事务将job更新为终态
→批次结束后由单一聚合器重建summary.csv
```

启动恢复时先扫描终态文件并校验哈希，再处理SQLite状态：

- 有有效结果文件但数据库仍为`running`时，补写数据库终态，不重新调用模型；
- 没有有效结果文件且租约已经过期时，才将任务重新排队；
- 临时文件可安全删除或覆盖；
- CSV始终可由最终JSON确定性重建，不作为事实来源；
- 所有写操作具有幂等键，重复执行不会产生第二份正式结果。

## 2.8 可复现性与审计

每次正式答疑或批改至少记录：

- 模型Provider、模型ID和可获得的模型版本；
- Prompt版本和内容哈希；
- 评分表版本与哈希；
- 作业要求、学生提交和配置快照哈希；
- 工具调用摘要、开始时间、完成时间和重试次数；
- Agent原始结果、程序校验结果和最终发布结果；
- 教师修改前后的差异、修改人、时间和备注。

审计记录使用追加写JSONL或独立不可变事件文件，不允许覆盖历史事件。



---



# 三、MVP技术栈



| 模块 | 技术 |

|---|---|

|主要语言|TypeScript|

|Agent运行时|Pi SDK|

|API服务|Fastify|

|管理前端|React+TypeScript+Vite|

|本地数据库|SQLite|

|SQLite客户端|better-sqlite3|

|并发队列|p-queue|

|Markdown解析|unified+remark|

|文件扫描|fast-glob|

|数据校验|Zod|

|日志|Pino|

|配置格式|JSON|

|运行环境|Windows 11+Node.js|

|企业微信|WeCom Channel适配器|

|联网查询|可配置Web Search Provider|



主程序保持为单一TypeScript工程，不增加Python微服务。



---



# 四、总体架构



```text

企业微信私聊/群聊

本地Web管理端

        ↓

Channel Adapters

        ↓

Message Bus

        ↓

Agent Router

        ↓

┌─────────────────────────┐

│ Pi Agent Runtime        │

│                         │

│ ├─资料导入Agent         │

│ ├─课程答疑Agent         │

│ ├─评分表设计Agent       │

│ └─作业批改Agent         │

└─────────────────────────┘

        ↓

Agent专用Tool Registry

        ↓

┌─────────────────────────┐

│ Local Services          │

│                         │

│ ├─MaterialService       │

│ ├─KnowledgeService      │

│ ├─RubricService         │

│ ├─SubmissionService     │

│ ├─GradingService        │

│ └─ReviewService         │

└─────────────────────────┘

        ↓

Workspace+SQLite

```



## 4.1 Agent Router



路由由程序确定，不让模型自主判断：



```text

资料导入页面

→资料导入Agent



企业微信问答

→课程答疑Agent



评分表页面

→评分表设计Agent



批改任务页面

→作业批改Agent

```



---



# 五、Workspace目录结构



```text

workspace/

├─config/

│  ├─app.json

│  ├─models.json

│  └─wecom.json

│

├─inbox/

│  ├─materials/

│  │  └─{import_id}/

│  │     ├─source.md

│  │     └─assets/

│  └─submissions/

│

├─knowledge/

│  └─{course_id}/

│     ├─course.json

│     ├─active.json

│     ├─staging/

│     │  └─{import_id}/

│     │     ├─01-课程概述/

│     │     └─index/

│     └─releases/

│        └─{release_id}/

│           ├─01-课程概述/

│           │  ├─01-课程介绍.md

│           │  └─assets/

│           ├─02-进程管理/

│           │  ├─01-进程概念.md

│           │  ├─02-进程状态.md

│           │  └─assets/

│           └─index/

│              ├─tree.json

│              └─manifest.json

│

├─assignments/

│  └─{assignment_id}/

│     ├─assignment.md

│     ├─rubrics/

│     │  ├─draft.json

│     │  └─rubric-v1.json

│     ├─submissions/

│     │  └─{batch_id}/

│     │     └─{student_id}/

│     │        ├─report.md

│     │        └─assets/

│     └─results/

│        └─{batch_id}/

│           ├─{student_id}.json

│           ├─{student_id}.md

│           ├─audit/

│           │  └─{student_id}.jsonl

│           └─summary.csv

│

├─sessions/

│  ├─wecom/

│  └─web/

│

├─state/

│  └─app.db

│

└─logs/

```



文件夹本身表达课程结构，不额外建立课程章节数据库。`active.json`只保存当前`releaseId`及其manifest哈希；答疑服务只解析`active.json`指向的不可变版本，绝不扫描`staging/`。导入Agent只能写入自己的`staging/{importId}`，发布服务完成校验后将其原子移动到`releases/{releaseId}`，最后原子替换`active.json`。旧版本默认保留，管理员可显式回滚。



---



# 六、资料导入Agent



## 6.1 目标



资料导入Agent负责将未经整理的原始Markdown文件：



```text

原始Markdown

  ↓

分析标题和内容

  ↓

规划知识树

  ↓

拆分章节

  ↓

整理图片

  ↓

写入知识库

  ↓

生成目录清单

```



它不是简单的文件上传工具，而是知识库整理者。



## 6.2 权限



资料导入Agent具有受控读写权限：



```text

可读：

workspace/inbox/materials/{当前导入任务}/



可写：

workspace/knowledge/{目标课程}/staging/{当前导入任务}/

```



禁止：



- 读取其他任意系统目录；

- 写入Workspace以外位置；

- 删除其他课程；

- 覆盖已发布课程而不经过确认；

- 执行Shell命令。

运行时创建`ImportContext{courseId,importId,sessionId,actorId}`并注入所有资料工具。Agent不能通过工具参数切换目标课程或导入任务。只有`publish_knowledge_import`服务可以写入`releases/`和`active.json`。



## 6.3 工具表



### `scan_source_tree`



查看待导入资料目录。



```ts

{

  path?:string;

  depth?:number;

}

```



返回：



- 文件夹；

- Markdown文件；

- 图片；

- 文件大小；

- 相对路径。



### `read_source_markdown`



读取原始Markdown指定行范围。



```ts

{

  path:string;

  startLine:number;

  endLine:number;

}

```



约束：



- 默认最多读取200行；

- 仅允许读取当前导入任务目录；

- 返回标题信息和总行数。



### `read_source_image`



读取Markdown引用的图片。



```ts

{

  path:string;

}

```



用于理解图片内容或确认图片与章节的对应关系。



### `create_knowledge_directory`



创建知识库中的受控目录。



```ts

{

  path:string;

}

```



路径相对于当前导入任务的staging根目录，并且必须位于：



```text

workspace/knowledge/{context.courseId}/staging/{context.importId}/

```



### `write_knowledge_markdown`



创建或覆盖单个知识库Markdown文件。



```ts

{

  path:string;

  content:string;

  mode:"create"|"replace";

}

```



`replace`操作必须针对当前导入任务创建的文件，或经过用户确认。



### `copy_knowledge_asset`



将原资料图片复制到知识库目标目录。



```ts

{

  sourcePath:string;

  targetPath:string;

}

```



### `move_knowledge_entry`



调整已创建的目录或文件位置。



```ts

{

  sourcePath:string;

  targetPath:string;

}

```



用于Agent发现原目录规划不合理时进行修改。



### `delete_imported_entry`



删除当前导入任务中创建的错误文件。



```ts

{

  path:string;

}

```



只能删除当前导入任务产生且尚未发布的内容。



### `inspect_knowledge_tree`



查看当前已经生成的知识库结构。



```ts

{

  path?:string;

}

```



### `publish_knowledge_import`



执行最终校验并发布导入结果。



```ts

{

  expectedManifestHash:string;

}

```



程序负责检查：



- Markdown链接是否有效；

- 图片是否存在；

- 是否存在空目录；

- 文件名是否冲突；

- 是否存在越权路径；

- 是否存在未处理原始文件。



发布过程必须：

1. 锁定当前课程的发布操作；
2. 重新计算manifest并与`expectedManifestHash`比较；
3. 在staging内完成全部校验；
4. 将staging目录原子移动为不可变release；
5. 原子替换`active.json`；
6. 记录发布人、发布时间、源资料哈希和release哈希。

发布后生成：



```text

releases/{releaseId}/index/tree.json

releases/{releaseId}/index/manifest.json

active.json

```



## 6.4 Markdown拆分原则



优先按照标题层级拆分：



```text

# 一级标题

## 二级标题

### 三级标题

```



规则：



- 一个主题尽量形成一个Markdown文件；

- 一个文件建议控制在100～500行；

- 不强制机械等长分块；

- 不拆开代码块；

- 不拆开Markdown表格；

- 不拆开图片与紧邻说明；

- 保持原文顺序；

- 允许保留少量上下文说明；

- 不生成原文不存在的知识结论。



## 6.5 导入流程



```text

扫描原始目录

  ↓

查看主Markdown标题

  ↓

规划目标目录树

  ↓

创建目录

  ↓

分段读取原文

  ↓

写入拆分后的Markdown

  ↓

复制图片

  ↓

检查生成结果

  ↓

必要时移动、覆盖或删除

  ↓

发布知识库

```



---



# 七、课程答疑Agent



## 7.1 目标



答疑Agent模拟人查询书籍的过程：



```text

查看一级目录

  ↓

进入可能相关的章节

  ↓

查看二级目录

  ↓

在指定路径搜索

  ↓

读取命中的Markdown行

  ↓

继续读取上下文

  ↓

根据资料回答

```



它不直接访问本地文件系统，而是通过KnowledgeService只读访问知识库。



## 7.2 权限



答疑Agent只能访问当前课程：



```text

workspace/knowledge/{courseId}/

```



不能：



- 读取其他课程；

- 读取作业；

- 修改知识库；

- 查看系统配置；

- 获取绝对文件路径。



## 7.3 工具表



### `get_knowledge_root`



获取指定课程的一级目录。



```ts

{}

```



返回：



```ts

{

  currentPath:"",

  entries:[

    {

      name:"02-进程管理",

      type:"directory",

      description?:string

    }

  ]

}

```



### `list_knowledge_directory`



查看指定知识路径下的子目录和Markdown文件。



```ts

{

  path:string;

}

```



返回：



- 子目录；

- Markdown文件；

- 文件标题；

- 文件行数；

- 简短描述。



一次最多返回规定数量，例如50项；超过时支持分页。



### `search_knowledge`



在指定路径或整个课程中搜索信息。



```ts

{

  query:string;

  path?:string;

  maxResults?:number;

  offset?:number;

}

```



`path`为空时搜索整个课程。



搜索范围：



- 目录名；

- 文件名；

- Markdown标题；

- Markdown正文。



排序优先级：



```text

完整标题命中

>部分标题命中

>文件名命中

>路径命中

>正文多关键词命中

>正文单关键词命中

```



默认返回前5个结果，最多返回10个结果。



每个结果返回：



```ts

{

  resultId:string;

  path:string;

  heading:string;

  matchType:"heading"|"filename"|"path"|"content";

  line:number;

  preview:string;

  score:number;

}

```



### 多结果处理



当搜索出现多个结果时，Agent按照以下流程处理：



1. 查看结果的路径、标题和预览；

2. 优先选择标题最匹配的1～3个结果；

3. 使用`read_markdown_lines`读取具体内容；

4. 如果结果涉及不同概念，则分别读取并综合；

5. 如果前5个结果均不相关，则：

   - 更换关键词；

   - 限定目录重新搜索；

   - 使用`offset`读取下一页；

6. 不允许只根据搜索预览直接生成最终答案。



### `read_markdown_lines`



读取指定Markdown文件的行范围。



```ts

{

  path:string;

  startLine:number;

  endLine:number;

}

```



约束：



- 默认最大100行；

- 最大值可在配置中调整；

- `startLine`不得小于1；

- 超过文件总行数时自动截断；

- 返回行号；

- 返回文件标题和总行数；

- 返回当前范围内引用的图片。



示例返回：



```ts

{

  path:"02-进程管理/02-进程状态.md",

  totalLines:186,

  startLine:40,

  endLine:75,

  content:[

    {line:40,text:"## 阻塞状态"},

    {line:41,text:"进程等待某个事件时……"}

  ],

  images:[

    {

      line:60,

      path:"02-进程管理/assets/process-state.png",

      alt:"进程状态转换图"

    }

  ]

}

```



### `read_knowledge_image`



读取知识库中的指定图片。



```ts

{

  path:string;

}

```



仅允许读取通过Markdown引用的课程图片。



### `web_search`



查询互联网公开资料。



```ts

{

  query:string;

  maxResults?:number;

}

```



使用条件：



- 用户明确要求联网；

- 本地课程资料不存在答案；

- 问题涉及实时信息；

- 需要外部资料补充解释。



输出必须区分：



```text

课程资料中的回答

互联网补充信息

```



## 7.4 回答要求



回答应包含：



- 直接答案；

- 必要的解释；

- 知识库文件路径；

- 标题；

- 读取行范围；

- 互联网内容的独立来源标记。



资料不足时必须说明：



```text

当前课程资料中没有找到足够依据。

```



不能将模型自身知识伪装为课程资料。



---



# 八、评分表设计Agent



## 8.1 目标



根据教师输入的：



- 作业要求；

- 总分；

- 原始评分标准；

- 加分制或减分制；

- 特别限制；



生成逻辑严谨、可执行、可解释的评分表。



## 8.2 交互流程



```text

读取作业要求

  ↓

分析评分维度

  ↓

发现歧义

  ↓

向教师提问

  ↓

生成评分表草稿

  ↓

校验

  ↓

必要时修改草稿

  ↓

教师确认

  ↓

冻结版本

```



## 8.3 工具表



### `ask_rubric_question`



向教师询问评分标准中的不确定内容。



```ts

{

  question:string;

  context:string;

  options:[

    {

      id:"A";

      label:string;

      description:string;

    },

    {

      id:"B";

      label:string;

      description:string;

    },

    {

      id:"C";

      label:string;

      description:string;

    }

  ];

  customOption:{

    id:"D";

    label:"自定义";

    placeholder:string;

  };

}

```



默认必须提供三个预设选项，每个选项包含说明，并提供第四个自定义选项。



适用情况：



- 评分标准存在多种合理解释；

- 加分项是否计入总分不明确；

- 缺少最高扣分限制；

- 两个评分项可能重复；

- 未明确格式问题的扣分方式；

- 未明确是否允许部分得分。



对于可以从现有资料中确定的内容，Agent不得频繁提问。



### `create_rubric_draft`



创建评分表草稿。



```ts

{

  rubric:Rubric;

}

```



程序保存至：



```text

assignments/{assignmentId}/rubrics/draft.json

```



### `read_rubric_draft`



读取当前评分表草稿。



```ts

{}

```



### `update_rubric_draft`



修改已生成的评分表草稿。



推荐使用结构化Patch：



```ts

{

  expectedVersion:number;

  changes:[

    {

      operation:"add"|"replace"|"remove";

      path:string;

      value?:unknown;

    }

  ];

}

```



例如：



```ts

{

  operation:"replace",

  path:"/criteria/2/maxScore",

  value:20

}

```



使用`expectedVersion`避免覆盖教师刚刚进行的修改。



### `validate_rubric`



检查评分表。



```ts

{}

```



检查：



- 总分；

- 项目分值；

- ID重复；

- 等级分数越界；

- 条件是否可观察；

- 是否缺少最低等级；

- 减分项是否缺少最大扣分；

- 重叠组是否合理；

- 同一缺陷是否可能重复扣分。



### `publish_rubric`



冻结评分表版本。



```ts

{

  expectedVersion:number;

}

```



发布后生成：



```text

rubric-v1.json

```



已冻结版本不能直接修改。修改必须重新创建草稿并发布新版本。



## 8.4 加分制数据结构

```json
{
  "mode":"additive",
  "totalScore":100,
  "partialCreditAllowed":true,
  "criteria":[
    {
      "id":"C01",
      "name":"实验原理",
      "description":"评价学生是否正确说明实验原理",
      "maxScore":20,
      "scorePolicy":"range",
      "levels":[
        {
          "id":"L4",
          "minScore":16,
          "maxScore":20,
          "condition":"完整说明实验原理，并解释与实验过程的联系"
        },
        {
          "id":"L3",
          "minScore":9,
          "maxScore":15,
          "condition":"主要原理正确，但联系说明不足"
        },
        {
          "id":"L2",
          "minScore":1,
          "maxScore":8,
          "condition":"仅描述少量相关概念"
        },
        {
          "id":"L1",
          "minScore":0,
          "maxScore":0,
          "condition":"缺少相关内容或内容错误"
        }
      ],
      "evidenceRequired":true
    }
  ]
}
```

`scorePolicy`取值及校验规则：

- `exact-level`：只能选择等级定义的单一分数；
- `range`：必须保存`selectedLevelId`，最终分数只能位于该等级的闭区间内；
- `continuous`：允许0到`maxScore`连续取值，但Rubric必须提供可观察的部分得分规则；
- `partialCreditAllowed=false`时禁止输出等级锚点之外的分数。

同一criterion的等级区间必须连续、不得重叠，并完整覆盖0到`maxScore`。

## 8.5 减分制数据结构

```json
{
  "mode":"deductive",
  "baseScore":100,
  "rules":[
    {
      "id":"D01",
      "name":"缺少实验结果分析",
      "condition":"报告只展示结果，没有解释原因",
      "deduction":10,
      "occurrence":"once",
      "maxDeduction":10,
      "confidenceWeight":10,
      "evidenceRequired":true,
      "overlapGroup":"result-analysis"
    }
  ]
}
```

同一`overlapGroup`内默认只能触发一个规则，除非评分表明确允许累计。减分制必须为每条规则生成判定结果，包括`triggered`、`deductionApplied`、证据和置信度，即使规则没有触发也必须记录。`confidenceWeight`默认等于`maxDeduction`，用于总体置信度聚合；所有权重为0时总体置信度为空并强制人工复核。



---



# 九、作业批改Agent



## 9.1 目标



按照冻结的评分表批改Markdown报告，并输出：



- 每项得分；

- 评分理由；

- 报告证据；

- 单项置信度；

- 总体置信度；

- 总分；

- 优点；

- 改进建议；

- 是否需要人工复核。



## 9.2 任务隔离



每名学生使用独立AgentSession：



```text

Student A AgentSession

Student B AgentSession

Student C AgentSession

```



单个Agent只能读取当前学生报告目录。

启动每个批改会话前，队列服务创建不可变的`GradingJobContext{assignmentId,batchId,studentId,submissionRoot,rubricVersion}`。所有提交读取工具和批改结果工具都从该上下文解析路径；Agent可见参数中不出现`assignmentId`、`batchId`或`studentId`，从而无法跨任务切换对象。



## 9.3 工具表



### `get_submission_tree`



查看当前学生报告目录。



```ts

{

  path?:string;

}

```



返回Markdown文件和图片。



### `search_submission`



在当前学生报告中搜索。



```ts

{

  query:string;

  path?:string;

  maxResults?:number;

  offset?:number;

}

```



多结果处理方式与知识库搜索类似：



1. 默认返回前5项；

2. 查看匹配类型、标题和预览；

3. 读取最相关结果；

4. 必要时读取多个结果交叉验证；

5. 不根据预览直接评分。



### `read_submission_lines`



读取报告指定行范围。



```ts

{

  path:string;

  startLine:number;

  endLine:number;

}

```



默认最多100行。



### `read_submission_image`



读取当前报告中的图片。



```ts

{

  path:string;

}

```



### `ask_grading_question`



批改中出现重要歧义时向教师提问。



```ts

{

  criterionId:string;

  question:string;

  evidenceSummary:string;

  options:[

    {

      id:"A";

      label:string;

      description:string;

      suggestedScore?:number;

    },

    {

      id:"B";

      label:string;

      description:string;

      suggestedScore?:number;

    },

    {

      id:"C";

      label:string;

      description:string;

      suggestedScore?:number;

    }

  ];

  customOption:{

    id:"D";

    label:"自定义";

    placeholder:string;

  };

}

```



适用情况：



- 评分标准无法覆盖该特殊情况；

- 报告内容存在多种合理解释；

- 图片或表格无法可靠识别；

- 评分证据互相矛盾；

- 某项得分在两个等级之间无法确定；

- 作业要求与评分表存在冲突。



批量批改时，被提问的任务进入：



```text

waiting_for_teacher

```



其他作业继续处理。



### `create_grading_draft`



创建批改草稿。



```ts

{

  criteriaResults:CriterionResult[];

  strengths:string[];

  improvements:string[];

}

```



### `read_grading_draft`



读取当前学生批改草稿。



```ts

{}

```



### `update_grading_draft`



修改批改结果。



```ts

{

  expectedVersion:number;

  changes:[

    {

      operation:"add"|"replace"|"remove";

      path:string;

      value?:unknown;

    }

  ];

}

```



支持：



- Agent自我复核后修改；

- 教师要求重新判断某项；

- 补充证据；

- 修改理由；

- 修改分数；

- 修改置信度。



不能修改学生原始报告。



### `validate_grading`



校验当前批改结果。



```ts

{}

```



检查：



- 是否覆盖全部评分项；

- 分数是否越界；

- 总分是否正确；

- 是否存在重复扣分；

- 非满分项是否有理由；

- 是否有证据；

- 证据路径和行号是否有效；

- 置信度是否在0～1；

- 低置信度项是否标记复核；

- 总体置信度计算是否一致。



### `publish_grading`



发布最终批改结果。



```ts

{

  expectedVersion:number;

}

```



程序生成：



- JSON结果；

- Markdown反馈；

- 结果哈希并在SQLite中提交job终态。

`publish_grading`不得直接写批次CSV。`summary.csv`只由批次级`SummaryService`读取全部终态JSON后统一生成。



---



# 十、批改结果与置信度设计



## 10.1 单项置信度



每个评分项增加：



```ts

confidence:{

  value:number;

  level:"high"|"medium"|"low";

  reasons:string[];

}

```



完整评分项示例：



```json

{

  "criterionId":"C01",

  "criterionName":"实验原理",

  "maxScore":20,

  "selectedLevelId":"L4",

  "score":16,

  "reason":"基本原理正确，但未解释与实验步骤之间的关系。",

  "evidence":[

    {

      "path":"report.md",

      "heading":"2.实验原理",

      "lineRange":[28,41],

      "quote":"本实验通过……"

    }

  ],

  "confidence":{

    "value":0.86,

    "level":"high",

    "reasons":[

      "报告中存在直接证据",

      "内容与评分等级条件匹配",

      "未发现相互矛盾的内容"

    ]

  },

  "requiresReview":false

}

```



## 10.2 置信度含义



置信度表示：



> Agent认为当前评分结论在现有评分表和报告证据下可靠的程度。



它不表示：



- 学生答案正确的概率；

- 模型总体准确率；

- 分数在统计意义上的真实概率；

- 教师一定会同意的概率。



## 10.3 置信度计算依据



Agent需要综合考虑：



1. **证据直接性**

   - 是否找到直接对应内容；

   - 是否依赖推断；

   - 是否仅根据目录或摘要判断。



2. **评分规则明确度**

   - 评分等级是否清晰；

   - 是否存在等级边界模糊；

   - 是否存在规则冲突。



3. **证据完整性**

   - 是否读取完整章节；

   - 是否存在未读取的相关内容；

   - 图片是否能够正确理解。



4. **内部一致性**

   - 报告是否存在相互矛盾的描述；

   - 文字和图片是否一致。



5. **判断稳定性**

   - 是否明显符合某个等级；

   - 是否处于两个评分等级边界。



## 10.4 置信度等级



默认阈值：



```text

高置信度：0.80～1.00

中置信度：0.60～0.79

低置信度：0.00～0.59

```



阈值保存在配置文件，可由教师调整。



## 10.5 总体置信度



总体置信度由程序计算，不直接采用模型自由填写。



推荐公式：



```text

总体置信度

=

加分制：各评分项置信度按maxScore加权平均

减分制：每条规则的判定置信度按confidenceWeight加权平均

```



程序同时计算：



- `overallConfidence`：加权平均；

- `lowestCriterionConfidence`：最低单项置信度；

- `lowConfidenceCount`：低置信度项数量。

减分制的未触发规则同样参与计算，因为“确认不存在缺陷”也是评分判断。若没有正权重、关键规则未被检查或存在无法读取的关键证据，则不输出虚假的数值总体置信度，而是设置`overallConfidence:null`并强制`requiresReview=true`。



示例：



```json

{

  "overallConfidence":0.78,

  "lowestCriterionConfidence":0.52,

  "lowConfidenceCount":1

}

```



即使总体置信度较高，只要存在关键低置信度项，也需要教师复核。



## 10.6 自动复核规则



满足任一条件时：



```text

requiresReview=true

```



默认条件：



- 任一单项置信度低于0.60；

- 总体置信度低于0.70；

- 单项分数处于两个等级边界；

- 证据仅为间接推断；

- 报告存在互相矛盾的内容；

- 图片是关键证据但无法可靠解析；

- Agent调用了`ask_grading_question`；

- 单项扣分超过该项满分的50%；

- 总分位于及格线±3分范围；

- `validate_grading`发现警告。



## 10.7 Review排序



教师Review页面默认按以下优先级排序：



```text

等待教师回答

>低置信度且高分值项目

>总体置信度最低

>低置信度项目最多

>及格线附近

>普通完成结果

```



---



# 十一、最终批改输出



## 11.1 JSON结果



```json

{

  "schemaVersion":"1.0",

  "assignmentId":"assignment-01",

  "batchId":"batch-01",

  "studentId":"20260001",

  "rubricVersion":"v1",

  "provenance":{

    "modelProvider":"configured-provider",

    "modelId":"configured-model",

    "promptVersion":"grader-v1",

    "promptHash":"sha256:...",

    "rubricHash":"sha256:...",

    "assignmentHash":"sha256:...",

    "submissionHash":"sha256:...",

    "configHash":"sha256:...",

    "startedAt":"2026-08-02T01:00:00Z",

    "completedAt":"2026-08-02T01:02:00Z",

    "attempt":1

  },

  "totalScore":86,

  "maxScore":100,

  "overallConfidence":0.78,

  "lowestCriterionConfidence":0.52,

  "lowConfidenceCount":1,

  "requiresReview":true,

  "criteria":[

    {

      "criterionId":"C01",

      "criterionName":"实验原理",

      "maxScore":20,

      "selectedLevelId":"L4",

      "score":16,

      "reason":"说明了主要原理，但没有建立原理与实验步骤的完整联系。",

      "evidence":[

        {

          "path":"report.md",

          "heading":"2.实验原理",

          "lineRange":[28,41],

          "quote":"本实验通过……"

        }

      ],

      "confidence":{

        "value":0.86,

        "level":"high",

        "reasons":[

          "存在直接文本证据",

          "评分等级匹配明确"

        ]

      },

      "requiresReview":false

    },

    {

      "criterionId":"C02",

      "criterionName":"实验结果分析",

      "maxScore":30,

      "score":20,

      "reason":"存在结果描述，但是否包含完整原因分析不够明确。",

      "evidence":[

        {

          "path":"report.md",

          "heading":"4.实验结果",

          "lineRange":[94,120],

          "quote":"实验结果如图所示……"

        }

      ],

      "confidence":{

        "value":0.52,

        "level":"low",

        "reasons":[

          "分析内容与结果描述混合",

          "评分等级边界不明确"

        ]

      },

      "requiresReview":true

    }

  ],

  "strengths":[

    "报告结构完整",

    "实验步骤描述清晰"

  ],

  "improvements":[

    "补充实验现象产生原因的分析"

  ],

  "reviewReasons":[

    "C02置信度低于0.60"

  ],

  "reviewStatus":"pending",

  "resultHash":"sha256:..."

}

```



## 11.2 学生Markdown反馈



```markdown

# 作业批改结果



总分：86/100



> 当前结果需要教师复核。



## 评分表



| 评分项 | 满分 | 得分 | 置信度 | 评分依据 |

|---|---:|---:|---:|---|

| 实验原理 | 20 | 16 | 86% | 原理基本正确，但联系说明不足 |

| 实验结果分析 | 30 | 20 | 52% | 结果描述存在，但原因分析不明确 |



## 主要优点



- 报告结构完整

- 实验步骤描述清晰



## 改进建议



- 补充实验结果产生原因

- 建立理论和实验现象之间的联系

```



学生正式反馈中是否显示置信度由配置决定。教师Review页面始终显示。

教师的每次修改追加到`results/{batchId}/audit/{studentId}.jsonl`，事件至少包含`eventId`、`actorId`、`createdAt`、`beforeHash`、`afterHash`、结构化Patch和备注。正式JSON只保存当前确认状态，审计文件保存完整修改历史。



## 11.3 班级CSV



```text

student_id,C01,C02,total,overall_confidence,lowest_confidence,review_status

20260001,16,20,86,0.78,0.52,needs_review

```



---



# 十二、并发批改设计



## 12.1 并发模型



30～120份作业采用受控异步并发：



```text

全部作业

   ↓

本地任务列表

   ↓

p-queue

   ↓

同时运行4个AgentSession

   ↓

完成后领取下一份

```



默认：



```json

{

  "gradingConcurrency":4

}

```



可配置为：



```text

2、4、6、8

```



不同时启动120个Agent。

并发任务不得直接修改共享的`summary.csv`。每个job只写入自己的`{studentId}.json`和`{studentId}.md`，文件名从可信`GradingJobContext`生成。批次进入终态后，由单一`SummaryService`在读取、校验全部终态JSON后生成临时CSV，并原子替换`summary.csv`。教师修改成绩后同样通过该服务串行重建CSV。



## 12.2 任务状态



```text

pending

running

waiting_for_teacher

completed

needs_review

cancelled

failed

```



含义：



| 状态 | 含义 |

|---|---|

|pending|等待批改|

|running|正在批改|

|waiting_for_teacher|Agent提出问题，等待回答|

|completed|完成且无需复核|

|needs_review|完成但需要人工复核|

|cancelled|教师取消，保留已有草稿但不发布|

|failed|任务失败|

合法状态转换由程序定义并在SQLite事务中执行：

```text
pending → running
running → waiting_for_teacher | completed | needs_review | failed | pending
waiting_for_teacher → pending | cancelled
failed → pending | cancelled
needs_review → completed
pending → cancelled
```

任何其他转换都返回冲突错误。暂停批次只停止领取新任务，不强行中断正在执行的模型请求。



## 12.3 程序重启恢复



启动时：



- `completed`和`needs_review`不重复批改；

- `pending`继续执行；

- `running`且租约未过期时不领取；

- `running`且租约过期时，先根据`result_path`和`result_hash`协调文件与数据库；仅在没有有效正式结果时重置为`pending`；

- `waiting_for_teacher`保留问题；

- `failed`可手动重试。

每次领取任务时在事务中写入`lease_owner`和`lease_expires_at`。运行中的worker定期续租；重试复用同一job ID和幂等键。失败重试采用有上限的指数退避，默认最多3次，参数错误、权限错误和Schema校验错误不自动重试。



---



# 十三、SQLite最小设计



## 13.1 `grading_batches`

```sql
CREATE TABLE grading_batches(
  id TEXT PRIMARY KEY,
  assignment_path TEXT NOT NULL,
  assignment_hash TEXT NOT NULL,
  rubric_path TEXT NOT NULL,
  rubric_hash TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  config_snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK(status IN ('pending','running','paused','completed','failed','cancelled')),
  total_count INTEGER NOT NULL,
  completed_count INTEGER NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## 13.2 `grading_jobs`

```sql
CREATE TABLE grading_jobs(
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  submission_path TEXT NOT NULL,
  submission_hash TEXT NOT NULL,
  result_path TEXT,
  result_hash TEXT,
  status TEXT NOT NULL
    CHECK(status IN ('pending','running','waiting_for_teacher','completed','needs_review','failed','cancelled')),
  score REAL,
  overall_confidence REAL,
  lowest_confidence REAL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  idempotency_key TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(batch_id, student_id),
  UNIQUE(idempotency_key),
  FOREIGN KEY(batch_id) REFERENCES grading_batches(id) ON DELETE CASCADE
);

CREATE INDEX grading_jobs_status_lease_idx
ON grading_jobs(status, lease_expires_at);
```

## 13.3 `grading_questions`

单个任务可能在不同评分项产生多个问题，因此不在`grading_jobs`中保存单个`pending_question`字符串：

```sql
CREATE TABLE grading_questions(
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  criterion_id TEXT NOT NULL,
  question_json TEXT NOT NULL,
  answer_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('open','answered','cancelled')),
  applies_to_batch INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  answered_by TEXT,
  FOREIGN KEY(job_id) REFERENCES grading_jobs(id) ON DELETE CASCADE
);

CREATE INDEX grading_questions_job_status_idx
ON grading_questions(job_id, status);
```

数据库启动时必须执行`PRAGMA foreign_keys=ON`和迁移版本检查。批次计数只在job终态转换的同一事务中更新，也可以随时通过job表重新计算；计数缓存不得成为事实来源。

不增加课程章节、评分明细、知识块等复杂数据库表；`grading_questions`属于任务恢复所需的最小控制状态。



完整结果仍保存在JSON文件中。



---



# 十四、企业微信接入



## 14.1 支持场景



- 企业微信私聊机器人；

- 企业微信群内`@机器人`；

- 不同群绑定不同课程。



## 14.2 Channel职责



企业微信适配器只负责：



```text

接收消息

→识别用户、群和课程

→转换为InboundMessage

→发送到Message Bus

→接收答疑结果

→返回企业微信

```



不能：



- 直接读取知识文件；

- 直接调用模型；

- 修改课程；

- 修改评分结果。



## 14.3 课程映射



MVP使用配置文件：



```json

{

  "wecomCourseBindings":{

    "group_001":"operating-system",

    "group_002":"data-structure"

  },

  "userDefaultCourses":{

    "user_001":"operating-system"

  }

}

```

`wecom.json`只保存非敏感映射。Secret、Token、EncodingAESKey等凭据从Windows用户级环境变量或系统凭据存储读取，不写入仓库、日志、会话文件或前端响应。

## 14.4 接入方式技术验证与可靠性

正式实现前先完成一个可丢弃的WeCom连接验证，明确采用的机器人/应用能力、回调或长连接方式，以及个人Windows主机如何接收消息。验证必须回答：

- 本机离线、休眠或网络变化时企业微信如何表现；
- 是否需要公网HTTPS入口、反向代理、隧道或常驻网关；
- 消息应答时限、异步回复方式和最大消息长度；
- 私聊与群聊事件中可获得的用户、群和消息唯一标识；
- 当前组织管理员需要启用哪些权限。

Channel实现必须包含：

1. 验签、解密和时间戳窗口检查；
2. 使用企业微信消息ID或稳定事件摘要作为幂等键；
3. 在SQLite中保存短期去重记录，重复回调返回同一处理结果；
4. 快速确认入站消息，耗时答疑进入异步处理；
5. 对限流、超时和5xx执行有上限退避重试；
6. 长回复按段落安全拆分并保持引用完整；
7. 用户、群和课程映射失败时拒绝调用Agent；
8. 日志脱敏，不记录密钥和完整会话正文。

如果技术验证无法在目标网络环境中稳定运行，MVP Integration暂停，但不阻塞已经验收的MVP Core。



---



# 十五、本地管理界面



## 15.1 资料导入页



功能：



- 创建课程；

- 选择原始Markdown资料目录；

- 查看Agent规划的知识树；

- 查看拆分后的文件；

- 预览图片路径；

- 修改目录规划；

- 执行导入；

- 查看发布结果。



## 15.2 知识库浏览页



功能：



- 浏览课程文件树；

- 查看Markdown文件；

- 查看行号；

- 搜索课程内容；

- 查看图片；

- 手动修改错误资料。



人工修改知识库通过管理端完成，不通过答疑Agent。



## 15.3 评分表设计页



功能：



- 输入作业要求；

- 输入原始评分标准；

- 选择加分制或减分制；

- 回答Agent提出的问题；

- 查看评分表草稿；

- 手动编辑；

- 重新让Agent修改；

- 校验；

- 发布版本。



## 15.4 批量批改页



功能：



- 选择作业；

- 选择评分表版本；

- 选择学生报告目录；

- 配置并发数；

- 启动批改；

- 暂停和恢复任务；

- 查看进度；

- 回答Agent问题；

- 重试失败任务。



## 15.5 教师Review页



显示：



- 学生；

- 总分；

- 总体置信度；

- 最低单项置信度；

- 低置信度项目数量；

- Review原因；

- 单项得分；

- 评分理由；

- 证据原文；

- 对应Markdown行；

- 相关图片。



支持：



- 修改单项分数；

- 修改理由；

- 补充Review备注；

- 标记为已确认；

- 重新运行指定评分项；

- 导出结果。

## 15.6 本地管理端安全与数据保留

- Fastify默认只监听`127.0.0.1`，不得默认暴露到局域网；
- 首次启动生成本地随机会话密钥，所有写请求执行CSRF校验；
- 前端不能接受或返回绝对文件路径，只使用逻辑资源ID；
- Markdown预览禁用原始HTML或进行严格清洗，图片只通过受控API读取；
- 下载导出使用固定文件名和`Content-Disposition`，防止路径注入；
- 学生原始作业、会话、结果和日志设置可配置保留期，默认不自动删除正式结果，但支持教师显式归档和删除；
- 删除操作先生成待删除清单并要求确认，审计记录中保留操作者和对象哈希，不保留已删除正文。



---



# 十六、项目代码结构



```text

course-agent/

├─src/

│  ├─main.ts

│  │

│  ├─core/

│  │  ├─message-bus.ts

│  │  ├─agent-router.ts

│  │  ├─agent-runtime.ts

│  │  ├─tool-registry.ts

│  │  ├─workspace.ts

│  │  └─safe-filesystem.ts

│  │

│  ├─agents/

│  │  ├─material-import/

│  │  │  ├─prompt.ts

│  │  │  └─agent.ts

│  │  ├─course-qa/

│  │  ├─rubric-designer/

│  │  └─assignment-grader/

│  │

│  ├─channels/

│  │  ├─wecom/

│  │  └─web/

│  │

│  ├─tools/

│  │  ├─material/

│  │  ├─knowledge/

│  │  ├─rubric/

│  │  ├─submission/

│  │  └─grading/

│  │

│  ├─services/

│  │  ├─material-service.ts

│  │  ├─knowledge-release-service.ts

│  │  ├─knowledge-service.ts

│  │  ├─rubric-service.ts

│  │  ├─submission-service.ts

│  │  ├─grading-service.ts

│  │  ├─review-service.ts

│  │  ├─session-service.ts

│  │  └─summary-service.ts

│  │

│  ├─queue/

│  │  └─grading-queue.ts

│  │

│  ├─db/

│  │  ├─database.ts

│  │  └─schema.sql

│  │

│  ├─api/

│  │  ├─server.ts

│  │  └─routes/

│  │

│  └─schemas/

│     ├─rubric.ts

│     ├─grading.ts

│     ├─tools.ts

│     ├─messages.ts

│     └─identifiers.ts

│

├─web/

│  └─React管理端

│

├─workspace/

├─tests/

├─package.json

└─config.example.json

```



---



# 十七、Agent工具总表



## 资料导入Agent



1. `scan_source_tree`

2. `read_source_markdown`

3. `read_source_image`

4. `create_knowledge_directory`

5. `write_knowledge_markdown`

6. `copy_knowledge_asset`

7. `move_knowledge_entry`

8. `delete_imported_entry`

9. `inspect_knowledge_tree`

10. `publish_knowledge_import`



## 课程答疑Agent



1. `get_knowledge_root`

2. `list_knowledge_directory`

3. `search_knowledge`

4. `read_markdown_lines`

5. `read_knowledge_image`

6. `web_search`



## 评分表设计Agent



1. `ask_rubric_question`

2. `create_rubric_draft`

3. `read_rubric_draft`

4. `update_rubric_draft`

5. `validate_rubric`

6. `publish_rubric`



## 作业批改Agent



1. `get_submission_tree`

2. `search_submission`

3. `read_submission_lines`

4. `read_submission_image`

5. `ask_grading_question`

6. `create_grading_draft`

7. `read_grading_draft`

8. `update_grading_draft`

9. `validate_grading`

10. `publish_grading`



工具数量较多，但每个Agent只能看到自己需要的工具。



---



# 十八、开发实施顺序

本节以下`Task`是技术工作包参考，不再作为用户验收边界。实际开发顺序和停工门以`docs/superpowers/plans/2026-08-02-course-agent-milestones.md`的M1～M7为唯一依据；技术工作包只能在当前里程碑内部按需执行，不得用于提前铺开后续功能。

### Task 1：加固可信上下文和Windows文件边界

**Files：**

- Modify: `src/core/workspace.ts`
- Modify: `src/schemas/tools.ts`
- Modify: `src/core/tool-registry.ts`
- Create: `src/core/safe-filesystem.ts`
- Create: `src/schemas/identifiers.ts`
- Modify: `tests/core.test.ts`
- Create: `tests/path-security.test.ts`

- [ ] **Step 1：先写失败的路径安全测试**

  测试`..`、绝对路径、UNC、设备路径、ADS、大小写变体、symlink和junction；在Windows权限不允许创建链接时仅跳过对应case，不跳过其他case。

- [ ] **Step 2：运行定向测试并确认当前实现失败**

  Run: `npm test -- --run tests/path-security.test.ts`

  Expected: 当前只使用`path.resolve`的实现至少在reparse point或ADS case失败。

- [ ] **Step 3：实现标识符白名单、真实父路径检查和reparse point拒绝**

  `ToolContext`包含服务端注入的课程、导入、作业、批次和学生身份；`ToolRegistry.execute`校验Agent类型与工具授权；所有文件服务只接收逻辑相对路径。

- [ ] **Step 4：运行核心测试**

  Run: `npm run typecheck && npm test -- --run tests/core.test.ts tests/path-security.test.ts`

  Expected: typecheck通过，所有未被操作系统明确跳过的测试通过。

- [ ] **Step 5：提交单一安全边界变更**

  ```powershell
  git add src/core/workspace.ts src/core/safe-filesystem.ts src/core/tool-registry.ts src/schemas/tools.ts src/schemas/identifiers.ts tests/core.test.ts tests/path-security.test.ts
  git commit -m "feat: harden workspace and trusted tool context"
  ```

### Task 2：完成原子知识发布与Web答疑闭环

**Files：**

- Create: `src/services/material-service.ts`
- Create: `src/services/knowledge-release-service.ts`
- Create: `src/services/knowledge-service.ts`
- Create: `src/tools/material/index.ts`
- Create: `src/tools/knowledge/index.ts`
- Create: `src/agents/material-import/agent.ts`
- Create: `src/agents/course-qa/agent.ts`
- Create: `tests/knowledge-release.test.ts`
- Create: `tests/course-qa.test.ts`

- [ ] **Step 1：写发布中断、回滚和只读版本测试**

  固定fixture包含Markdown、相对图片和断链。测试发布失败时`active.json`不变化，成功时只切换到完整release，答疑服务永远不读取staging。

- [ ] **Step 2：运行测试并确认因服务不存在而失败**

  Run: `npm test -- --run tests/knowledge-release.test.ts tests/course-qa.test.ts`

  Expected: FAIL，提示release和knowledge service尚未实现。

- [ ] **Step 3：实现staging、manifest哈希、原子rename和active指针切换**

  发布文件先写入同目录临时文件并同步，再rename；旧release保持不可变。搜索结果固定返回路径、标题、行号、preview和确定性排序分数。

- [ ] **Step 4：实现最小答疑Agent并验证引用**

  Agent必须读取命中正文后才能回答；固定问题返回的引用路径和行范围必须落在当前active release。

- [ ] **Step 5：运行闭环测试并提交**

  Run: `npm run check`

  Expected: typecheck和全部Vitest测试通过。

### Task 3：完成评分表与单份批改闭环

**Files：**

- Create: `src/schemas/rubric.ts`
- Create: `src/schemas/grading.ts`
- Create: `src/services/rubric-service.ts`
- Create: `src/services/grading-service.ts`
- Create: `src/services/review-service.ts`
- Create: `src/agents/rubric-designer/agent.ts`
- Create: `src/agents/assignment-grader/agent.ts`
- Create: `tests/rubric.test.ts`
- Create: `tests/single-grading.test.ts`

- [ ] **Step 1：写加分区间、精确等级、减分重叠和上下文隔离测试**

  加分制验证`selectedLevelId`与分数区间一致；减分制验证`overlapGroup`；两个批次使用相同`studentId`时结果仍严格隔离。

- [ ] **Step 2：运行测试并确认Schema和Service缺失**

  Run: `npm test -- --run tests/rubric.test.ts tests/single-grading.test.ts`

- [ ] **Step 3：实现最小Schema、版本Patch和确定性校验**

  Rubric发布后不可变；总分、扣分、总体置信度、Review规则和结果哈希均由程序计算。

- [ ] **Step 4：实现原子JSON/Markdown发布和审计事件追加**

  先保存Agent原始草稿，再保存程序校验后的正式结果；教师修改追加JSONL事件，不覆盖历史。

- [ ] **Step 5：运行测试并提交**

  Run: `npm run check`

  Expected: 所有测试通过，重复执行同一幂等键只产生一份正式结果。

### Task 4：完成可恢复批处理和单写者CSV

**Files：**

- Create: `src/db/schema.sql`
- Create: `src/db/database.ts`
- Create: `src/queue/grading-queue.ts`
- Create: `src/services/summary-service.ts`
- Create: `tests/grading-recovery.test.ts`
- Create: `tests/grading-concurrency.test.ts`

- [ ] **Step 1：写状态转换、租约过期和崩溃注入测试**

  分别在模型返回后、JSON rename后、数据库提交前注入崩溃；重启后必须得到唯一结果，且不得在已有有效结果时再次调用模型。

- [ ] **Step 2：运行定向测试并确认失败**

  Run: `npm test -- --run tests/grading-recovery.test.ts tests/grading-concurrency.test.ts`

- [ ] **Step 3：实现迁移、原子claim、续租、协调和有上限重试**

  所有状态转换使用事务和条件更新；`UNIQUE(batch_id,student_id)`与幂等键同时生效。

- [ ] **Step 4：实现SummaryService单写者聚合**

  120个job只写独立结果；聚合器按studentId稳定排序生成CSV临时文件并原子替换正式文件。

- [ ] **Step 5：运行120份fixture和恢复测试**

  Run: `npm run check`

  Expected: 正式JSON、Markdown各120份，studentId无重复，CSV数据行120行，数据库计数与文件重算一致。

### Task 5：完成最小管理端和教师Review

**Files：**

- Create: `src/api/server.ts`
- Create: `src/api/routes/materials.ts`
- Create: `src/api/routes/rubrics.ts`
- Create: `src/api/routes/grading.ts`
- Create: `src/api/routes/reviews.ts`
- Create: `web/package.json`
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`
- Create: `web/src/pages/MaterialImportPage.tsx`
- Create: `web/src/pages/KnowledgePage.tsx`
- Create: `web/src/pages/RubricPage.tsx`
- Create: `web/src/pages/GradingBatchPage.tsx`
- Create: `web/src/pages/ReviewPage.tsx`
- Create: `tests/api.test.ts`

- [ ] **Step 1：为课程发布、评分表发布、批次控制和Review Patch写API契约测试**

- [ ] **Step 2：实现只绑定loopback地址的Fastify API和本地身份保护**

  默认只监听`127.0.0.1`；任何状态修改均要求CSRF防护和服务端生成的会话令牌。

- [ ] **Step 3：实现完成闭环所需的五个最小页面**

  页面只调用API，不直接访问Workspace；Review页面始终显示证据、置信度、来源哈希和审计状态。

- [ ] **Step 4：执行API、前端构建和全量测试**

  Run: `npm run check && npm run build`

  Expected: 测试和生产构建全部通过。

### Task 6：先验证再实现企业微信

**Files：**

- Create: `docs/wecom-connectivity-spike.md`
- Create: `src/channels/wecom/adapter.ts`
- Create: `src/channels/wecom/dedup-store.ts`
- Create: `tests/wecom-channel.test.ts`

- [ ] **Step 1：完成目标组织内的连接验证并记录接入模式、权限和网络前提**

- [ ] **Step 2：写验签、解密、重复事件、快速确认、限流重试和长消息拆分测试**

- [ ] **Step 3：实现Channel适配器，不向Agent暴露凭据或任意课程ID**

- [ ] **Step 4：运行Channel测试和人工端到端检查**

  Run: `npm test -- --run tests/wecom-channel.test.ts`

  Expected: 自动化case全部通过；私聊和群聊各完成一次真实问答，重复投递只生成一次Agent请求。

### Task 7：执行最终质量验收

**Files：**

- Create: `tests/fixtures/acceptance/README.md`
- Create: `tests/acceptance/knowledge-qa.test.ts`
- Create: `tests/acceptance/grading-quality.test.ts`
- Create: `tests/acceptance/batch-recovery.test.ts`
- Create: `docs/acceptance-report.md`
- Modify: `README.md`

- [ ] **Step 1：冻结验收fixture、模型配置、Prompt版本和预算**

- [ ] **Step 2：运行第十九节定义的检索、批改、恢复、安全和并发指标**

- [ ] **Step 3：把原始统计、失败样本和环境信息写入验收报告**

- [ ] **Step 4：运行最终检查**

  Run: `npm run check && npm run build`

  Expected: 命令零退出，所有阻断级指标达标；未达标项不得以“已知问题”形式绕过MVP验收。

功能工作包5（企业微信）只能在M1～M6被用户验收后执行；工作包10贯穿每个里程碑，而不是集中到最后补测试。



## 阶段1：项目核心框架



- 初始化TypeScript项目；

- 接入Pi SDK；

- 实现Agent Runtime；

- 实现Tool Registry；

- 实现Workspace路径限制；

- 实现Message Bus和Agent Router；

- 实现日志系统。



## 阶段2：资料导入Agent



- 实现原始目录扫描；

- 实现Markdown行读取；

- 实现图片读取；

- 实现受控目录创建；

- 实现文件写入和图片复制；

- 实现移动、覆盖和删除；

- 实现导入校验；

- 实现知识库发布。



## 阶段3：知识库查询层



- 实现课程根目录查看；

- 实现目录逐级浏览；

- 实现文件标题和行数读取；

- 实现路径限定搜索；

- 实现全局搜索；

- 实现搜索排序和分页；

- 实现Markdown行范围读取；

- 实现图片访问。



## 阶段4：课程答疑Agent



- 编写答疑Prompt；

- 注册只读知识工具；

- 注册联网查询工具；

- 实现课程资料引用；

- 实现多结果搜索策略；

- 实现资料不足拒答；

- 实现会话记录。



## 阶段5：企业微信接入



- 实现WeCom Channel；

- 支持私聊；

- 支持群聊`@机器人`；

- 配置群与课程映射；

- 处理长消息和错误回复。



## 阶段6：评分表设计Agent



- 定义Rubric Schema；

- 实现加分制；

- 实现减分制；

- 实现四选项提问工具；

- 实现草稿创建和读取；

- 实现Patch修改；

- 实现总分和重复规则校验；

- 实现版本发布。



## 阶段7：单份作业批改



- 实现报告目录浏览；

- 实现报告搜索；

- 实现行范围读取；

- 实现图片读取；

- 实现批改提问；

- 实现批改草稿；

- 实现批改修改；

- 实现评分校验；

- 实现置信度结构；

- 实现Review标记；

- 实现JSON和Markdown输出。



## 阶段8：批量批改



- 建立SQLite任务表；

- 接入p-queue；

- 配置并发数；

- 实现任务状态；

- 实现失败重试；

- 实现程序重启恢复；

- 实现等待教师回答状态；

- 生成班级CSV。



## 阶段9：管理前端



- 资料导入页；

- 知识库浏览页；

- 评分表设计页；

- 批改任务页；

- 教师Review页；

- 结果导出功能。



## 阶段10：测试与验收



- Agent工具权限测试；

- 路径穿越测试；

- Markdown拆分测试；

- 搜索多结果测试；

- 行范围限制测试；

- 评分表冲突测试；

- 批改结果校验测试；

- 置信度Review规则测试；

- 30～120份批量任务测试；

- 企业微信私聊和群聊测试。



---



# 十九、验收标准



## 19.1 资料导入Agent



- 能读取未经整理的Markdown；

- 能查看Markdown图片；

- 能根据内容规划目录；

- 能拆分并写入多个知识文件；

- 能复制图片并保持链接有效；

- 能修正自己已经生成的错误目录；

- 不能访问Workspace外路径；

- 发布前能够完成完整性校验。



## 19.2 课程答疑Agent



- 能逐级浏览知识库目录；

- 能在指定路径搜索；

- 能执行全局搜索；

- 多结果时能够继续筛选和读取；

- 每次最多读取配置规定的行数；

- 能引用文件、标题和行范围；

- 能查看课程图片；

- 只有知识库只读权限；

- 本地资料不足时可以联网查询；

- 能区分课程资料和互联网内容。



## 19.3 评分表设计Agent



- 支持加分制和减分制；

- 遇到关键歧义能够提出问题；

- 每个问题默认提供三个说明选项和一个自定义选项；

- 能创建和修改评分表草稿；

- 修改使用版本控制；

- 能发现明显重复评分和重复扣分；

- 总分由程序校验；

- 发布后形成不可变版本。



## 19.4 作业批改Agent



- 每名学生使用独立会话；

- 只能读取当前学生目录；

- 能搜索和分段读取报告；

- 能查看报告图片；

- 遇到关键不确定内容能够询问教师；

- 能创建和修改批改草稿；

- 每项评分包含理由和证据；

- 每项评分包含置信度；

- 程序计算总体置信度；

- 低置信度结果自动进入Review；

- 总分由程序计算；

- 不允许修改学生作业。



## 19.5 批量批改



- 能批改30～120份Markdown报告；

- 并发数量可配置；

- 单份失败不影响其他作业；

- 等待教师回答的任务不阻塞整个批次；

- 程序重启后可恢复任务；

- 能导出JSON、Markdown和CSV。



## 19.6 企业微信



- 支持私聊答疑；

- 支持群内`@机器人`；

- 不同群能够绑定不同课程；

- 企业微信层不直接访问知识库文件。

## 19.7 统一可量化验收门槛

所有验收使用冻结fixture、固定Prompt版本和固定模型配置，报告必须包含运行环境、耗时、模型调用次数和失败样本，不能只记录“通过”。

### 安全与权限

- 路径安全case覆盖`..`、绝对路径、UNC、设备路径、ADS、symlink和junction，越权读取或写入成功次数必须为0；
- 任意Agent尝试切换`courseId`、`batchId`或`studentId`均返回授权错误，跨任务数据泄漏次数必须为0；
- 日志、API响应和前端构建产物中不得出现WeCom密钥、模型密钥或完整学生报告正文。

### 知识导入与答疑

- 使用至少3门课程、每门至少20个Markdown文件的固定资料集；导入后断链、丢失图片、空发布版本均为0；
- 在发布过程中注入10个不同失败点，`active.json`始终指向完整可校验版本；
- 固定30个可回答问题和10个资料不足问题：可回答问题的引用路径及行号正确率不低于95%，资料不足问题不得编造本地引用；
- 同一查询、同一索引版本的搜索排序必须确定性一致。

### 评分与Review

- 使用至少20份由两名教师独立评分并形成共识分的样本；按100分制归一化后，系统总分与共识分的平均绝对误差不高于5分、绝对误差超过10分的样本比例不高于10%、逐项得分落在教师共识允许区间内的比例不低于85%；若课程负责人要求更严格阈值，只能收紧不能放宽；
- 所有正式分数均可由Rubric和criterion/rule结果重新计算；不合法区间分、重复扣分和总分不一致数量为0；
- 所有非满分项、触发的减分规则及低置信度项必须有有效证据或明确的“证据不足”标记；
- 教师修改前后哈希和Patch完整，审计事件丢失数为0。

### 批量、崩溃恢复与性能

- 固定120份作业、并发4执行；最终必须恰好生成120份JSON和120份Markdown，CSV恰好120条数据行；
- 在模型返回后、结果rename后、SQLite提交前分别强制崩溃，恢复后重复正式结果数为0，已有有效结果的额外模型调用数为0；
- 单份失败不阻塞其他任务，等待教师回答不占用并发槽；
- 批次完成计数、Review计数、终态job数和根据结果文件重算值完全一致；
- 性能验收记录总耗时、P50/P95单份耗时、模型调用量和估算费用，具体预算在首次10份校准运行后冻结，再运行120份正式验收。

### 企业微信

- 私聊和群聊各至少完成10次端到端问答；
- 同一消息重复投递3次只产生1次Agent调用；
- 无效签名、过期时间戳、未知群和未知用户全部被拒绝；
- 超时、限流和5xx重试均不超过配置上限，长消息拆分后引用不丢失。



---



# 二十、MVP默认参数



```json

{

  "knowledgeReadMaxLines":100,

  "sourceReadMaxLines":200,

  "searchDefaultResults":5,

  "searchMaxResults":10,

  "gradingConcurrency":4,

  "gradingMaxAttempts":3,

  "gradingLeaseSeconds":300,

  "maxFileBytes":10485760,

  "maxImageBytes":20971520,

  "maxTreeDepth":12,

  "maxFilesPerImport":2000,

  "maxImportBytes":1073741824,

  "highConfidenceThreshold":0.8,

  "lowConfidenceThreshold":0.6,

  "overallReviewThreshold":0.7,

  "passingScoreReviewRange":3,

  "sessionHistoryMessages":20,

  "wecomDedupRetentionHours":24

}

```



---



# 二十一、MVP明确排除范围



- RAG和向量检索；

- Embedding；

- PDF、DOCX解析；

- OCR；

- 自动图片文字索引；

- 作业查重；

- 抄袭判断；

- 代码运行；

- 分布式Worker；

- Redis；

- Docker部署；

- Linux服务器；

- 多租户权限；

- 教务系统集成；

- 自动发布正式成绩；

- Agent自由执行Shell；

- Agent任意文件读写；

- 多Agent自主协商和任务规划。



---



# 二十二、主要风险与处理方式



## 搜索召回不足



处理：



- 支持目录逐级浏览；

- 支持标题、路径和正文搜索；

- 允许Agent修改关键词；

- 允许指定路径缩小范围；

- 保留未来替换为RAG的接口边界。



## 资料导入Agent错误拆分



处理：



- 导入前预览；

- 只在草稿目录中操作；

- 发布前校验；

- 支持移动、覆盖和删除；

- 发布后保留原始资料。



## 模型给出虚假置信度



处理：



- 要求给出置信度理由；

- 总体置信度由程序计算；

- 使用确定性Review规则；

- 置信度只用于排序和辅助复核；

- 不将置信度视为真实概率。



## 批改标准不稳定



处理：



- 评分表版本冻结；

- 批量批改前使用少量样本校准；

- 所有作业使用同一评分表和Prompt版本；

- 保存人工修改记录。



## Agent频繁提问



处理：



- Prompt要求只有关键歧义才提问；

- 可通过合理默认规则解决的问题不提问；

- 批量任务中的提问进入等待队列；

- 提供教师“对本批次应用相同答案”的选项。

## 正式知识库出现半发布状态

处理：

- Agent只写staging，答疑只读active release；
- 发布前比较manifest哈希并持有课程发布锁；
- release不可变，`active.json`使用同目录临时文件原子替换；
- 发布失败保持旧active版本，提供显式回滚；
- 在发布各步骤执行故障注入测试。

## 文件结果与SQLite状态不一致

处理：

- 每个job使用稳定幂等键和数据库唯一约束；
- 独立结果先原子落盘，再提交数据库终态；
- 启动时使用resultHash执行协调，不盲目重跑`running`任务；
- CSV由正式JSON单写者重建；
- 缓存计数可以从job表和结果文件重新计算。

## Windows路径边界被链接绕过

处理：

- 拒绝绝对、UNC、设备和ADS路径；
- 逐段检查并拒绝symlink、junction及其他reparse point；
- 标识符使用字符白名单；
- 安全测试覆盖路径替换竞争，不只测试`..`。

## 企业微信无法稳定连接本机

处理：

- 在开发正式Channel前完成连接技术验证；
- 明确公网入口或长连接等网络前提；
- 实现验签、去重、快速确认、重试和脱敏；
- 无法满足目标环境时暂停MVP Integration，不反向污染MVP Core架构。

## MVP范围扩张

处理：

- 以第0.1节七个纵向里程碑及其详细里程碑计划为唯一实施顺序；
- 每个里程碑必须形成可运行软件并达到第19.7节指标；
- 新格式、新Channel、新模型Provider和教务集成都进入后续版本；
- 企业微信在本地核心闭环完成后实施。



---



# 二十三、最终MVP交付物

以下1、2、4～10属于`MVP Core`；第3项属于`MVP Integration`，必须在Core验收完成且企业微信技术验证通过后交付。



1. Windows本地可运行的课程辅助智能体程序；

2. React本地管理后台；

3. 通过验签、去重、重试和端到端测试的企业微信答疑机器人；

4. Markdown资料导入和结构化知识库功能；

5. 支持加分制和减分制的评分表设计功能；

6. 支持30～120份报告、具备租约、幂等和崩溃恢复能力的并发批改功能；

7. 带评分证据、理由和置信度的批改结果；

8. 教师低置信度Review界面；

9. JSON、Markdown和CSV导出；

10. 项目部署说明、使用说明、威胁模型、数据保留说明和包含原始指标的验收报告。



## 最终架构定位



该MVP不是一个复杂教学平台，而是一套轻量、可解释、权限边界清晰的本地Agent系统：



```text

资料导入Agent

负责整理知识



课程答疑Agent

负责查阅知识



评分表设计Agent

负责定义评分规则



作业批改Agent

负责执行规则并报告不确定性



教师

负责最终确认和Review

```
