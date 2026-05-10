"""
Erzeugt einfache PNG-Icons (16/48/128 px) für die Chrome-Extension.
Ohne Abhängigkeiten — nur Standardbibliothek (struct + zlib).
Aufruf:  python generate_icons.py
"""

import struct
import zlib
from pathlib import Path


YELLOW = (255, 204, 0)
RED = (212, 5, 17)


def make_png(width: int, height: int, pixel_func) -> bytes:
    raw = b""
    for y in range(height):
        raw += b"\x00"  # PNG filter byte
        for x in range(width):
            r, g, b = pixel_func(x, y)
            raw += bytes([r, g, b])

    def chunk(tag: bytes, data: bytes) -> bytes:
        cd = tag + data
        return struct.pack(">I", len(data)) + cd + struct.pack(">I", zlib.crc32(cd) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    idat = zlib.compress(raw)

    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def dhl_pixel(size: int):
    bar = max(2, int(round(size * 0.18)))

    def pixel(x: int, y: int):
        if y < bar:
            return RED
        return YELLOW

    return pixel


def main():
    out = Path(__file__).parent / "icons"
    out.mkdir(exist_ok=True)
    for size in (16, 48, 128):
        data = make_png(size, size, dhl_pixel(size))
        (out / f"icon{size}.png").write_bytes(data)
        print(f"  -> icons/icon{size}.png ({size}x{size})")


if __name__ == "__main__":
    main()
