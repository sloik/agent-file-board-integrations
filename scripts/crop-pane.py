#!/usr/bin/env python3
"""Crop the docked pane out of an ANSI tmux capture, keeping colours.

Used to make the README screenshots: only the pane is kept, so the session's own
transcript, paths and status line never reach an image.

Usage: tmux capture-pane -e -p -t SESSION | scripts/crop-pane.py > pane.ansi
       freeze pane.ansi -o docs/images/x.png
The pane's left edge is the column of the vertical border '│' that the most lines share.
"""
import re
import sys
import unicodedata
from collections import Counter

ESC = re.compile(r"\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])")


def width(ch: str) -> int:
    if unicodedata.combining(ch) or ch in "‍️︎":
        return 0
    return 2 if unicodedata.east_asian_width(ch) in "WF" else 1


def cells(line: str):
    """Yields (escape_or_char, column_before, width)."""
    col, pos = 0, 0
    while pos < len(line):
        m = ESC.match(line, pos)
        if m:
            yield m.group(0), col, 0
            pos = m.end()
            continue
        ch = line[pos]
        w = width(ch)
        yield ch, col, w
        col += w
        pos += 1


def border_column(lines):
    counts = Counter()
    for line in lines:
        for text, col, _ in cells(line):
            if text == "│" and col > 20:
                counts[col] += 1
    return counts.most_common(1)[0][0] if counts else 0


def main():
    lines = sys.stdin.read().split("\n")
    left = border_column(lines) + 1
    out = []
    for line in lines:
        kept = [text for text, col, w in cells(line) if w == 0 or col >= left]
        plain = ESC.sub("", "".join(kept)).strip()
        if "───" in plain:
            continue  # rules of the prompt box, which can carry the session's title
        out.append("".join(kept) + "\x1b[0m")
    while out and not ESC.sub("", out[-1]).strip():
        out.pop()
    sys.stdout.write("\n".join(out) + "\n")


if __name__ == "__main__":
    main()
