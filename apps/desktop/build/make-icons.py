"""Generates the app icons from one drawing.

Run with `python3 build/make-icons.py` after changing the mark. The output is
committed so packaging does not depend on Python being present.
"""
from PIL import Image, ImageDraw
import os, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SIZE = 1024
INDIGO = (99, 102, 241, 255)
DEEP = (67, 56, 202, 255)
PAPER = (255, 255, 255, 255)
INK = (226, 226, 240, 255)


def rounded(size):
    """The rounded-square app tile with a page mark and a folded corner."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = size / SIZE

    # Tile with a vertical indigo gradient.
    tile = Image.new("RGBA", (size, size), INDIGO)
    grad = Image.new("RGBA", (1, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        grad.putpixel((0, y), tuple(round(INDIGO[i] + (DEEP[i] - INDIGO[i]) * t) for i in range(4)))
    tile = grad.resize((size, size))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(224 * s), fill=255)
    img.paste(tile, (0, 0), mask)

    # The page: a rectangle with its top-right corner folded away.
    left, top, right, bottom, fold = 296 * s, 232 * s, 728 * s, 792 * s, 132 * s
    page = [
        (left, top), (right - fold, top), (right, top + fold),
        (right, bottom), (left, bottom),
    ]
    d.polygon(page, fill=PAPER)
    d.polygon([(right - fold, top), (right, top + fold), (right - fold, top + fold)], fill=INK)

    # Text lines.
    for i, y in enumerate((430, 520, 610, 700)):
        end = right - (fold if i == 3 else 0) - 60 * s
        d.rounded_rectangle(
            [left + 64 * s, y * s, end, (y + 34) * s], radius=17 * s, fill=(148, 152, 200, 255)
        )
    return img


def main():
    master = rounded(SIZE)
    master.save(os.path.join(HERE, "icon.png"))

    # macOS .icns via iconutil, which wants a .iconset directory.
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.makedirs(iconset)
        for px in (16, 32, 64, 128, 256, 512, 1024):
            rounded(px).save(os.path.join(iconset, f"icon_{px}x{px}.png"))
            half = px // 2
            if half >= 16:
                rounded(px).save(os.path.join(iconset, f"icon_{half}x{half}@2x.png"))
        subprocess.run(
            ["iconutil", "-c", "icns", iconset, "-o", os.path.join(HERE, "icon.icns")], check=True
        )

    # Windows .ico. Pillow writes every size into the one file.
    master.save(
        os.path.join(HERE, "icon.ico"),
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("wrote icon.png, icon.icns, icon.ico")


if __name__ == "__main__":
    main()
