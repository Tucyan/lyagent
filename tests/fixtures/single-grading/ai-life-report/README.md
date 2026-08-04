# 单份批改验收夹具

三份学生报告由同一份规范内容生成，姓名、学号与正文均为合成数据。`rubric-v1.json` 是用户提供的冻结减分制评分表原件，哈希为 `949736269815dc30601a22a1fb1af84aee4752b11166685eb278e40becec4ae7`。

报告完整覆盖背景、成果、输入提示词、全部实现步骤、问题讨论和改进方案，但明确没有保留系统输出。预期唯一触发项为 `process_no_output`，程序计算预期总分为 `85/100`；真实模型校准允许置信度和理由措辞变化，不允许遗漏全部 16 条规则的判断。

重新生成：

```powershell
& 'C:\Users\ALmerb\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' scripts/generate_single_grading_fixtures.py
```
