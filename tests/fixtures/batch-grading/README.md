# M5 batch-grading fixtures

All reports are deterministic synthetic data and contain no real student identity or coursework.

Generate 30–120 Markdown reports for API or browser acceptance:

```powershell
npx tsx scripts/generate-batch-grading-fixtures.ts tests/fixtures/batch-grading/generated 30
```

File names follow `{studentNumber}_{syntheticName}_{topic}.md`, allowing the existing controlled identity resolver to identify each student. Generated files are intentionally not committed; the generator is the fixture source of truth.

