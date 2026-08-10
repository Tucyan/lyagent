from __future__ import annotations

from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Image as PdfImage
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "tests" / "fixtures" / "release-acceptance"
BLUE = RGBColor(0x2E, 0x74, 0xB5)
DARK_BLUE = RGBColor(0x1F, 0x4D, 0x78)


def set_cell_width(cell, width_dxa: int) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_w = tc_pr.find(qn("w:tcW"))
    if tc_w is None:
        tc_w = OxmlElement("w:tcW")
        tc_pr.append(tc_w)
    tc_w.set(qn("w:w"), str(width_dxa))
    tc_w.set(qn("w:type"), "dxa")


def set_table_geometry(table, widths: list[int]) -> None:
    table.autofit = False
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    tbl_pr = table._tbl.tblPr
    tbl_w = tbl_pr.find(qn("w:tblW"))
    if tbl_w is None:
        tbl_w = OxmlElement("w:tblW")
        tbl_pr.append(tbl_w)
    tbl_w.set(qn("w:w"), str(sum(widths)))
    tbl_w.set(qn("w:type"), "dxa")
    tbl_ind = tbl_pr.find(qn("w:tblInd"))
    if tbl_ind is None:
        tbl_ind = OxmlElement("w:tblInd")
        tbl_pr.append(tbl_ind)
    tbl_ind.set(qn("w:w"), "120")
    tbl_ind.set(qn("w:type"), "dxa")
    grid = table._tbl.tblGrid
    for child in list(grid):
        grid.remove(child)
    for width in widths:
        col = OxmlElement("w:gridCol")
        col.set(qn("w:w"), str(width))
        grid.append(col)
    for row in table.rows:
        for index, cell in enumerate(row.cells):
            set_cell_width(cell, widths[index])
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            tc_pr = cell._tc.get_or_add_tcPr()
            margins = tc_pr.find(qn("w:tcMar"))
            if margins is None:
                margins = OxmlElement("w:tcMar")
                tc_pr.append(margins)
            for edge, value in (("top", 80), ("bottom", 80), ("start", 120), ("end", 120)):
                node = margins.find(qn(f"w:{edge}"))
                if node is None:
                    node = OxmlElement(f"w:{edge}")
                    margins.append(node)
                node.set(qn("w:w"), str(value))
                node.set(qn("w:type"), "dxa")


def font(run, *, size: float = 11, bold: bool = False, color: RGBColor | None = None) -> None:
    run.font.name = "Calibri"
    run._element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:ascii"), "Calibri")
    run._element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:hAnsi"), "Calibri")
    run.font.size = Pt(size)
    run.bold = bold
    if color is not None:
        run.font.color.rgb = color


def configure_styles(doc: Document) -> None:
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.10
    for name, size, color, before, after in (
        ("Heading 1", 16, BLUE, 16, 8),
        ("Heading 2", 13, BLUE, 12, 6),
        ("Heading 3", 12, DARK_BLUE, 8, 4),
    ):
        style = doc.styles[name]
        style.font.name = "Calibri"
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = color
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
    for name in ("List Bullet", "List Number"):
        style = doc.styles[name]
        style.font.name = "Calibri"
        style.font.size = Pt(11)
        style.paragraph_format.left_indent = Inches(0.5)
        style.paragraph_format.first_line_indent = Inches(-0.25)
        style.paragraph_format.space_after = Pt(8)
        style.paragraph_format.line_spacing = 1.167


def create_chart(path: Path) -> None:
    image = Image.new("RGB", (1200, 620), "white")
    draw = ImageDraw.Draw(image)
    cjk_font = r"C:\Windows\Fonts\simhei.ttf"
    font_large = ImageFont.truetype(cjk_font, 42)
    font = ImageFont.truetype(cjk_font, 30)
    draw.text((70, 35), "校园 AI 工具使用频率（模拟调查，n=120）", fill="#16324F", font=font_large)
    labels = [("每周使用", 78, "#2E74B5"), ("偶尔使用", 31, "#66A3D2"), ("从未使用", 11, "#A9B4BF")]
    for index, (label, value, color) in enumerate(labels):
        y = 160 + index * 130
        draw.text((70, y + 18), label, fill="#1F2933", font=font)
        draw.rounded_rectangle((320, y, 320 + value * 9, y + 70), radius=14, fill=color)
        draw.text((340 + value * 9, y + 18), f"{value}%", fill="#1F2933", font=font)
    image.save(path, format="PNG", optimize=True)


def create_docx(path: Path, chart_path: Path) -> None:
    doc = Document()
    section = doc.sections[0]
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = section.bottom_margin = Inches(1)
    section.left_margin = section.right_margin = Inches(1)
    section.header_distance = section.footer_distance = Inches(0.492)
    configure_styles(doc)

    header = section.header.paragraphs[0]
    header.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    header_run = header.add_run("课程作业验收样例 | 2026")
    font(header_run, size=9, color=RGBColor(0x66, 0x66, 0x66))
    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    footer_run = footer.add_run("Course Agent Release Acceptance Fixture")
    font(footer_run, size=8.5, color=RGBColor(0x77, 0x77, 0x77))

    title = doc.add_paragraph()
    title.paragraph_format.space_after = Pt(4)
    title_run = title.add_run("人工智能与校园生活调研报告")
    font(title_run, size=23, bold=True)
    subtitle = doc.add_paragraph()
    subtitle.paragraph_format.space_after = Pt(14)
    subtitle_run = subtitle.add_run("基于 120 份模拟问卷的学习支持与风险分析")
    font(subtitle_run, size=13.5, color=RGBColor(0x44, 0x44, 0x44))
    for label, value in (("学生", "张明（模拟）"), ("学号", "20260001"), ("课程", "人工智能导论"), ("日期", "2026-08-06")):
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(2)
        font(p.add_run(f"{label}: "), bold=True)
        font(p.add_run(value))

    doc.add_heading("摘要", level=1)
    doc.add_paragraph("本报告使用模拟问卷数据分析生成式人工智能在校园学习中的使用情况。结果显示，多数学生会在检索资料、梳理提纲和检查语言表达时使用相关工具，但对事实核验、隐私与引用规范的理解仍不充分。")

    doc.add_heading("1. 研究方法", level=1)
    for text in ("样本为 120 份匿名模拟问卷。", "问题覆盖使用频率、主要用途、收益感知和风险意识。", "百分比经四舍五入，合计可能存在 1 个百分点误差。"):
        doc.add_paragraph(text, style="List Bullet")

    doc.add_heading("2. 主要发现", level=1)
    doc.add_picture(str(chart_path), width=Inches(6.15))
    caption = doc.add_paragraph("图 1  校园 AI 工具使用频率（模拟数据）")
    caption.alignment = WD_ALIGN_PARAGRAPH.CENTER
    caption.paragraph_format.space_after = Pt(10)
    for run in caption.runs:
        font(run, size=9.5, color=RGBColor(0x55, 0x55, 0x55))

    table = doc.add_table(rows=1, cols=3)
    table.style = "Table Grid"
    headers = ("使用场景", "提及人数", "分析")
    for index, value in enumerate(headers):
        cell = table.rows[0].cells[index]
        cell.text = value
        cell._tc.get_or_add_tcPr().append(OxmlElement("w:shd"))
        cell._tc.get_or_add_tcPr()[-1].set(qn("w:fill"), "F2F4F7")
        for run in cell.paragraphs[0].runs:
            font(run, bold=True)
    for row in (("资料检索", "96", "覆盖面高，但必须回到原始来源核验"), ("提纲整理", "82", "有助于建立结构，不应替代独立论证"), ("语言润色", "67", "效率提升明显，需要保留作者责任")):
        cells = table.add_row().cells
        for index, value in enumerate(row):
            cells[index].text = value
            for run in cells[index].paragraphs[0].runs:
                font(run)
    set_table_geometry(table, [2160, 1440, 5760])

    doc.add_heading("3. 讨论与建议", level=1)
    doc.add_paragraph("调查结果不能证明人工智能工具会自动提高学习质量。只有当学生能够说明信息来源、辨别不确定性并对最终内容负责时，效率收益才可能转化为真实学习成果。")
    for text in ("教师应明确允许与禁止的使用边界。", "学生应记录关键提示、核验来源并标注工具参与。", "课程应把事实核验与引用训练纳入满分标准。"):
        doc.add_paragraph(text, style="List Number")

    doc.add_heading("结论", level=1)
    doc.add_paragraph("生成式人工智能适合用作受控的学习辅助工具，而不是结论来源。后续研究可使用真实纵向数据比较不同教学规范对学习成效的影响。")
    doc.save(path)


def create_pdf(path: Path, chart_path: Path) -> None:
    pdfmetrics.registerFont(TTFont("SimHei", r"C:\Windows\Fonts\simhei.ttf"))
    styles = getSampleStyleSheet()
    title = ParagraphStyle("FixtureTitle", parent=styles["Title"], fontName="SimHei", fontSize=22, leading=27, textColor=colors.HexColor("#16324F"), alignment=TA_CENTER, spaceAfter=14)
    heading = ParagraphStyle("FixtureHeading", parent=styles["Heading1"], fontName="SimHei", fontSize=15, leading=19, textColor=colors.HexColor("#2E74B5"), spaceBefore=12, spaceAfter=7)
    body = ParagraphStyle("FixtureBody", parent=styles["BodyText"], fontName="SimHei", fontSize=10.5, leading=15, spaceAfter=7)
    doc = SimpleDocTemplate(str(path), pagesize=letter, leftMargin=inch, rightMargin=inch, topMargin=inch, bottomMargin=inch, title="AI and Campus Life Acceptance Report", author="Course Agent Test Fixture")
    story = [
        Paragraph("人工智能与校园生活调研报告", title),
        Paragraph("发布验收样例 | 学生：张明（模拟） | 学号：20260001", body),
        Paragraph("摘要", heading),
        Paragraph("本样例用于验证文档转换质量，包含标题、图表、表格和完整段落。数据为模拟数据，不代表真实群体。", body),
        Paragraph("研究方法", heading),
        Paragraph("样本为 120 份匿名模拟问卷，覆盖使用频率、主要用途、收益感知和风险意识。", body),
        Spacer(1, 6),
        PdfImage(str(chart_path), width=6.2 * inch, height=3.2 * inch),
        Paragraph("主要发现", heading),
        Table([["使用场景", "提及人数", "分析"], ["资料检索", "96", "必须回到原始来源核验"], ["提纲整理", "82", "不应替代独立论证"], ["语言润色", "67", "需要保留作者责任"]], colWidths=[1.4 * inch, 1.0 * inch, 4.1 * inch], style=TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F2F4F7")), ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#16324F")), ("FONTNAME", (0, 0), (-1, -1), "SimHei"), ("FONTSIZE", (0, 0), (-1, -1), 9.5), ("LEADING", (0, 0), (-1, -1), 13), ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#A9B4BF")), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7), ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)])),
        Paragraph("结论", heading),
        Paragraph("生成式人工智能适合用作受控的学习辅助工具，而不是结论来源。学生仍需对证据、引用和最终论证负责。", body),
    ]
    doc.build(story)


def create_markdown(path: Path) -> None:
    path.write_text(
        "# 人工智能与校园生活调研报告\n\n"
        "学生：张明（模拟）  \n学号：20260001\n\n"
        "## 摘要\n\n本报告使用模拟问卷数据分析生成式人工智能在校园学习中的使用情况。\n\n"
        "## 主要发现\n\n![校园 AI 工具使用频率](assets/campus-ai-survey.png)\n\n"
        "| 使用场景 | 提及人数 | 分析 |\n| --- | ---: | --- |\n| 资料检索 | 96 | 必须回到原始来源核验 |\n| 提纲整理 | 82 | 不应替代独立论证 |\n| 语言润色 | 67 | 需要保留作者责任 |\n\n"
        "## 结论\n\n生成式人工智能适合用作受控的学习辅助工具，而不是结论来源。\n",
        encoding="utf-8",
    )


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    assets = OUTPUT / "assets"
    assets.mkdir(exist_ok=True)
    chart = assets / "campus-ai-survey.png"
    create_chart(chart)
    create_docx(OUTPUT / "20260001_张明_campus-ai-survey-report.docx", chart)
    create_pdf(OUTPUT / "20260001_张明_campus-ai-survey-report.pdf", chart)
    create_markdown(OUTPUT / "20260001_张明_campus-ai-survey-report.md")


if __name__ == "__main__":
    main()
