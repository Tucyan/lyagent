# M1：课程资料库导入、发布与浏览验收

## 启动

```powershell
@'
{
  "deepseekApiKey": "<your-key>"
}
'@ | Set-Content -LiteralPath workspace/config/app.json -Encoding utf8
npm run build
npm run start
```

打开 <http://127.0.0.1:3000>。

## 验收步骤

1. 创建一门测试课程。
2. 选择`知识库原始markdown数据`目录，确认系统识别当前的 5 个 Markdown 文件（3 份 PPT、课程大纲和图片文字处理报告）。
3. 等待草稿生成，确认页面自动进入“修订草稿”，左侧可搜索目录，右侧同时显示Markdown源文和实时渲染预览。
4. 修改一篇Markdown正文并保存，再重命名该文件，确认修改后的正文仍然保留；刷新页面，确认草稿可以恢复。
5. 点击“发布并启用”，确认页面自动回到“当前版本”，显示可读版本号、当前使用标记和只读资料预览。
6. 点击“创建修订”，确认新草稿标明来源版本；修改草稿期间回到“当前版本”，确认正式内容仍保持不变。
7. 发布修订，在“版本记录”中确认新旧版本都可预览，UUID只作为次要信息显示。
8. 将旧版本“切换为当前”，确认新建答疑会话使用旧版本，而已有会话保留原release记录。
9. 查看`GET /api/system/model`，确认只显示 Provider、模型和配置状态，不显示密钥。

## 自动化证据

- `tests/path-security.test.ts`：路径越界、Windows 路径形式、受控写入、reparse point。
- `tests/knowledge-release.test.ts`：完整覆盖、不可变发布、断链拒绝、active指针、修订隔离、正文保存及结构编辑内容保留。
- `tests/material-agent.test.ts`：Pi 假 Provider 的单工具资料规划契约。
- `tests/material-import-api.test.ts`：课程、导入、发布版预览、修订创建、正文保存、发布和冲突响应。
- `tests/knowledge-library-model.test.ts`：发布记录到可读`vN`标签的稳定映射。

## 开发验证记录

- 2026-08-02：使用当前`知识库原始markdown数据`在临时 Workspace 运行 DeepSeek。识别 5 个 Markdown、221 个章节，生成 17 个草稿文档；完整覆盖校验通过。临时数据已删除，未发布为正式课程版本。
- 2026-08-02：`npm run check`通过（5 个测试文件、16 项测试）；`npm run build`通过。
- 2026-08-03：知识库页面重构后`npm run check`通过（20 个测试文件、55 项测试），`npm run build`通过；浏览器验证当前版预览、恢复草稿、源文/实时预览、版本记录及760px窄屏无水平溢出，控制台无警告或错误。

## 用户结论

- 状态：accepted
- 测试人：
- 测试日期：2026-08-02
- 备注：用户确认 M1 开发与已发布版本检查完成。
