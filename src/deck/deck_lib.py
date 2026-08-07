"""
Shared chart-rendering and slide-assembly helpers for building a Data
Analysis deck from {subject, title, classes: {S,P,M,E}} blocks.

Ported from the Term Data project's xlsx_deck.py, with one important fix:
the blank deck skeleton this assembles into now lives permanently at
assets/deck_template (copied into this repo) instead of a temporary
Claude session scratchpad path, which could vanish at any time.
"""
import os
import re
from xml.sax.saxutils import escape

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DECK_TEMPLATE = f"{ROOT}/assets/deck_template"

SLIDE_W_IN = 10.0
SLIDE_H_IN = 7.5

COLORS = {"S": "#E06666", "P": "#F6B26B", "M": "#93C47D", "E": "#6FA8DC"}
STACK_ORDER = ["S", "P", "M", "E"]
LEGEND_ORDER = ["E", "M", "P", "S"]

CLASS_RE = re.compile(r"^\d+[A-Za-z]$")


# ---------------------------------------------------------------------------
# Charts
# ---------------------------------------------------------------------------

plt.rcParams["font.family"] = "Arial"


def class_sort_key(c):
    for i, ch in enumerate(c):
        if ch.isalpha():
            return (int(c[:i]), c[i:])
    return (0, c)


def truncate_label(text, maxlen):
    """Cuts at the last whole word that fits, not mid-word -- "Analyzes maps
    by using…" reads as a real (if partial) phrase, "Analyzes maps by
    usin…" reads as broken. Falls back to a hard cut only when a single
    word alone is already longer than maxlen."""
    if len(text) <= maxlen:
        return text
    truncated = text[: maxlen - 1].rstrip()
    last_space = truncated.rfind(" ")
    if last_space > maxlen * 0.4:  # don't shorten to almost nothing on a long first word
        truncated = truncated[:last_space]
    return truncated.rstrip() + "…"


def make_chart(classes, out_path, label_order=None, xlabel="Class and Section",
                rotate_labels=0, label_maxlen=None, show_percent=False):
    """Renders one stacked S/P/M/E bar per key in `classes` -- the key can be
    a class/section (the original use), a subject, or a standard; the chart
    itself doesn't care, only the caller's aggregation and axis label change.

    label_order overrides the default class_sort_key sort (which assumes
    "<number><letter>" labels like "7A" -- wrong for subject/standard names).
    label_maxlen/rotate_labels handle long labels (subject or standard names)
    that don't fit un-rotated the way short section codes do.
    show_percent normalizes every bar to the same 100%-tall stack (share of
    that bar's own total), not just relabeling raw counts as a percentage --
    bars being compared can have very different totals (e.g. subjects with
    different numbers of standards assessed), and leaving the plotted
    heights as raw counts would keep implying "taller = more/better" for a
    reason that has nothing to do with performance.
    """
    class_labels = label_order if label_order is not None else sorted(classes.keys(), key=class_sort_key)
    n = len(class_labels)
    bar_totals = [sum(classes[cl].values()) for cl in class_labels]

    fig, ax = plt.subplots(figsize=(9, 4.2), dpi=150)
    x = range(n)
    bottoms = [0] * n

    for key in STACK_ORDER:
        raw_vals = [classes[cl][key] for cl in class_labels]
        if show_percent:
            plot_vals = [raw_vals[i] / bar_totals[i] * 100 if bar_totals[i] else 0 for i in range(n)]
        else:
            plot_vals = raw_vals
        ax.bar(x, plot_vals, bottom=bottoms, color=COLORS[key], width=0.62, edgecolor="none")
        for i, (v, raw_v, b) in enumerate(zip(plot_vals, raw_vals, bottoms)):
            if raw_v == 0:
                continue
            label = f"{v:.0f}%" if show_percent else str(raw_v)
            ax.text(
                i, b + v / 2, label, ha="center", va="center",
                fontsize=11, color="#222222" if key in ("P", "M") else "white",
            )
        bottoms = [b + v for b, v in zip(bottoms, plot_vals)]

    display_labels = [truncate_label(l, label_maxlen) for l in class_labels] if label_maxlen else class_labels
    ax.set_xticks(list(x))
    if rotate_labels:
        ax.set_xticklabels(display_labels, fontsize=11, rotation=rotate_labels, ha="right")
    else:
        ax.set_xticklabels(display_labels, fontsize=12)
    ax.set_xlabel(xlabel, fontsize=11, labelpad=8)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_visible(False)
    ax.tick_params(axis="y", labelsize=10, length=0)
    ax.tick_params(axis="x", length=0)
    ax.yaxis.grid(True, color="#DDDDDD", linewidth=0.8)
    ax.set_axisbelow(True)

    if show_percent:
        ax.set_ylim(0, 100 * 1.06)
        ax.yaxis.set_major_formatter(FuncFormatter(lambda y, _: f"{int(y)}%"))
    else:
        max_total = max(bar_totals)
        ax.set_ylim(0, max(max_total, 1) * 1.12)

    handles = [plt.Rectangle((0, 0), 1, 1, color=COLORS[k]) for k in LEGEND_ORDER]
    ax.legend(
        handles, LEGEND_ORDER, loc="upper center", bbox_to_anchor=(0.5, 1.14),
        ncol=4, frameon=False, fontsize=12, handlelength=1.2, handleheight=1.2,
        columnspacing=1.5,
    )

    fig.tight_layout(rect=[0, 0, 1, 0.94 if not rotate_labels else 0.92])
    fig.savefig(out_path, transparent=True)
    plt.close(fig)


def make_hbar_chart(values, out_path, xlabel="", label_maxlen=None):
    """One horizontal bar per {label: 0-100 value}, sorted descending --
    matches the reference template's "Average Mastery Rate (Meeting +
    Exceeding) by Subject" dashboard chart. A single-metric companion to
    make_chart's full S/P/M/E stack, for when one number per subject (not
    four) is the point."""
    labels = sorted(values.keys(), key=lambda k: values[k])  # ascending -- top bar ends up highest on a horizontal chart
    display_labels = [truncate_label(l, label_maxlen) for l in labels] if label_maxlen else labels
    vals = [values[l] for l in labels]
    n = len(labels)

    fig, ax = plt.subplots(figsize=(9, max(2.5, 0.5 * n)), dpi=150)
    y = range(n)
    ax.barh(y, vals, color="#4A90D9", height=0.6)
    for i, v in enumerate(vals):
        ax.text(v + 1.5, i, f"{v:.0f}%", va="center", fontsize=11, color="#222222")

    ax.set_yticks(list(y))
    ax.set_yticklabels(display_labels, fontsize=12)
    ax.set_xlabel(xlabel, fontsize=11, labelpad=8)
    ax.set_xlim(0, 100)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_visible(False)
    ax.tick_params(axis="x", labelsize=10, length=0)
    ax.tick_params(axis="y", length=0)
    ax.xaxis.grid(True, color="#DDDDDD", linewidth=0.8)
    ax.set_axisbelow(True)

    fig.tight_layout()
    fig.savefig(out_path, transparent=True)
    plt.close(fig)


def make_donut_chart(counts, out_path):
    """One subject's overall S/P/M/E split as a single donut -- an
    aggregate distribution (every mark across every standard and section,
    summed into one whole), unlike make_chart/make_hbar_chart which always
    compare several labels side by side. Matches the reference template's
    layout exactly: just the S/P/M/E letters on the wedges themselves (no
    percentages here -- those live in the callout rows written_subject_
    snapshot() builds beside this image) plus a small legend below."""
    labels = [k for k in STACK_ORDER if counts.get(k, 0) > 0] or list(STACK_ORDER)
    vals = [counts.get(k, 0) for k in labels]
    colors = [COLORS[k] for k in labels]

    fig, ax = plt.subplots(figsize=(4.6, 5.2), dpi=150)
    ax.pie(
        vals, colors=colors, labels=labels, labeldistance=0.79, startangle=90, counterclock=False,
        wedgeprops=dict(width=0.42, edgecolor="white", linewidth=2),
        textprops={"fontsize": 15, "color": "#1A1A1A", "fontweight": "bold"},
    )
    handles = [plt.Rectangle((0, 0), 1, 1, color=COLORS[k]) for k in LEGEND_ORDER]
    ax.legend(
        handles, LEGEND_ORDER, loc="upper center", bbox_to_anchor=(0.5, 0.06),
        ncol=4, frameon=False, fontsize=13, handlelength=1.2, handleheight=1.2,
    )
    ax.set_aspect("equal")
    fig.tight_layout()
    fig.savefig(out_path, transparent=True)
    plt.close(fig)


# ---------------------------------------------------------------------------
# Slide XML templates
# ---------------------------------------------------------------------------

CONTENT_SLIDE_TEMPLATE = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="{title_x}" y="{title_y}"/><a:ext cx="{title_w}" cy="{title_h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr anchorCtr="0" anchor="t" bIns="0" lIns="0" spcFirstLastPara="1" rIns="0" wrap="square" tIns="0"><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr indent="0" lvl="0" marL="0" marR="0" rtl="0" algn="l"><a:lnSpc><a:spcPct val="115000"/></a:lnSpc><a:spcBef><a:spcPts val="0"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft><a:buNone/></a:pPr><a:r><a:rPr b="1" i="0" lang="en-IN" sz="{title_sz}" u="none" cap="none" strike="noStrike"><a:solidFill><a:srgbClr val="1A1A1A"/></a:solidFill><a:latin typeface="Arial"/><a:ea typeface="Arial"/><a:cs typeface="Arial"/><a:sym typeface="Arial"/></a:rPr><a:t>{title}</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="3" name="Logo"/><p:cNvPicPr preferRelativeResize="0"/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"><a:alphaModFix/></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="6095775" y="327375"/><a:ext cx="2962600" cy="774975"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr></p:pic><p:pic><p:nvPicPr><p:cNvPr id="4" name="Chart"/><p:cNvPicPr preferRelativeResize="0"/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId3"><a:alphaModFix/></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="{chart_x}" y="{chart_y}"/><a:ext cx="{chart_w}" cy="{chart_h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"""

RELS_TEMPLATE = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/{layout}"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="{logo_target}"/>{extra}</Relationships>"""

LOGO_REL_TARGET = "../media/image13.jpg"


def in_emu(inches):
    return int(round(inches * 914400))


# ---------------------------------------------------------------------------
# Composable shape/text helpers -- the richer slides (dashboard stat cards,
# key-takeaways sections, the instructional-implications table) all need a
# variable, data-driven number of boxes and paragraphs, which doesn't fit
# the fixed-placeholder .format() templates above (DIVIDER/CONTENT). These
# build the same raw DrawingML shape-by-shape instead, composed by string
# concatenation.
# ---------------------------------------------------------------------------

def esc(s):
    return escape(str(s))


def run_xml(text, size_pt, bold=False, color="1A1A1A", italic=False):
    b = ' b="1"' if bold else ' b="0"'
    i = ' i="1"' if italic else ''
    return (
        f'<a:r><a:rPr lang="en-IN" sz="{int(round(size_pt * 100))}"{b}{i}>'
        f'<a:solidFill><a:srgbClr val="{color}"/></a:solidFill>'
        f'<a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr>'
        f'<a:t>{esc(text)}</a:t></a:r>'
    )


def para_xml(runs, align="l", space_after=0, space_before=0, bullet=False):
    """runs: list of run_xml(...) strings (already-rendered), rendered as
    one paragraph. bullet=True draws a plain round bullet; the templates
    above never need bullets (their body copy is single short lines), but
    the Key Takeaways / Instructional Implications placeholders do."""
    bu = '<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>' if bullet else '<a:buNone/>'
    indent = ' indent="-182880" marL="182880"' if bullet else ''
    pPr = (
        f'<a:pPr algn="{align}"{indent}>'
        f'<a:spcBef><a:spcPts val="{int(space_before * 100)}"/></a:spcBef>'
        f'<a:spcAft><a:spcPts val="{int(space_after * 100)}"/></a:spcAft>{bu}</a:pPr>'
    )
    body = "".join(runs) if runs else '<a:endParaRPr lang="en-IN"/>'
    return f'<a:p>{pPr}{body}</a:p>'


def shape_xml(shape_id, name, x_in, y_in, w_in, h_in, paragraphs, fill_hex=None,
              line_hex=None, rounded=False, anchor="t"):
    """paragraphs: list of para_xml(...) strings."""
    prst = "roundRect" if rounded else "rect"
    fill = f'<a:solidFill><a:srgbClr val="{fill_hex}"/></a:solidFill>' if fill_hex else '<a:noFill/>'
    line = (
        f'<a:ln w="9525"><a:solidFill><a:srgbClr val="{line_hex}"/></a:solidFill></a:ln>'
        if line_hex else '<a:ln><a:noFill/></a:ln>'
    )
    # A txBody with zero <a:p> children is schema-invalid ("Missing child
    # element(s), expected a:p") -- a purely decorative shape (a background
    # card, a colored strip) still needs one empty paragraph.
    body = "".join(paragraphs) if paragraphs else '<a:p><a:endParaRPr lang="en-IN"/></a:p>'
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{shape_id}" name="{esc(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{in_emu(x_in)}" y="{in_emu(y_in)}"/><a:ext cx="{in_emu(w_in)}" cy="{in_emu(h_in)}"/></a:xfrm>'
        f'<a:prstGeom prst="{prst}"><a:avLst/></a:prstGeom>{fill}{line}</p:spPr>'
        f'<p:txBody><a:bodyPr anchor="{anchor}" lIns="91440" tIns="45720" rIns="91440" bIns="45720" wrap="square"><a:noAutofit/></a:bodyPr>'
        f'<a:lstStyle/>{body}</p:txBody></p:sp>'
    )


def pic_xml(shape_id, name, rid, x_in, y_in, w_in, h_in):
    return (
        f'<p:pic><p:nvPicPr><p:cNvPr id="{shape_id}" name="{esc(name)}"/><p:cNvPicPr preferRelativeResize="0"/><p:nvPr/></p:nvPicPr>'
        f'<p:blipFill><a:blip r:embed="{rid}"><a:alphaModFix/></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
        f'<p:spPr><a:xfrm><a:off x="{in_emu(x_in)}" y="{in_emu(y_in)}"/><a:ext cx="{in_emu(w_in)}" cy="{in_emu(h_in)}"/></a:xfrm>'
        f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr></p:pic>'
    )


def slide_doc(shapes_xml, bg_hex=None):
    bg = (
        f'<p:bg><p:bgPr><a:solidFill><a:srgbClr val="{bg_hex}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>'
        if bg_hex else ''
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
        f'<p:cSld>{bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        f'{shapes_xml}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
    )


def write_rels(slide_path, layout, extra=""):
    rels_path = slide_path.replace("/slides/", "/slides/_rels/") + ".rels"
    open(rels_path, "w").write(
        RELS_TEMPLATE.format(layout=layout, logo_target=LOGO_REL_TARGET, extra=extra)
    )


def dot_xml(shape_id, x_in, y_in, d_in, color_hex):
    """A small filled circle -- used as the colored proficiency-band marker
    on the "How to use this deck" slide."""
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{shape_id}" name="Dot"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{in_emu(x_in)}" y="{in_emu(y_in)}"/><a:ext cx="{in_emu(d_in)}" cy="{in_emu(d_in)}"/></a:xfrm>'
        f'<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="{color_hex}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>'
        f'<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-IN"/></a:p></p:txBody></p:sp>'
    )


def image_rel_xml(rid, target):
    return (
        f'<Relationship Id="{rid}" '
        f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="{target}"/>'
    )


def fit_title(text, box_w_in):
    usable_pt = (box_w_in - 0.2) * 72
    n = max(len(text), 1)
    sz_pt = max(13, min(24, 3 * usable_pt / (n * 0.58)))
    chars_per_line = usable_pt / (sz_pt * 0.58)
    lines_needed = max(1, -(-n // int(chars_per_line)))
    line_height_in = sz_pt * 1.15 / 72
    title_h_in = lines_needed * line_height_in + 0.3
    return int(sz_pt * 100), title_h_in


def write_content(slide_path, title, chart_rel_target, chart_w_in=9.0, chart_h_in=4.2):
    """chart_w_in/chart_h_in default to the wide aspect ratio make_chart/
    make_hbar_chart render at -- a square chart (make_donut_chart) needs
    its own box, or pic_xml's stretch-to-fill silently distorts it into an
    ellipse rather than actually failing anything."""
    title_x = in_emu(0.5)
    title_y_in = 1.35
    title_y = in_emu(title_y_in)
    title_w_in = SLIDE_W_IN - 1.0
    sz, title_h_in = fit_title(title, title_w_in)
    title_w = in_emu(title_w_in)
    title_h = in_emu(title_h_in)

    chart_y_in = title_y_in + title_h_in + 0.25
    available_h_in = SLIDE_H_IN - 0.3 - chart_y_in
    if chart_h_in > available_h_in:
        # Shrink both dimensions together so the aspect ratio (and
        # therefore the image itself) isn't distorted -- clamping height
        # alone stretched a square donut into an ellipse.
        scale = available_h_in / chart_h_in
        chart_h_in *= scale
        chart_w_in *= scale
    chart_x = in_emu((SLIDE_W_IN - chart_w_in) / 2)
    chart_y = in_emu(chart_y_in)
    chart_w = in_emu(chart_w_in)
    chart_h = in_emu(chart_h_in)

    xml = CONTENT_SLIDE_TEMPLATE.format(
        title=escape(title), title_sz=sz,
        title_x=title_x, title_y=title_y, title_w=title_w, title_h=title_h,
        chart_x=chart_x, chart_y=chart_y, chart_w=chart_w, chart_h=chart_h,
    )
    open(slide_path, "w").write(xml)

    rels_path = slide_path.replace("/slides/", "/slides/_rels/") + ".rels"
    extra = (
        f'<Relationship Id="rId3" '
        f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
        f'Target="{chart_rel_target}"/>'
    )
    open(rels_path, "w").write(
        RELS_TEMPLATE.format(layout="slideLayout3.xml", logo_target=LOGO_REL_TARGET, extra=extra)
    )


LOGO_X_IN, LOGO_Y_IN, LOGO_W_IN, LOGO_H_IN = 6.667, 0.358, 3.24, 0.848

def hex6(color):
    """COLORS' values are "#RRGGBB" (what matplotlib wants); srgbClr val=
    needs exactly 6 hex digits with no "#" -- strip it wherever a COLORS
    entry feeds into slide XML instead of a matplotlib call."""
    return color.lstrip("#")


PROFICIENCY_BANDS = [
    ("Starting Out", "0 - 40", "Well below grade-level expectations; needs foundational support.", hex6(COLORS["S"])),
    ("Progressing", "40.01 - 70", "Approaching expectations; not yet meeting the standard.", hex6(COLORS["P"])),
    ("Meeting", "70.01 - 95", "At grade-level expectations for this standard.", hex6(COLORS["M"])),
    ("Exceeding", "95.01 - 100", "Above grade-level expectations.", hex6(COLORS["E"])),
]


def write_how_to_use(slide_path):
    """Static slide, once at the very start of the deck -- explains the
    S/P/M/E proficiency bands every other slide's charts use. Content
    mirrors the reference template's own equivalent slide 1 exactly (same
    band names/ranges/descriptions), just laid out for this deck's 4:3
    canvas instead of the reference's 16:9."""
    shapes = []
    # Narrower than the full slide width -- wide enough to wrap to 2 lines
    # rather than run text under the logo (drawn on top, so it would
    # visually overlap rather than actually collide, but reads as broken).
    shapes.append(shape_xml(2, "Title", 0.5, 0.35, LOGO_X_IN - 0.7, 1.1,
        [para_xml([run_xml("How to use this deck for any subject", 28, bold=True, color="1A1A1A")])]))
    shapes.append(shape_xml(3, "Subtitle", 0.5, 1.5, 9.0, 0.4,
        [para_xml([run_xml("One shared structure, one shared rubric — swap in your subject's data without changing the format.", 13, color="6E6E73")])]))

    card_x, card_y, card_w, card_h = 0.5, 2.0, 9.0, 5.15
    shapes.append(shape_xml(4, "Card", card_x, card_y, card_w, card_h, [], fill_hex="FFFFFF", line_hex="D2D2D7"))
    shapes.append(shape_xml(5, "CardHeader", card_x + 0.35, card_y + 0.25, card_w - 0.7, 0.4,
        [para_xml([run_xml("Proficiency bands used throughout", 16, bold=True, color="1A1A1A")])]))

    row_h = 1.05
    row_y0 = card_y + 0.8
    shape_id = 6
    for i, (name, rng, desc, color) in enumerate(PROFICIENCY_BANDS):
        ry = row_y0 + i * row_h
        shapes.append(dot_xml(shape_id, card_x + 0.35, ry, 0.3, color)); shape_id += 1
        shapes.append(shape_xml(shape_id, "BandName", card_x + 0.85, ry - 0.08, 2.4, 0.45,
            [para_xml([run_xml(name, 15, bold=True, color="1A1A1A")])])); shape_id += 1
        shapes.append(shape_xml(shape_id, "BandRange", card_x + 3.4, ry - 0.1, 1.8, 0.42,
            [para_xml([run_xml(rng, 13, bold=True, color="1A1A1A")], align="ctr")],
            fill_hex="F0F0F2", rounded=True, anchor="ctr")); shape_id += 1
        shapes.append(shape_xml(shape_id, "BandDesc", card_x + 0.35, ry + 0.42, card_w - 0.7, 0.5,
            [para_xml([run_xml(desc, 12, color="4A4A4E")])])); shape_id += 1

    shapes.append(pic_xml(shape_id, "Logo", "rId2", LOGO_X_IN, LOGO_Y_IN, LOGO_W_IN, LOGO_H_IN))

    open(slide_path, "w").write(slide_doc("".join(shapes)))
    write_rels(slide_path, "slideLayout2.xml")


STAT_CARD_BLUE = "4A72B8"


def stat_card_xml(shape_id, x_in, y_in, w_in, h_in, label, value):
    return shape_xml(shape_id, "StatCard", x_in, y_in, w_in, h_in, [
        para_xml([run_xml(label, 12, color="E2E8F5")], align="ctr", space_after=4),
        para_xml([run_xml(value, 24, bold=True, color="FFFFFF")], align="ctr"),
    ], fill_hex=STAT_CARD_BLUE, rounded=True, anchor="ctr")


def write_dashboard(slide_path, grade_num, stats, mastery_chart_rel, spme_chart_rel):
    """Grade-wide dashboard, once right after the "How to use" slide -- 7
    stat cards (student/subject/standard counts + the S/P/M/E percentage
    split) plus the two subject-comparison charts, matching the reference
    template's slide 2 layout (stat-card grid over two side-by-side
    charts)."""
    shapes = []
    shapes.append(shape_xml(2, "Title", 0.5, 0.35, LOGO_X_IN - 0.7, 0.5,
        [para_xml([run_xml(f"GRADE {grade_num} ASSESSMENT DASHBOARD", 22, bold=True, color="1A1A1A")])]))

    row1 = [("Students", str(stats["students"])), ("Subjects", str(stats["subjects"])), ("Standards", str(stats["standards"]))]
    row2 = [
        ("Exceeding %", f'{stats["pct"]["E"]:.2f}'), ("Meeting %", f'{stats["pct"]["M"]:.2f}'),
        ("Progressing %", f'{stats["pct"]["P"]:.2f}'), ("Starting %", f'{stats["pct"]["S"]:.2f}'),
    ]

    shape_id = 3
    # Below the logo's bottom edge (LOGO_Y_IN + LOGO_H_IN = 1.206) -- the
    # 3rd card's x-range reaches under the logo, so it must clear it
    # vertically instead.
    row1_y, row1_h, row1_gap = 1.3, 0.85, 0.2
    row1_w = (9.0 - 2 * row1_gap) / 3
    for i, (label, value) in enumerate(row1):
        x = 0.5 + i * (row1_w + row1_gap)
        shapes.append(stat_card_xml(shape_id, x, row1_y, row1_w, row1_h, label, value)); shape_id += 1

    row2_y, row2_h, row2_gap = row1_y + row1_h + 0.15, 0.85, 0.15
    row2_w = (9.0 - 3 * row2_gap) / 4
    for i, (label, value) in enumerate(row2):
        x = 0.5 + i * (row2_w + row2_gap)
        shapes.append(stat_card_xml(shape_id, x, row2_y, row2_w, row2_h, label, value)); shape_id += 1

    charts_y = row2_y + row2_h + 0.3
    charts_h = SLIDE_H_IN - charts_y - 0.3
    chart_w = (9.0 - 0.3) / 2
    shapes.append(shape_xml(shape_id, "MasteryLabel", 0.5, charts_y, chart_w, 0.35,
        [para_xml([run_xml("Average Mastery Rate (Meeting + Exceeding) by Subject", 11, bold=True, color="4A4A4E")])])); shape_id += 1
    shapes.append(pic_xml(shape_id, "MasteryChart", "rId3", 0.5, charts_y + 0.35, chart_w, charts_h - 0.35)); shape_id += 1
    shapes.append(shape_xml(shape_id, "SPMELabel", 0.5 + chart_w + 0.3, charts_y, chart_w, 0.35,
        [para_xml([run_xml("S / P / M / E by Subject", 11, bold=True, color="4A4A4E")])])); shape_id += 1
    shapes.append(pic_xml(shape_id, "SPMEChart", "rId4", 0.5 + chart_w + 0.3, charts_y + 0.35, chart_w, charts_h - 0.35)); shape_id += 1

    shapes.append(pic_xml(shape_id + 1, "Logo", "rId2", LOGO_X_IN, LOGO_Y_IN, LOGO_W_IN, LOGO_H_IN))

    open(slide_path, "w").write(slide_doc("".join(shapes)))
    extra = image_rel_xml("rId3", mastery_chart_rel) + image_rel_xml("rId4", spme_chart_rel)
    write_rels(slide_path, "slideLayout2.xml", extra=extra)


def write_key_takeaways(slide_path, top_header, bottom_header, n_items=3):
    """Reusable placeholder slide -- once grade-wide ("Strong Subjects" /
    "Subjects Requiring Targeted Support and Intervention") and once per
    subject ("Strength" / "Work On Area"), matching the reference
    template's Key Takeaways slide structure. Bracketed placeholder bullets
    for manual fill-in, not auto-generated narrative -- this script has no
    basis to write "why" a subject is strong or weak, only a human
    reviewing the charts does."""
    shapes = []
    shapes.append(shape_xml(2, "Title", 0.5, 0.35, 9.0, 0.5,
        [para_xml([run_xml("KEY TAKEAWAYS", 24, bold=True, color="1A1A1A")], align="ctr")]))

    box_x, box_w = 0.5, 9.0
    top_y, top_h = 1.3, 2.6
    bottom_y, bottom_h = top_y + top_h + 0.1, 2.6

    def section(shape_id, y, h, header, fill_hex):
        shapes.append(shape_xml(shape_id, "SectionBox", box_x, y, box_w, h, [], fill_hex=fill_hex)); shape_id += 1
        shapes.append(shape_xml(shape_id, "SectionHeader", box_x + 0.3, y + 0.2, box_w - 0.6, 0.4,
            [para_xml([run_xml(header, 16, bold=True, color="1A1A1A")])])); shape_id += 1
        item_y = y + 0.75
        for i in range(n_items):
            shapes.append(shape_xml(shape_id, "Bullet", box_x + 0.3, item_y, box_w - 0.6, 0.55,
                [para_xml([run_xml(f"[Point {i + 1}]", 13, color="333333")], bullet=True)])); shape_id += 1
            item_y += 0.6
        return shape_id

    next_id = section(3, top_y, top_h, top_header, "EAF3EC")
    next_id = section(next_id, bottom_y, bottom_h, bottom_header, "FCF3DA")

    shapes.append(pic_xml(next_id, "Logo", "rId2", LOGO_X_IN, LOGO_Y_IN, LOGO_W_IN, LOGO_H_IN))
    open(slide_path, "w").write(slide_doc("".join(shapes)))
    write_rels(slide_path, "slideLayout2.xml")


SUBJECT_TITLE_BG = "2E3A4A"
SUBJECT_TITLE_ACCENT = "D9A441"


def write_subject_title(slide_path, subject, grade_num, period_label, stats):
    """Replaces the old plain write_divider() -- dark-background slide with
    a "[SUBJECT] . GRADE N . [PERIOD]" tag line, the subject's title, and
    its 3 headline stats (Students Assessed / Sections / Standards),
    matching the reference template's slide 4."""
    shapes = []
    shapes.append(shape_xml(2, "Tag", 0.6, 0.9, 8.8, 0.35,
        [para_xml([run_xml(f"{subject.upper()}  •  GRADE {grade_num}  •  {period_label.upper()}", 12, bold=True, color=SUBJECT_TITLE_ACCENT)])]))
    shapes.append(shape_xml(3, "Title", 0.6, 1.35, 8.8, 1.6,
        [para_xml([run_xml(f"{subject} Data Analysis — End of Term", 32, bold=True, color="FFFFFF")])]))

    stat_items = [
        (str(stats["students"]), "Students Assessed"),
        (str(stats["sections"]), "Sections / Classes"),
        (str(stats["standards"]), "Standards or Skills Measured"),
    ]
    stat_w = 8.8 / 3
    stat_y = 4.6
    for i, (value, label) in enumerate(stat_items):
        x = 0.6 + i * stat_w
        shapes.append(shape_xml(4 + i * 2, "StatValue", x, stat_y, stat_w - 0.3, 0.7,
            [para_xml([run_xml(value, 30, bold=True, color="FFFFFF")])]))
        shapes.append(shape_xml(5 + i * 2, "StatLabel", x, stat_y + 0.7, stat_w - 0.3, 0.4,
            [para_xml([run_xml(label, 11, color="C8CFD9")])]))

    shapes.append(pic_xml(10, "Logo", "rId2", LOGO_X_IN, LOGO_Y_IN, LOGO_W_IN, LOGO_H_IN))
    open(slide_path, "w").write(slide_doc("".join(shapes), bg_hex=SUBJECT_TITLE_BG))
    write_rels(slide_path, "slideLayout2.xml")


def write_subject_snapshot(slide_path, subject, stats, counts, donut_chart_rel):
    """Per-subject "grade-wide snapshot" -- the donut (just S/P/M/E letters
    on the wedges, from make_donut_chart) on the left, and a column of
    percentage callout rows on the right (colored bar + big % + band
    description), matching the reference template's actual layout rather
    than the generic title+image content slides everything else reuses."""
    total = sum(counts.get(k, 0) for k in STACK_ORDER) or 1
    shapes = []
    shapes.append(shape_xml(2, "Label", 0.5, 0.35, LOGO_X_IN - 0.7, 0.3,
        [para_xml([run_xml("DATA OVERVIEW", 11, bold=True, color="1C7293")])]))
    shapes.append(shape_xml(3, "Title", 0.5, 0.65, LOGO_X_IN - 0.7, 0.5,
        [para_xml([run_xml(f"{subject} grade-wide snapshot", 22, bold=True, color="1A1A1A")])]))
    shapes.append(shape_xml(4, "Subtitle", 0.5, 1.2, 9.0, 0.35,
        [para_xml([run_xml(f'{stats["students"]} students  •  {stats["standards"]} standards assessed', 13, color="6E6E73")])]))

    donut_x, donut_y, donut_w, donut_h = 0.5, 1.75, 3.68, 4.16
    shapes.append(pic_xml(5, "Donut", "rId3", donut_x, donut_y, donut_w, donut_h))
    shapes.append(shape_xml(6, "DonutCaption", donut_x, donut_y + donut_h + 0.05, donut_w, 0.35,
        [para_xml([run_xml("Grade-wide level distribution", 12, bold=True, color="1A1A1A")], align="ctr")]))

    col_x, col_w = 4.6, 4.9
    row_h = 1.15
    row_y0 = 1.9
    shape_id = 7
    for code, (name, _rng, desc, color_hex) in zip(STACK_ORDER, PROFICIENCY_BANDS):
        ry = row_y0 + STACK_ORDER.index(code) * row_h
        pct = counts.get(code, 0) / total * 100
        shapes.append(shape_xml(shape_id, "BandBar", col_x, ry, 0.1, 0.85, [], fill_hex=color_hex)); shape_id += 1
        shapes.append(shape_xml(shape_id, "BandPct", col_x + 0.3, ry - 0.08, 1.8, 0.55,
            [para_xml([run_xml(f"{pct:.1f}%", 26, bold=True, color="1A1A1A")])])); shape_id += 1
        shapes.append(shape_xml(shape_id, "BandDesc", col_x + 0.3, ry + 0.5, col_w - 0.3, 0.55,
            [para_xml([run_xml(f"{name} — {desc}", 12, color="4A4A4E")])])); shape_id += 1

    shapes.append(pic_xml(shape_id, "Logo", "rId2", LOGO_X_IN, LOGO_Y_IN, LOGO_W_IN, LOGO_H_IN)); shape_id += 1

    open(slide_path, "w").write(slide_doc("".join(shapes)))
    write_rels(slide_path, "slideLayout2.xml", extra=image_rel_xml("rId3", donut_chart_rel))


# Reference template's slide 8 content, copied as-is (per the brief: "you
# can use the template instructions as is") -- only the data-owner line
# substitutes the actual grade number in for its illustrative example.
GROUP_ROWS = [
    ("Intensive", "[Students at Starting Out on 3+ skills], grouped by shared weakest skill", "4–5x / week"),
    ("Targeted", "[Students Progressing on 2 skills], grouped by their specific skill pair", "2–3x / week"),
    ("Enrichment", "[Students Exceeding / high Meeting], extension tasks", "1x / week"),
]
LESSON_PLANNING_BULLETS = [
    "[Embed one grade-wide mini-lesson per week on the priority gap skill for the next 4 weeks.]",
    "[Use the class strength as a warm-up/scaffold before introducing harder content.]",
    "[Standardize a shared sentence-frame or protocol across sections to close section-to-section gaps.]",
    "[Re-run this assessment at the next checkpoint to measure movement.]",
]


def write_instructional_implications(slide_path, grade_num):
    """Per-subject placeholder, once after each subject's Key Takeaways --
    a small-group table and progress-monitoring cadence on the left, a dark
    "lesson-planning implications" sidebar on the right. Content copied
    from the reference template's slide 8 as-is (bracketed placeholders)."""
    shapes = []
    shapes.append(shape_xml(2, "Label", 0.5, 0.32, 5.8, 0.3,
        [para_xml([run_xml("INSTRUCTIONAL IMPLICATIONS", 11, bold=True, color="1C7293")])]))
    shapes.append(shape_xml(3, "Title", 0.5, 0.6, 5.8, 0.85,
        [para_xml([run_xml("Turning this data into groups, lessons, and progress checks", 19, bold=True, color="1A1A1A")])]))
    shapes.append(shape_xml(4, "Subtitle", 0.5, 1.5, 5.8, 0.45,
        [para_xml([run_xml("Translate the analysis above into concrete classroom moves for the next planning cycle.", 11, color="6E6E73")])]))

    shapes.append(shape_xml(5, "TableHeaderLabel", 0.5, 2.05, 5.8, 0.3,
        [para_xml([run_xml("Suggested small-group structure", 13, bold=True, color="1A1A1A")])]))

    table_y = 2.4
    col_x = [0.5, 1.75, 4.6]
    col_w = [1.25, 2.85, 1.2]
    row_h = 0.42
    header_h = 0.35
    headers = ["Group", "Composition", "Frequency"]
    shape_id = 6
    for c, (hx, hw, htext) in enumerate(zip(col_x, col_w, headers)):
        shapes.append(shape_xml(shape_id, "TableHeaderCell", hx, table_y, hw, header_h,
            [para_xml([run_xml(htext, 11, bold=True, color="FFFFFF")])], fill_hex="2E3A4A")); shape_id += 1
    for r, (group, comp, freq) in enumerate(GROUP_ROWS):
        ry = table_y + header_h + r * row_h
        row_fill = "F7F7F9" if r % 2 else "FFFFFF"
        for c, (cx, cw, text, bold) in enumerate([
            (col_x[0], col_w[0], group, True), (col_x[1], col_w[1], comp, False), (col_x[2], col_w[2], freq, False),
        ]):
            shapes.append(shape_xml(shape_id, "TableCell", cx, ry, cw, row_h,
                [para_xml([run_xml(text, 10, bold=bold, color="1A1A1A")])],
                fill_hex=row_fill, anchor="ctr")); shape_id += 1

    cadence_y = table_y + header_h + len(GROUP_ROWS) * row_h + 0.25
    shapes.append(shape_xml(shape_id, "CadenceHeader", 0.5, cadence_y, 5.8, 0.3,
        [para_xml([run_xml("Progress-monitoring cadence", 13, bold=True, color="1A1A1A")])])); shape_id += 1
    cadence_lines = [
        ("Intensive:", "[quick skill check every 2 weeks; move to Targeted after 2 consecutive on-target checks.]"),
        ("Targeted:", "[skill check every 3–4 weeks; move to core once the flagged skill reaches Progressing or above.]"),
    ]
    cy = cadence_y + 0.4
    for label, text in cadence_lines:
        shapes.append(shape_xml(shape_id, "CadenceLine", 0.5, cy, 5.8, 0.55,
            [para_xml([run_xml(f"{label}  ", 11, bold=True, color="1A1A1A"), run_xml(text, 11, color="4A4A4E")])])); shape_id += 1
        cy += 0.55

    # Sidebar -- starts below the logo's bottom edge (like the Dashboard
    # slide's stat-card row) rather than skipping the logo entirely:
    # slideLayout2.xml has its own background logo graphic baked in, which
    # bleeds through unobstructed on any slide that doesn't draw its own
    # logo pic over the same spot -- confirmed live, omitting it here left
    # a fragmented leftover visible instead of a clean gap.
    sb_x, sb_w = 6.6, 2.9
    sb_y, sb_h = LOGO_Y_IN + LOGO_H_IN + 0.1, 5.85
    shapes.append(shape_xml(shape_id, "Sidebar", sb_x, sb_y, sb_w, sb_h, [], fill_hex="2E3A4A", rounded=True)); shape_id += 1
    shapes.append(shape_xml(shape_id, "SidebarHeader", sb_x + 0.3, sb_y + 0.28, sb_w - 0.6, 0.4,
        [para_xml([run_xml("LESSON-PLANNING IMPLICATIONS", 11, bold=True, color=SUBJECT_TITLE_ACCENT)])])); shape_id += 1
    by = sb_y + 0.78
    for bullet in LESSON_PLANNING_BULLETS:
        shapes.append(shape_xml(shape_id, "SidebarBullet", sb_x + 0.3, by, sb_w - 0.6, 0.95,
            [para_xml([run_xml(bullet, 11, color="E8ECF2")], bullet=True)])); shape_id += 1
        by += 1.0

    shapes.append(shape_xml(shape_id, "DataOwner", sb_x + 0.3, sb_y + sb_h - 0.75, sb_w - 0.6, 0.7, [
        para_xml([run_xml("Data owner:  ", 10, bold=True, color=SUBJECT_TITLE_ACCENT),
                  run_xml(f"[Role, e.g. Grade {grade_num} Subject Lead] compiles this analysis after each check-in for the Head of School.", 10, color="C8CFD9")]),
    ])); shape_id += 1

    shapes.append(pic_xml(shape_id, "Logo", "rId2", LOGO_X_IN, LOGO_Y_IN, LOGO_W_IN, LOGO_H_IN)); shape_id += 1

    open(slide_path, "w").write(slide_doc("".join(shapes)))
    write_rels(slide_path, "slideLayout2.xml")


def next_media_name(unpacked, ext):
    media_dir = f"{unpacked}/ppt/media"
    nums = []
    for f in os.listdir(media_dir):
        m = re.match(r"image(\d+)\.", f)
        if m:
            nums.append(int(m.group(1)))
    n = max(nums) + 1
    return f"image{n}.{ext}"


def fix_title_slide(unpacked, grade_num, session_label, subtitle_label):
    path = f"{unpacked}/ppt/slides/slide1.xml"
    xml = open(path).read()
    xml = xml.replace("2025-26", session_label)
    if subtitle_label:
        xml = xml.replace("(TERM-I)", subtitle_label)
    else:
        # no term qualifier for this dataset: drop the "(TERM-I)" run together
        # with its line breaks so we don't leave a blank line on the slide
        xml = re.sub(
            r"<a:br>(?:(?!<a:br).)*?</a:br><a:r>(?:(?!</a:r>).)*?<a:t>\(TERM-I\)</a:t></a:r><a:br>(?:(?!<a:br).)*?</a:br>",
            "",
            xml,
            flags=re.S,
        )
    xml = xml.replace("Grade 7", f"Grade {grade_num}")
    open(path, "w").write(xml)


def assemble(unpacked, subject_order, blocks, grade_num, session_label, subtitle_label,
             grade_chart_path=None, subject_donut_chart=None, subject_section_chart=None,
             subject_standard_chart=None, mastery_chart_path=None, grade_stats=None,
             subject_stats_map=None, period_label="", grade_summary=None):
    subject_donut_chart = subject_donut_chart or {}
    subject_section_chart = subject_section_chart or {}
    subject_standard_chart = subject_standard_chart or {}
    grade_summary = grade_summary or {}
    subject_stats_map = subject_stats_map or {}

    fix_title_slide(unpacked, grade_num, session_label, subtitle_label)

    slides_dir = f"{unpacked}/ppt/slides"
    existing_nums = [
        int(m.group(1)) for f in os.listdir(slides_dir)
        if (m := re.match(r"slide(\d+)\.xml", f))
    ]
    next_num = max(existing_nums) + 1

    pres_path = f"{unpacked}/ppt/presentation.xml"
    pres_rels_path = f"{unpacked}/ppt/_rels/presentation.xml.rels"
    pres_xml = open(pres_path).read()
    pres_rels_xml = open(pres_rels_path).read()

    existing_rids = [int(m.group(1)) for m in re.finditer(r'Id="rId(\d+)"', pres_rels_xml)]
    next_rid = max(existing_rids) + 1
    existing_sldids = [int(m.group(1)) for m in re.finditer(r'<p:sldId id="(\d+)"', pres_xml)]
    next_sldid = max(existing_sldids) + 1

    ct_path = f"{unpacked}/[Content_Types].xml"
    ct_xml = open(ct_path).read()

    new_sldid_entries = []
    new_rels_entries = []
    new_ct_overrides = []

    # next_num/next_rid/next_sldid are captured by reference via a mutable
    # cell (a single-element list) since the nested functions below need to
    # both read and advance them -- Python closures can't rebind an outer
    # int, only mutate a shared container.
    counters = {"num": next_num, "rid": next_rid, "sldid": next_sldid}

    def add_slide(slide_name):
        new_ct_overrides.append(slide_name)
        rid = f"rId{counters['rid']}"
        new_rels_entries.append(
            f'<Relationship Id="{rid}" '
            f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" '
            f'Target="slides/{slide_name}"/>'
        )
        new_sldid_entries.append(f'<p:sldId id="{counters["sldid"]}" r:id="{rid}"/>')
        counters["num"] += 1
        counters["rid"] += 1
        counters["sldid"] += 1

    def add_content(title, chart_path, chart_w_in=9.0, chart_h_in=4.2):
        import shutil
        chart_name = next_media_name(unpacked, "png")
        shutil.copy(chart_path, f"{unpacked}/ppt/media/{chart_name}")
        slide_name = f"slide{counters['num']}.xml"
        write_content(f"{slides_dir}/{slide_name}", title, f"../media/{chart_name}",
                      chart_w_in=chart_w_in, chart_h_in=chart_h_in)
        add_slide(slide_name)
        print("  content:", slide_name, title[:60])

    def add_static(write_fn, *args, label=""):
        slide_name = f"slide{counters['num']}.xml"
        write_fn(f"{slides_dir}/{slide_name}", *args)
        add_slide(slide_name)
        print("  static:", slide_name, label or write_fn.__name__)

    def add_dashboard(mastery_path, spme_path):
        import shutil
        mastery_name = next_media_name(unpacked, "png")
        shutil.copy(mastery_path, f"{unpacked}/ppt/media/{mastery_name}")
        spme_name = next_media_name(unpacked, "png")
        shutil.copy(spme_path, f"{unpacked}/ppt/media/{spme_name}")
        slide_name = f"slide{counters['num']}.xml"
        write_dashboard(f"{slides_dir}/{slide_name}", grade_num, grade_stats, f"../media/{mastery_name}", f"../media/{spme_name}")
        add_slide(slide_name)
        print("  dashboard:", slide_name)

    def add_snapshot(subject, stats, counts, donut_path):
        import shutil
        donut_name = next_media_name(unpacked, "png")
        shutil.copy(donut_path, f"{unpacked}/ppt/media/{donut_name}")
        slide_name = f"slide{counters['num']}.xml"
        write_subject_snapshot(f"{slides_dir}/{slide_name}", subject, stats, counts, f"../media/{donut_name}")
        add_slide(slide_name)
        print("  snapshot:", slide_name, subject)

    add_static(write_how_to_use, label="How to use this deck")

    if grade_stats and mastery_chart_path and grade_chart_path:
        add_dashboard(mastery_chart_path, grade_chart_path)
        add_static(write_key_takeaways, "Strong Subjects", "Subjects Requiring Targeted Support and Intervention",
                   label="Key Takeaways (grade-wide)")

    for subject in subject_order:
        subject_blocks = [b for b in blocks if b["subject"] == subject and b["classes"]]
        if not subject_blocks:
            continue

        stats = subject_stats_map.get(subject, {"students": 0, "sections": 0, "standards": len(subject_blocks)})
        add_static(write_subject_title, subject, grade_num, period_label, stats, label=subject)

        if subject in subject_donut_chart:
            add_snapshot(subject, stats, grade_summary.get(subject, {}), subject_donut_chart[subject])
        if subject in subject_section_chart:
            add_content(f"{subject} — Performance by Section", subject_section_chart[subject])
        if subject in subject_standard_chart:
            add_content(f"{subject} — Performance by Standard", subject_standard_chart[subject])

        for b in subject_blocks:
            add_content(b["title"], b["chart_path"])

        add_static(write_key_takeaways, "Strength", "Work On Area", label=f"Key Takeaways ({subject})")
        add_static(write_instructional_implications, grade_num, label=f"Instructional Implications ({subject})")

    # only keep the first two original slides (title, benchmarking) in the deck;
    # everything else from the sample template gets dropped
    m = re.search(r"(<p:sldIdLst>)(.*?)(</p:sldIdLst>)", pres_xml, re.S)
    old_entries = re.findall(r'<p:sldId[^/]*/>', m.group(2))
    kept_entries = old_entries[:2]
    new_lst = m.group(1) + "".join(kept_entries) + "".join(new_sldid_entries) + m.group(3)
    pres_xml = pres_xml[: m.start()] + new_lst + pres_xml[m.end():]
    open(pres_path, "w").write(pres_xml)

    pres_rels_xml = pres_rels_xml.replace(
        "</Relationships>", "".join(new_rels_entries) + "</Relationships>"
    )
    open(pres_rels_path, "w").write(pres_rels_xml)

    overrides_xml = "".join(
        f'<Override PartName="/ppt/slides/{name}" '
        f'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        for name in new_ct_overrides
    )
    ct_xml = ct_xml.replace("</Types>", overrides_xml + "</Types>")
    open(ct_path, "w").write(ct_xml)
