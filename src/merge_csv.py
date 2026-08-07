"""
Merges every CSV in a folder into one combined CSV -- keeps the header from
the first file, drops repeated headers from the rest, and warns (but doesn't
fail) if a later file's header doesn't match. Doesn't interpret columns at
all, just concatenates rows, so it works the same way for either raw section
CSVs (Year,Class,Subject,Path,NodeName,Type,ShortName,S,P,M,E) or filtered
ones (Year,Class,Subject,Standard,S,P,M,E) -- useful for handing off one
combined file instead of one-per-section, independent of building the deck.

Usage: python3 src/merge_csv.py <folder> <output_csv> [grade_prefix]

grade_prefix is optional -- section CSVs are named "<Grade>_<Section>.csv"
(e.g. "VII_A.csv"), but the containing data/<year>/<term>/ folder isn't
itself grade-scoped, so if more than one grade was ever extracted into the
same year/term it can hold a mix. Passing e.g. "VII" only merges files whose
name starts with "VII_" (case-insensitive); omit it to merge everything in
the folder as before.

*_ROC.csv (Socio-Emotional Learning's R/O/C-graded rows) is always excluded
here -- it uses a different column schema (R/O/C instead of S/P/M/E) than
every other file this merges, so mixing it in would silently misalign
columns under the wrong header rather than actually combine compatible data.
"""
import csv
import os
import sys


def merge_csv(folder, out_path, grade_prefix=None):
    files = sorted(
        f for f in os.listdir(folder)
        if f.lower().endswith(".csv") and not f.endswith("_ROC.csv")
    )
    if grade_prefix:
        prefix = f"{grade_prefix.lower()}_"
        files = [f for f in files if f.lower().startswith(prefix)]
    if not files:
        scope = f' matching Grade "{grade_prefix}"' if grade_prefix else ""
        raise SystemExit(f"No CSV files found in {folder}{scope}")

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    header = None
    row_count = 0
    with open(out_path, "w", newline="", encoding="utf-8") as out_f:
        writer = csv.writer(out_f)
        for fname in files:
            with open(os.path.join(folder, fname), newline="", encoding="utf-8") as in_f:
                rows = list(csv.reader(in_f))
            if not rows:
                continue
            file_header, body = rows[0], rows[1:]
            if header is None:
                header = file_header
                writer.writerow(header)
            elif file_header != header:
                print(f"⚠️  {fname}: header {file_header} doesn't match {header} -- merging its rows anyway")
            writer.writerows(body)
            row_count += len(body)

    return row_count, len(files)


def main():
    if len(sys.argv) < 3:
        print("usage: python3 src/merge_csv.py <folder> <output_csv> [grade_prefix]")
        sys.exit(1)
    folder, out_path = sys.argv[1], sys.argv[2]
    grade_prefix = sys.argv[3] if len(sys.argv) > 3 else None
    row_count, file_count = merge_csv(folder, out_path, grade_prefix)
    print(f"✅ Merged {file_count} file(s), {row_count} row(s) -> {out_path}")


if __name__ == "__main__":
    main()
