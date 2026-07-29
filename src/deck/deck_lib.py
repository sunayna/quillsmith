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


def make_chart(classes, out_path):
    class_labels = sorted(classes.keys(), key=class_sort_key)
    n = len(class_labels)

    fig, ax = plt.subplots(figsize=(9, 4.2), dpi=150)
    x = range(n)
    bottoms = [0] * n

    for key in STACK_ORDER:
        vals = [classes[cl][key] for cl in class_labels]
        ax.bar(x, vals, bottom=bottoms, color=COLORS[key], width=0.62, edgecolor="none")
        for i, (v, b) in enumerate(zip(vals, bottoms)):
            if v == 0:
                continue
            ax.text(
                i, b + v / 2, str(v), ha="center", va="center",
                fontsize=11, color="#222222" if key in ("P", "M") else "white",
            )
        bottoms = [b + v for b, v in zip(bottoms, vals)]

    ax.set_xticks(list(x))
    ax.set_xticklabels(class_labels, fontsize=12)
    ax.set_xlabel("Class and Section", fontsize=11, labelpad=8)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_visible(False)
    ax.tick_params(axis="y", labelsize=10, length=0)
    ax.tick_params(axis="x", length=0)
    ax.yaxis.grid(True, color="#DDDDDD", linewidth=0.8)
    ax.set_axisbelow(True)

    max_total = max(sum(classes[cl].values()) for cl in class_labels)
    ax.set_ylim(0, max(max_total, 1) * 1.12)

    handles = [plt.Rectangle((0, 0), 1, 1, color=COLORS[k]) for k in LEGEND_ORDER]
    ax.legend(
        handles, LEGEND_ORDER, loc="upper center", bbox_to_anchor=(0.5, 1.14),
        ncol=4, frameon=False, fontsize=12, handlelength=1.2, handleheight=1.2,
        columnspacing=1.5,
    )

    fig.tight_layout(rect=[0, 0, 1, 0.94])
    fig.savefig(out_path, transparent=True)
    plt.close(fig)


# ---------------------------------------------------------------------------
# Slide XML templates
# ---------------------------------------------------------------------------

DIVIDER_SLIDE_TEMPLATE = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="{box_x}" y="{box_y}"/><a:ext cx="{box_w}" cy="{box_h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="lt1"/></a:solidFill><a:ln cap="flat" cmpd="sng" w="19050"><a:solidFill><a:srgbClr val="833C0B"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/><a:headEnd len="sm" w="sm" type="none"/><a:tailEnd len="sm" w="sm" type="none"/></a:ln></p:spPr><p:txBody><a:bodyPr anchorCtr="0" anchor="ctr" bIns="45700" lIns="91425" spcFirstLastPara="1" rIns="91425" wrap="square" tIns="45700"><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr indent="0" lvl="0" marL="0" marR="0" rtl="0" algn="ctr"><a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPts val="0"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft><a:buNone/></a:pPr><a:r><a:rPr b="1" i="0" lang="en-IN" sz="{title_sz}" u="none" cap="none" strike="noStrike"><a:solidFill><a:srgbClr val="385623"/></a:solidFill><a:latin typeface="Arial"/><a:ea typeface="Arial"/><a:cs typeface="Arial"/><a:sym typeface="Arial"/></a:rPr><a:t>{title}</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="3" name="Logo"/><p:cNvPicPr preferRelativeResize="0"/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"><a:alphaModFix/></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="6095775" y="327375"/><a:ext cx="2962600" cy="774975"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"""

CONTENT_SLIDE_TEMPLATE = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="{title_x}" y="{title_y}"/><a:ext cx="{title_w}" cy="{title_h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr anchorCtr="0" anchor="t" bIns="0" lIns="0" spcFirstLastPara="1" rIns="0" wrap="square" tIns="0"><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr indent="0" lvl="0" marL="0" marR="0" rtl="0" algn="l"><a:lnSpc><a:spcPct val="115000"/></a:lnSpc><a:spcBef><a:spcPts val="0"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft><a:buNone/></a:pPr><a:r><a:rPr b="1" i="0" lang="en-IN" sz="{title_sz}" u="none" cap="none" strike="noStrike"><a:solidFill><a:srgbClr val="1A1A1A"/></a:solidFill><a:latin typeface="Arial"/><a:ea typeface="Arial"/><a:cs typeface="Arial"/><a:sym typeface="Arial"/></a:rPr><a:t>{title}</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="3" name="Logo"/><p:cNvPicPr preferRelativeResize="0"/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"><a:alphaModFix/></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="6095775" y="327375"/><a:ext cx="2962600" cy="774975"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr></p:pic><p:pic><p:nvPicPr><p:cNvPr id="4" name="Chart"/><p:cNvPicPr preferRelativeResize="0"/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId3"><a:alphaModFix/></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="{chart_x}" y="{chart_y}"/><a:ext cx="{chart_w}" cy="{chart_h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"""

RELS_TEMPLATE = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/{layout}"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="{logo_target}"/>{extra}</Relationships>"""

LOGO_REL_TARGET = "../media/image13.jpg"


def in_emu(inches):
    return int(round(inches * 914400))


def divider_font_size(text):
    box_w_in = 8.5
    usable_pt = (box_w_in - 0.2) * 72
    size_pt = usable_pt / (len(text) * 0.58)
    size_pt = max(28, min(96, size_pt))
    return int(size_pt * 100)


def write_divider(slide_path, title):
    box_w_in = 8.5
    box_h_in = 1.8
    box_x = in_emu((SLIDE_W_IN - box_w_in) / 2)
    box_y = in_emu(2.85)
    box_w = in_emu(box_w_in)
    box_h = in_emu(box_h_in)
    xml = DIVIDER_SLIDE_TEMPLATE.format(
        title=escape(title), title_sz=divider_font_size(title),
        box_x=box_x, box_y=box_y, box_w=box_w, box_h=box_h,
    )
    open(slide_path, "w").write(xml)
    rels_path = slide_path.replace("/slides/", "/slides/_rels/") + ".rels"
    open(rels_path, "w").write(
        RELS_TEMPLATE.format(layout="slideLayout2.xml", logo_target=LOGO_REL_TARGET, extra="")
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


def write_content(slide_path, title, chart_rel_target):
    title_x = in_emu(0.5)
    title_y_in = 1.35
    title_y = in_emu(title_y_in)
    title_w_in = SLIDE_W_IN - 1.0
    sz, title_h_in = fit_title(title, title_w_in)
    title_w = in_emu(title_w_in)
    title_h = in_emu(title_h_in)

    chart_w_in = 9.0
    chart_h_in = 4.2
    chart_x = in_emu((SLIDE_W_IN - chart_w_in) / 2)
    chart_y_in = title_y_in + title_h_in + 0.25
    chart_h_in = min(chart_h_in, SLIDE_H_IN - 0.3 - chart_y_in)
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


def assemble(unpacked, subject_order, blocks, grade_num, session_label, subtitle_label):
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

    for subject in subject_order:
        subject_blocks = [b for b in blocks if b["subject"] == subject and b["classes"]]
        if not subject_blocks:
            continue

        # divider slide
        slide_name = f"slide{next_num}.xml"
        write_divider(f"{slides_dir}/{slide_name}", subject)
        new_ct_overrides.append(slide_name)
        rid = f"rId{next_rid}"
        new_rels_entries.append(
            f'<Relationship Id="{rid}" '
            f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" '
            f'Target="slides/{slide_name}"/>'
        )
        new_sldid_entries.append(f'<p:sldId id="{next_sldid}" r:id="{rid}"/>')
        next_num += 1
        next_rid += 1
        next_sldid += 1
        print("divider:", slide_name, subject)

        for b in subject_blocks:
            chart_name = next_media_name(unpacked, "png")
            import shutil
            shutil.copy(b["chart_path"], f"{unpacked}/ppt/media/{chart_name}")

            slide_name = f"slide{next_num}.xml"
            write_content(f"{slides_dir}/{slide_name}", b["title"], f"../media/{chart_name}")
            new_ct_overrides.append(slide_name)
            rid = f"rId{next_rid}"
            new_rels_entries.append(
                f'<Relationship Id="{rid}" '
                f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" '
                f'Target="slides/{slide_name}"/>'
            )
            new_sldid_entries.append(f'<p:sldId id="{next_sldid}" r:id="{rid}"/>')
            next_num += 1
            next_rid += 1
            next_sldid += 1
            print("  content:", slide_name, b["title"][:60])

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
