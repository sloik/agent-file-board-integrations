#!/usr/bin/env python3
"""Keeps the top HEIGHT rows of an 8-bit PNG (no dependencies).

The kept scanlines are copied as filtered bytes: a PNG row filter only refers
to rows above it, so rows 0..HEIGHT-1 stay valid without re-filtering.
Usage: png-top.py IN.png HEIGHT OUT.png
"""
import struct
import sys
import zlib


def chunks(data):
    pos = 8
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        yield kind, data[pos + 8:pos + 8 + length]
        pos += 12 + length


def chunk(kind, body):
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)


def main():
    src, height, dst = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    data = open(src, "rb").read()
    parts = list(chunks(data))
    ihdr = parts[0][1]
    width, h, depth, color = struct.unpack(">IIBB", ihdr[:10])
    if depth != 8 or color not in (2, 6) or ihdr[12] != 0:
        sys.exit(f"png-top: unsupported PNG (depth {depth}, color {color}, interlace {ihdr[12]})")
    bpp = 4 if color == 6 else 3
    raw = zlib.decompress(b"".join(body for kind, body in parts if kind == b"IDAT"))
    keep = min(height, h)
    rows = raw[: keep * (1 + width * bpp)]
    out = data[:8] + chunk(b"IHDR", struct.pack(">II", width, keep) + ihdr[8:])
    out += chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")
    open(dst, "wb").write(out)


if __name__ == "__main__":
    main()
