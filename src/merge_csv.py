"""
Merges every CSV in a folder into one combined Excel workbook -- keeps the
header from the first file, drops repeated headers from the rest, and warns
(but doesn't fail) if a later file's header doesn't match. Doesn't interpret
columns at all, just concatenates rows, so it works the same way for either
raw section CSVs (Year,Class,Subject,Path,NodeName,Type,ShortName,S,P,M,E) or
filtered ones (Year,Class,Subject,Standard,S,P,M,E) -- useful for handing off
one combined file instead of one-per-section, independent of building the
deck. The source data stays CSV, one file per section -- only this merged
hand-off file is xlsx, since it's meant to be opened and looked at, not read
back by the rest of the pipeline.

Usage: python3 src/merge_csv.py <folder> <output_xlsx> [grade_prefix] [scale_suffix]

grade_prefix is optional -- section CSVs are named "<Grade>_<Section>.csv"
(e.g. "VII_A.csv"), but the containing data/<year>/<term>/ folder isn't
itself grade-scoped, so if more than one grade was ever extracted into the
same year/term it can hold a mix. Passing e.g. "VII" only merges files whose
name starts with "VII_" (case-insensitive); omit it to merge everything in
the folder as before.

scale_suffix selects which per-scale file family to merge -- files on a
non-default grading scale (currently just Socio-Emotional Learning's R/O/C
marks) are written by extract.js to their own "*_ROC.csv" companion instead
of the main file, since mixing R/O/C columns into an S/P/M/E file would
silently misalign columns under the wrong header rather than actually
combine compatible data. Omit scale_suffix (the default) to merge the main
files, which always excludes *_ROC.csv; pass "_ROC" to merge only the SEL
companions across sections instead.
"""
import csv
import os
import sys

import openpyxl
from openpyxl.styles import Font


def coerce_cell(value):
    """CSV gives every cell back as a string -- turn the count columns
    (S/P/M/E, R/O/C) back into real numbers so Excel can sum/sort/filter
    them, while leaving genuinely text cells (Year, Subject, NodeName, ...)
    as text."""
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        return value


def merge_csv(folder, out_path, grade_prefix=None, scale_suffix=""):
    all_files = sorted(f for f in os.listdir(folder) if f.lower().endswith(".csv"))
    if scale_suffix:
        files = [f for f in all_files if f.endswith(f"{scale_suffix}.csv")]
    else:
        files = [f for f in all_files if not f.endswith("_ROC.csv")]
    if grade_prefix:
        prefix = f"{grade_prefix.lower()}_"
        files = [f for f in files if f.lower().startswith(prefix)]
    if not files:
        scope = f' matching Grade "{grade_prefix}"' if grade_prefix else ""
        scale = f" (scale {scale_suffix!r})" if scale_suffix else ""
        raise SystemExit(f"No CSV files found in {folder}{scope}{scale}")

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Merged"

    header = None
    row_count = 0
    for fname in files:
        with open(os.path.join(folder, fname), newline="", encoding="utf-8") as in_f:
            rows = list(csv.reader(in_f))
        if not rows:
            continue
        file_header, body = rows[0], rows[1:]
        if header is None:
            header = file_header
            ws.append(header)
            for cell in ws[1]:
                cell.font = Font(bold=True)
            ws.freeze_panes = "A2"
        elif file_header != header:
            print(f"⚠️  {fname}: header {file_header} doesn't match {header} -- merging its rows anyway")
        for row in body:
            ws.append([coerce_cell(v) for v in row])
        row_count += len(body)

    for col_cells in ws.columns:
        max_len = max((len(str(c.value)) for c in col_cells if c.value is not None), default=10)
        ws.column_dimensions[col_cells[0].column_letter].width = min(max(max_len + 2, 10), 60)

    wb.save(out_path)
    return row_count, len(files)


def main():
    if len(sys.argv) < 3:
        print("usage: python3 src/merge_csv.py <folder> <output_xlsx> [grade_prefix] [scale_suffix]")
        sys.exit(1)
    folder, out_path = sys.argv[1], sys.argv[2]
    grade_prefix = sys.argv[3] if len(sys.argv) > 3 else None
    scale_suffix = sys.argv[4] if len(sys.argv) > 4 else ""
    row_count, file_count = merge_csv(folder, out_path, grade_prefix, scale_suffix)
    print(f"✅ Merged {file_count} file(s), {row_count} row(s) -> {out_path}")


if __name__ == "__main__":
    main()
