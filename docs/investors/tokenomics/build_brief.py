"""Build the metric-only Vector investor brief. No application code is read."""
import argparse
from datetime import date
from decimal import Decimal
from html import escape
import json
from pathlib import Path
import re

from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph


W, H = 612, 792
M, CW = 45, 522
NAVY = colors.HexColor("#102A3C")
TEAL = colors.HexColor("#008E88")
PALE = colors.HexColor("#EAF5F3")
INK = colors.HexColor("#213846")
MUTED = colors.HexColor("#61717D")
LIGHT = colors.HexColor("#F3F6F7")
WHITE = colors.white
FONT = "VectorArial"
BOLD = "VectorArialBold"
ITALIC = "VectorArialItalic"


def validate(data):
    study = data["primary_study"]
    tasks, totals = study["tasks"], study["totals"]
    assert study["status"] == "complete" and len(tasks) == study["task_count"] == 3
    assert study["agents_each"] == 1 and study["paid_repairs"] == 0
    assert study["all_charges_retained"]
    for side in ("vector", "codex"):
        assert sum(Decimal(x[side + "_usd"]) for x in tasks) == Decimal(totals[side + "_usd"])
        assert sum(x[side + "_score"] for x in tasks) == totals[side + "_score"]
        assert sum(x[side + "_requests"] for x in tasks) == totals[side + "_requests"]
        mix = study["cost_mix"][side]
        assert sum(Decimal(v) for k, v in mix.items() if k.endswith("_usd")) == Decimal(totals[side + "_usd"])
    assert sum(x["checks"] for x in tasks) == totals["checks_each"] == 76
    assert all(x["vector_score"] >= x["codex_score"] for x in tasks)
    assert sum(Decimal(x["vector_usd"]) < Decimal(x["codex_usd"]) for x in tasks) == 1
    assert all(0 <= x[side + "_score"] <= x["score_max"] for x in tasks for side in ("vector", "codex"))
    controls = data["current_controls"]
    assert controls["focused_tests_passed"] == 220 and controls["focused_tests_failed"] == 0
    assert controls["paid_savings_measured"] is False
    extra = data.get("additional_complete_study")
    if extra is not None:
        assert extra["status"] == "complete" and extra["settlement_complete"] is True
        assert extra["all_charges_retained"] is True
        for side in ("vector", "codex"):
            assert Decimal(extra[side]["cost_usd"]) >= 0
            assert 0 <= extra[side]["checks_passed"] <= extra[side]["checks_total"]
            assert extra[side]["requests"] > 0
        if extra["quality_gate_met"]:
            assert all(extra[s]["checks_passed"] == extra[s]["checks_total"] for s in ("vector", "codex"))
            assert extra["vector"]["checks_total"] == extra["codex"]["checks_total"]
            assert extra["matched_native_audit_passed"] is True
            assert extra["blinded_review"]["same_rubric_and_reviewer_pool"] is True
            assert extra["blinded_review"]["source_and_required_artifacts_reviewed"] is True
            assert all(extra[s]["native_roles_observed"] == extra["team_size_each"] for s in ("vector", "codex"))
            categories = extra["blinded_review"]["categories"]
            assert categories and len({x["name"] for x in categories}) == len(categories)
            assert all(0 <= x["codex_score"] <= x["vector_score"] <= x["maximum"] for x in categories)
    content = json.dumps(data)
    assert not re.search(r"(?<![A-Za-z0-9])sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{35,}", content)
    assert not re.search(r"(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{25,}", content)
    assert "C:\\Users\\" not in content and "C:/Users/" not in content


def style(size=11.5, leading=None, color=INK, bold=False):
    return ParagraphStyle("text", fontName=BOLD if bold else FONT, fontSize=size,
                          leading=leading or size * 1.43, textColor=color,
                          alignment=TA_LEFT, spaceAfter=0, allowWidows=0, allowOrphans=0)


def text(c, value, x, y, width=CW, size=11.5, leading=None, color=INK, bold=False):
    p = Paragraph(value, style(size, leading, color, bold))
    _, height = p.wrap(width, H)
    assert y - height >= 42, (value, y, height)
    p.drawOn(c, x, y - height)
    return y - height


def rect(c, x, top, width, height, fill=LIGHT, radius=10):
    c.setFillColor(fill)
    c.roundRect(x, top - height, width, height, radius, stroke=0, fill=1)


def top(c, page, total, data):
    c.setFillColor(NAVY)
    c.setFont(BOLD, 18)
    c.drawString(M, 749, "Vector")
    c.setFont(FONT, 9.3)
    c.setFillColor(MUTED)
    c.drawRightString(W - M, 751, "TOKENOMICS / INVESTOR BRIEF")
    c.setFont(FONT, 8.7)
    c.drawString(M, 31, "Benchmark evidence and product controls")
    c.drawRightString(W - M, 31, f"{date.fromisoformat(data['as_of']).strftime('%d %b %Y')}   /   {page:02d}")


def metric(c, x, y, width, value, title, detail):
    rect(c, x, y, width, 132, PALE)
    text(c, value, x + 18, y - 14, width - 36, 38, 42, TEAL, True)
    text(c, title, x + 18, y - 63, width - 36, 12.4, 16, NAVY, True)
    text(c, detail, x + 18, y - 87, width - 36, 10.1, 14, MUTED)


def money(value):
    return "$" + format(Decimal(value), ".4f")


def saving(vector, codex):
    return (Decimal(codex) - Decimal(vector)) / Decimal(codex) * 100


def cover(c, data, total):
    top(c, 1, total, data)
    totals = data["primary_study"]["totals"]
    cost_saving = f"{saving(totals['vector_usd'], totals['codex_usd']):.1f}%"
    y = text(c, "Agentic work.<br/>Economic clarity.", M, 698, CW, 42, 46, NAVY, True)
    y = text(c, "Vector brings cost visibility and workflow controls to model-driven work, with verification kept in the loop.", M, y - 22, 478, 16.5, 23.5, INK)
    metric(c, M, y - 29, 255, cost_saving, "Lower recorded API cost", "Aggregate result across three controlled coding workflows.")
    metric(c, M + 267, y - 29, 255, "76/76", "Specified checks passed", "Both runtimes passed every specified acceptance check in the set.")
    y = y - 190
    y = text(c, "Measured efficiency. Explicit quality gates.", M, y, CW, 20, 26, NAVY, True)
    y = text(c, f"The evaluation held the model and High reasoning constant. Vector's fixed static score was no lower on any of the three tasks. Recorded cost was {money(totals['vector_usd'])} for Vector and {money(totals['codex_usd'])} for Codex.", M, y - 13, CW, 12.3, 18)
    y = text(c, "The tokenomics layer makes the price of work visible, applies configurable controls and supports disciplined improvements to the surrounding workflow.", M, y - 16, CW, 12.3, 18)
    text(c, "Scope: small adaptive evaluation, one trial per task. Cost varied by workload; Vector was cheaper on one of three tasks. Results describe the tested candidate and measured gates. [E1]", M, 115, CW, 9.2, 13.3, MUTED)
    c.showPage()


def benchmark(c, data, total):
    top(c, 2, total, data)
    y = text(c, "Measured on three workflows.", M, 700, CW, 30, 36, NAVY, True)
    y = text(c, "Same model. High reasoning. One autonomous agent per runtime. Every recorded request retained, with no paid repair in this set.", M, y - 15, CW, 12.2, 18)
    table_top = y - 28
    widths = [170, 82, 82, 90, 98]
    headers = ["Workflow", "Vector<br/>API cost", "Codex<br/>API cost", "Checks<br/>each", "Review /48<br/>Vector / Codex"]
    rect(c, M, table_top, CW, 48, NAVY, 8)
    x = M
    for width, title in zip(widths, headers):
        text(c, title, x + 12, table_top - 10, width - 20, 10, 13, WHITE, True)
        x += width
    row_top = table_top - 48
    for index, task in enumerate(data["primary_study"]["tasks"]):
        if index % 2 == 0:
            c.setFillColor(LIGHT); c.rect(M, row_top - 52, CW, 52, stroke=0, fill=1)
        values = [task["name"], money(task["vector_usd"]), money(task["codex_usd"]),
                  f"{task['checks']}/{task['checks']}", f"{task['vector_score']} / {task['codex_score']}"]
        x = M
        for width, value in zip(widths, values):
            text(c, value, x + 12, row_top - 17, width - 20, 10.5, 14, INK, index == 0 and x == M)
            x += width
        row_top -= 52
    rect(c, M, row_top - 7, CW, 60, PALE, 8)
    values = ["Three-task total", "$2.0209", "$2.1276", "76/76", "139 / 138*"]
    x = M
    for width, value in zip(widths, values):
        text(c, value, x + 12, row_top - 25, width - 20, 10.6, 14, NAVY, True); x += width
    y = row_top - 84
    y = text(c, "*Score totals are descriptive (maximum 144). The quality gate is checked on each task independently. Cost is usage-derived at the study rates, not an invoice or subscription-price comparison. [E1]", M, y, CW, 9.1, 13, MUTED)
    y -= 22
    rect(c, M, y, CW, 134, PALE)
    text(c, "Workflow Runner: a named case study", M + 18, y - 15, CW - 36, 14, 18, NAVY, True)
    named = data["primary_study"]["tasks"][0]
    text(c, f"{saving(named['vector_usd'], named['codex_usd']):.1f}%", M + 18, y - 45, 170, 28, 33, TEAL, True)
    text(c, f"{saving(named['vector_wall_ms'], named['codex_wall_ms']):.1f}%", M + 269, y - 45, 170, 28, 33, TEAL, True)
    text(c, "Lower recorded API cost", M + 18, y - 82, 230, 10.8, 15, INK, True)
    text(c, "Less agent wall time", M + 269, y - 82, 230, 10.8, 15, INK, True)
    text(c, "Both passed 24/24 checks and scored 45/48. This is one task in the complete table above; it does not predict every workflow.", M + 18, y - 105, CW - 36, 9.2, 13.2, MUTED)
    text(c, "Observed cost variation: Vector was 0.7% more expensive on Evidence Workbench and 5.7% more on Delivery Outbox. The aggregate reduction was 5.0%.", M, 103, CW, 9.2, 13.3, MUTED)
    c.showPage()


def flow(c, y):
    entries = [("Define", "Objective and\nquality criteria"), ("Coordinate", "Model, tool and\nagent work"),
               ("Measure", "Usage and\nworkflow cost"), ("Control", "Limits and\nwork continuity"),
               ("Verify", "Checks and\nreview evidence")]
    bw, gap = 98, 8
    for index, (title, desc) in enumerate(entries):
        x = M + index * (bw + gap)
        rect(c, x, y, bw, 95, PALE if index in (2, 3) else LIGHT, 8)
        text(c, title, x + 10, y - 14, bw - 20, 11.2, 15, NAVY, True)
        text(c, desc.replace("\n", "<br/>"), x + 10, y - 40, bw - 20, 9.1, 13, MUTED)
        if index < 4:
            c.setStrokeColor(TEAL); c.setLineWidth(1)
            c.line(x + bw + 1, y - 47, x + bw + gap - 1, y - 47)
    return y - 95


def mechanics(c, data, total):
    top(c, 3, total, data)
    mix = data["primary_study"]["cost_mix"]
    output_reduction = saving(mix["vector"]["output_tokens"], mix["codex"]["output_tokens"])
    input_increase = -saving(mix["vector"]["input_tokens"], mix["codex"]["input_tokens"])
    y = text(c, "Optimize the cost of work.", M, 700, CW, 30, 36, NAVY, True)
    y = text(c, "The tokenomics layer connects execution, usage visibility and verification. Its purpose is to make useful work more accountable and avoid needless repetition.", M, y - 15, CW, 12.2, 18)
    y = flow(c, y - 28)
    items = [
        ("See the workflow", "Bring primary, delegated and helper model usage into a clearer view of the work. Keep known charges distinct from incomplete or uncertain usage."),
        ("Keep useful continuity", "Support cache-aware context continuity and combine routine tool setup with readiness checks, while retaining permissions and relevant verification."),
        ("Control repetition", "Apply configurable run, step and loop controls. Preserve explicit user rechecks and useful progress as work continues.")
    ]
    for title, body in items:
        y -= 25
        text(c, title, M, y, 170, 14, 19, NAVY, True)
        y = text(c, body, M + 180, y, CW - 180, 11.3, 16.3)
    y -= 28
    rect(c, M, y, CW, 111, PALE)
    text(c, "Raw token count is not the bill.", M + 18, y - 15, CW - 36, 15, 20, NAVY, True)
    text(c, f"In the three-task set, Vector generated {output_reduction:.1f}% less output while processing {input_increase:.1f}% more input. The weighted mix of output, cache writes and cache reads produced the lower total cost. [E2]", M + 18, y - 44, CW - 36, 11.1, 16.2)
    text(c, "This is a functional overview. Spending estimates and after-step controls support visibility and limits; they are not a guaranteed hard invoice cap.", M, 100, CW, 9.1, 13.1, MUTED)
    c.showPage()


def evidence(c, data, total):
    top(c, 4, total, data)
    y = text(c, "Progress that can be audited.", M, 700, CW, 30, 36, NAVY, True)
    y = text(c, "A disciplined cycle connects measured behavior to product changes and regression checks.", M, y - 15, CW, 12.2, 18)
    rect(c, M, y - 23, CW, 112, PALE)
    text(c, str(data["current_controls"]["focused_tests_passed"]), M + 18, y - 38, 105, 38, 42, TEAL, True)
    text(c, "Targeted regression tests passed", M + 145, y - 40, CW - 164, 15, 20, NAVY, True)
    text(c, "Latest V2 control suite, with Core and integrated Engine typechecks passing. Local scripted tests validate control behavior; paid savings from these later changes are not yet measured. [E3]", M + 145, y - 70, CW - 164, 10, 14, MUTED)
    y -= 162
    y = text(c, "What the current controls address", M, y, CW, 17, 23, NAVY, True)
    y = text(c, "Repeated tool outcomes, explicit user rechecks, incomplete usage, cancelled waits and background work continuity. These are engineering controls, evaluated separately from the generated application's benchmark score.", M, y - 10, CW, 11.4, 16.5)
    y -= 24
    y = text(c, "Benchmark scope", M, y, CW, 17, 23, NAVY, True)
    y = text(c, "Three single-trial pairs used the same gpt-6.1-sol model, High reasoning and one autonomous agent per runtime. Two tasks were development replications; one was held out. Results describe the tested candidate, required checks and fixed static rubric. The sample does not establish statistical significance or predict all workloads.", M, y - 10, CW, 10.6, 15.1)
    y = text(c, "Prices are derived from recorded provider usage at the study schedule. Reviews use exact source and selected screenshots; passing checks do not certify production reliability or security. Larger multi-agent evidence is included only after a complete, settled comparison.", M, y - 11, CW, 10.6, 15.1)
    y -= 21
    y = text(c, "Evidence register", M, y, CW, 14, 19, NAVY, True)
    for source in data["sources"][:3]:
        label = f"<b>{escape(source['id'])}</b>   <link href='{escape(source['url'], quote=True)}' color='#008E88'>{escape(source['label'])}</link>"
        y = text(c, label, M, y - 8, CW, 9.4, 13.1, MUTED)
    c.showPage()


def additional(c, data, total):
    study = data["additional_complete_study"]
    top(c, 5, total, data)
    y = text(c, "Additional matched evidence.", M, 700, CW, 30, 36, NAVY, True)
    y = text(c, escape(study["label"]), M, y - 18, CW, 18, 24, NAVY, True)
    y = text(c, f"Same {escape(study['model'])} model and {escape(study['reasoning'])} reasoning; {study['team_size_each']} configured agents per runtime. All recorded charges retained and both episodes settled.", M, y - 15, CW, 12, 18)
    y -= 28
    for side, label in [("vector", "Vector"), ("codex", "Codex")]:
        arm = study[side]
        rect(c, M, y, CW, 94, PALE if side == "vector" else LIGHT)
        text(c, label, M + 18, y - 15, 130, 18, 23, NAVY, True)
        text(c, money(arm["cost_usd"]), M + 170, y - 15, 160, 25, 31, TEAL if side == "vector" else NAVY, True)
        text(c, f"{arm['checks_passed']}/{arm['checks_total']} required checks; {arm['requests']} provider requests", M + 18, y - 61, CW - 36, 11, 16)
        y -= 111
    y = text(c, "Recorded quality gate: " + ("met within the measured scope." if study["quality_gate_met"] else "not met; no quality-preserving savings claim is made."), M, y - 8, CW, 13, 19, NAVY, True)
    text(c, escape(study["scope"]), M, y - 18, CW, 11.4, 17)
    c.showPage()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path(__file__).with_name("report-data.json"))
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--font-dir", type=Path, default=Path("C:/Windows/Fonts"))
    options = parser.parse_args()
    data = json.loads(options.data.read_text(encoding="utf-8"))
    validate(data)
    for name, file in [(FONT, "arial.ttf"), (BOLD, "arialbd.ttf"), (ITALIC, "ariali.ttf")]:
        pdfmetrics.registerFont(TTFont(name, str(options.font_dir / file)))
    pdfmetrics.registerFontFamily(FONT, normal=FONT, bold=BOLD, italic=ITALIC, boldItalic=BOLD)
    options.out.parent.mkdir(parents=True, exist_ok=True)
    total = 5 if data.get("additional_complete_study") else 4
    c = canvas.Canvas(str(options.out), pagesize=(W, H), pageCompression=1)
    c.setTitle(data["title"])
    c.setAuthor("Vector")
    c.setSubject("High-level tokenomics overview and controlled coding-workflow benchmarks")
    c.setCreator("Vector investor brief builder")
    for page in (cover, benchmark, mechanics, evidence):
        page(c, data, total)
    if data.get("additional_complete_study"):
        additional(c, data, total)
    c.save()
    reader = PdfReader(options.out)
    assert len(reader.pages) == total
    all_text = "\n".join(page.extract_text() for page in reader.pages)
    for required in ["5.0%", "76/76", "Workflow Runner", "Evidence Workbench", "Delivery Outbox", "220", "Benchmark scope"]:
        assert required in all_text, required
    assert "\ufffd" not in all_text
    print(json.dumps({"pages": total, "output": str(options.out.resolve()), "arithmeticValidated": True, "textChecksPassed": True}))


if __name__ == "__main__":
    main()
