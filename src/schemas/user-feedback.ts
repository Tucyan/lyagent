/** Program-authored messages; provider errors and paths are never interpolated. */
const errors: Record<string, string> = {
  NETWORK_ERROR: "无法连接本地服务。请确认启动窗口仍在运行，再刷新页面重试；不要重复提交正在处理的任务。",
  SETUP_REQUIRED: "请先打开“模型设置”，填写主模型信息并测试连接，再保存设置。",
  MODEL_NOT_CONFIGURED: "请打开“模型设置”，配置并测试主模型后重试。",
  GRADING_MODEL_NOT_CONFIGURED: "请打开“模型设置”，配置主模型后再开始批改。",
  SUBMISSION_TITLE_MODEL_NOT_CONFIGURED: "无法自动识别作业名称。请手动填写作业名称，或配置主模型后重试识别。",
  ACTIVE_RELEASE_NOT_FOUND: "当前课程没有可用的已发布资料。请到“课程资料库”导入资料并点击“发布并启用”，再新建答疑会话。",
  SESSION_RELEASE_CHANGED: "课程资料已更新。请点击“新建会话”使用当前资料；原会话记录仍然保留。",
  KNOWLEDGE_ERROR: "课程资料未通过校验。请到“课程资料库”选择可用的历史版本，或重新导入并发布资料。",
  CONFLICT: "资料草稿已更新。请先保留当前编辑内容，再重新打开草稿核对最新版本后保存。",
  RUBRIC_CONFLICT: "评分表草稿已更新。请先保留当前编辑内容，再重新打开会话核对最新版本后保存。",
  RUBRIC_COURSE_BINDING_ERROR: "请先选择课程；如果列表为空，请先创建课程，再创建评分表会话。",
  RUBRIC_VALIDATION_FAILED: "评分表尚不能保存或冻结。请点击“人工编辑”，按下面的说明修正后重新保存并校验。",
  RUBRIC_STATE_ERROR: "当前评分表暂不能执行此操作。请重新打开会话查看状态；要修改冻结版本，请先点击“创建修订”。",
  RUBRIC_NOT_FOUND: "评分表会话已不存在。请选择其他会话，或创建新的评分表。",
  GRADING_CONFLICT: "当前会话状态已变化或仍有任务在处理。请等待任务结束并重新打开会话；已确认内容需要通过“创建修订”修改，批次成员请在批量工作台操作。",
  GRADING_BATCH_CONFLICT: "批次状态已变化。请刷新详情并查看当前状态；运行中的任务请先暂停，再进行修改。",
  GRADING_BATCH_ERROR: "批次操作未完成。请检查每份报告的状态，补齐身份信息并处理失败项后再提交。",
  GRADING_RESULT_INVALID: "评分修改未通过校验。请检查分数是否在评分表允许范围内、是否选择对应等级，并填写评分理由后再保存。",
  GRADING_ERROR: "批改操作未完成。请重新打开会话查看转换、作业名称和复核状态；确认成绩前请核对复核原因并填写备注。",
  RESULT_NOT_CONFIRMED: "成绩尚未正式确认。请打开 Review 核对评分，填写复核备注并确认后，再导出正式成绩。",
  VALIDATION_ERROR: "请检查以下输入后重试；当前填写的内容仍可继续修改。",
  MULTIPART_FILE_TOO_LARGE: "文件过大。请将每个文件控制在 10 MiB 内，并将附件总大小控制在 50 MiB 内后重新选择。",
  MULTIPART_FILE_COUNT_EXCEEDED: "附件过多。请每份报告最多选择 100 个附件，再重新上传。",
  STUDENT_IDENTITY_REQUIRED: "请同时填写学生姓名与学号，或同时留空让系统识别文件名，再创建会话。",
  UNSUPPORTED_SUBMISSION_TYPE: "文件格式不支持。请将旧版 Word 文件另存为 DOCX 或 PDF 后上传，也可上传 Markdown、PPTX 或受支持图片。",
  CONVERTER_NOT_CONFIGURED: "转换服务尚未就绪。请使用发布包启动器启动并等待就绪，之后点击“重试转换”；也可先上传 Markdown 报告。",
  AGENT_TIMEOUT: "模型处理超时。请重新打开会话检查是否已有结果；若没有，请缩短本次请求后重试。",
  AGENT_TURN_LIMIT: "本次模型处理尚未完成。请检查已保存内容，将请求拆成较小步骤后重试。",
  AGENT_TOOL_CALL_LIMIT: "本次模型处理尚未完成。请检查已保存内容，将请求拆成较小步骤后重试。",
  QA_FAILED: "这次答疑未能完成。请检查“模型设置”的连接测试，再重新发送问题；此前的记录仍可查看。",
  RUBRIC_DESIGN_FAILED: "评分表设计未能完成。请检查模型连接后重新发送请求，也可点击“人工编辑”继续修改已有草稿。",
  GRADING_RUN_INTERRUPTED: "上次批改因服务重启而中断。请核对现有草稿，再点击“重新批改”继续。",
  GRADING_RUN_FAILED: "这次批改未能完成。请检查模型连接并核对报告后重试，已有草稿可继续人工复核。",
  SUBMISSION_TITLE_FAILED: "名称识别未完成。请手动填写作业名称后继续，或点击“重试识别”。",
  SUBMISSION_TITLE_MODEL_FAILED: "名称识别未完成。请手动填写作业名称后继续，或点击“重试识别”。",
  CONVERTER_UNAVAILABLE: "转换服务暂时不可用，原始报告已保留。请确认启动器和转换服务就绪后点击“重试转换”，也可上传 Markdown 报告。",
  CONVERTER_TIMEOUT: "转换等待超时，原始报告已保留。请确认转换服务就绪后点击“重试转换”，也可将报告另存为 Markdown 后上传。",
  FORBIDDEN: "当前页面无法执行此操作。请使用启动器打开的本地页面，刷新后重试。",
};
export function userErrorMessage(code: string): string {
  return errors[code] ?? (code === "HTTP_404" || code.endsWith("_NOT_FOUND")
    ? "内容已不存在。请返回列表重新选择，或重新创建。"
    : code === "HTTP_503" ? "本地服务暂时不可用。请确认启动器已就绪，再刷新页面重试。"
    : "操作未完成。请保留当前内容后重试；若仍失败，请重新启动应用并再次打开该页面。");
}
const fields: Record<string, string> = {
  name: "名称", title: "标题", courseId: "课程", studentName: "学生姓名", studentNumber: "学生学号",
  sessionIds: "作业选择", file: "报告文件", assetManifest: "附件目录", totalScore: "评分表总分",
  requirements: "作业要求", sources: "参考资料", reviewNote: "复核备注", acknowledgedReasons: "复核原因",
  primary: "主模型设置", vision: "视觉模型设置", modelId: "模型名称", baseUrl: "服务地址",
  apiKey: "模型密钥", rubric: "评分表", criteria: "评分项目", rules: "扣分规则", levels: "评分等级",
  maxScore: "分值上限", score: "得分", minScore: "等级最低分", maxDeduction: "最大扣分", deduction: "扣分值",
};
export function inputIssueMessage(path = ""): string {
  const parts = path.split(".");
  const label = [...parts].reverse().map((part) => fields[part]).find(Boolean) ?? "输入内容";
  if (parts.includes("studentName") || parts.includes("studentNumber")) return `${label}：请同时填写学生姓名与学号，或同时留空。`;
  if (parts.includes("baseUrl")) return `${label}：请填写 HTTPS 服务地址；本地服务可用环回 HTTP 地址，不要在地址中加入密钥或查询参数。`;
  return `${label}：请检查是否已填写、选择，且符合页面标注的范围或格式。`;
}
const rubricProblems: Record<string, string> = {
  CRITERIA_TOTAL_MISMATCH: "评分项目的分值上限之和必须等于评分表总分。请在“人工编辑”中调整各项分值后再保存。",
  LEVELS_REQUIRED: "此评分项目需要评分等级。请在“人工编辑”中添加等级、分值和达成条件。",
  CONTINUOUS_WITHOUT_ANCHORS: "此项目尚无评分锚点。建议补充等级说明，便于教师一致评分；确认后也可以冻结。",
  LEVEL_OUT_OF_RANGE: "等级分值超出范围。请确保最低分不大于最高分，且最高分不超过项目分值上限。",
  EXACT_LEVEL_NOT_EXACT: "固定等级需要确定分值。请将等级最低分和最高分设为相同值。",
  RANGE_NOT_COVERED: "等级未覆盖完整分值范围。请让最低等级从 0 分开始，最高等级达到项目分值上限。",
  RANGE_GAP_OR_OVERLAP: "等级分值有空档或重叠。请按 0.01 分精度连续划分，例如 0–4.99、5–10。",
  DUPLICATE_ID: "项目或规则标识重复。请在“人工编辑”中为每一项设置不同标识。",
  DUPLICATE_OVERLAP_GROUP: "重叠规则组重复。请保留一个组，或为不同组设置不同标识。",
  UNKNOWN_OVERLAP_GROUP: "规则引用的分组不存在。请添加对应组，或取消该规则的分组。",
  DEDUCTION_EXCEEDS_MAXIMUM: "单次扣分超过最大扣分。请减小单次扣分，或调整上限。",
  BONUS_EXCEEDS_MAXIMUM: "单次加分超过最大加分。请减小单次加分，或调整上限。",
  RANGE_DEDUCTION_MUST_BE_ONCE: "区间扣分需要一次性规则。请将触发次数改为“仅一次”。",
};
export function rubricProblemMessage(problem: { code: string; path?: string }): string {
  return rubricProblems[problem.code] ?? inputIssueMessage(problem.path);
}
export function reviewReasonLabel(reason: string): string {
  return ({
    LOW_CONFIDENCE: "模型把握不足：请核对对应项目的评分分析和作业表现。",
    EVIDENCE_INSUFFICIENT: "评分依据不足：请补充或修正评分分析，确认分数有依据。",
    CONVERSION_WARNING: "报告转换需要核对：请对照原始报告检查正文、表格和图片是否完整。",
    NEAR_PASSING_BOUNDARY: "成绩接近及格线：请重点核对影响通过与否的评分项目。",
  } as Record<string, string>)[reason] ?? "需要教师复核：请核对报告与评分表，并在备注中记录判断。";
}
