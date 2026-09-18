"""Generates the app icons from the logo artwork.

Run with `python3 apps/desktop/build/make-icons.py` after changing
`resources/ParaDOCs logo.jpeg`. The output is committed so packaging does not
depend on Python being present:

- apps/desktop/build/icon.png, icon.icns, icon.ico  (the desktop app)
- apps/web/public/favicon.png, apple-touch-icon.png (the browser tab)

The artwork is a flat JPEG: the tile sits on a light, neutral background with a
soft grey shadow. The tile is the only strongly coloured thing in it, so it is
cut out by colour — anything with little difference between its red, green and
blue is background or shadow — and the white mark inside it, which is neutral
too, is filled back in as whatever the background cannot reach.
"""
from PIL import Image, ImageChops, ImageDraw, ImageFilter
import os, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
SOURCE = os.path.join(ROOT, "resources", "ParaDOCs logo.jpeg")
WEB_PUBLIC = os.path.join(ROOT, "apps", "web", "public")

SIZE = 1024
# How much of a desktop icon's square the tile fills. macOS icons leave a
# margin around the artwork (824 of 1024), so the tile sits in line with
# the icons beside it in the Dock.
DESKTOP_FILL = 824 / 1024
# A browser tab is tiny; the tile fills nearly all of it to stay legible.
WEB_FILL = 0.96

# Below this spread between a pixel's strongest and weakest channel, it is background.
CHROMA_THRESHOLD = 14


def cut_out_tile():
    """The tile alone, on transparency, cropped tight."""
    src = Image.open(SOURCE).convert("RGB")
    r, g, b = src.split()
    chroma = ImageChops.subtract(
        ImageChops.lighter(ImageChops.lighter(r, g), b),
        ImageChops.darker(ImageChops.darker(r, g), b),
    )
    coloured = chroma.point(lambda v: 255 if v > CHROMA_THRESHOLD else 0)

    # Flood the background in from a corner; what it cannot reach is the tile,
    # the white mark included.
    reached = coloured.copy()
    ImageDraw.floodfill(reached, (0, 0), 128)
    mask = reached.point(lambda v: 0 if v == 128 else 255)

    # Trim the pixels at the rim that are half background, then soften the edge.
    mask = mask.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.GaussianBlur(1.5))

    box = mask.getbbox()
    tile = src.crop(box).convert("RGBA")
    tile.putalpha(mask.crop(box))
    return tile


def square(tile, size, fill):
    """The tile centred on a transparent square, its longer side `fill` of the width."""
    scale = size * fill / max(tile.size)
    w, h = max(1, round(tile.width * scale)), max(1, round(tile.height * scale))
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(tile.resize((w, h), Image.LANCZOS), ((size - w) // 2, (size - h) // 2))
    return canvas


def main():
    tile = cut_out_tile()
    master = square(tile, SIZE, DESKTOP_FILL)
    master.save(os.path.join(HERE, "icon.png"))

    # macOS .icns via iconutil, which wants a .iconset directory.
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.makedirs(iconset)
        for px in (16, 32, 64, 128, 256, 512, 1024):
            image = square(tile, px, DESKTOP_FILL)
            image.save(os.path.join(iconset, f"icon_{px}x{px}.png"))
            half = px // 2
            if half >= 16:
                image.save(os.path.join(iconset, f"icon_{half}x{half}@2x.png"))
        subprocess.run(
            ["iconutil", "-c", "icns", iconset, "-o", os.path.join(HERE, "icon.icns")], check=True
        )

    # Windows .ico. Pillow writes every size into the one file.
    square(tile, 256, DESKTOP_FILL).save(
        os.path.join(HERE, "icon.ico"),
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    # The web client's tab icon, and the one a phone keeps on its home screen.
    # iOS draws its own rounded corners over an opaque square, so that one gets
    # a white backing rather than transparency.
    os.makedirs(WEB_PUBLIC, exist_ok=True)
    square(tile, 64, WEB_FILL).save(os.path.join(WEB_PUBLIC, "favicon.png"))
    touch = Image.new("RGBA", (180, 180), (255, 255, 255, 255))
    touch.alpha_composite(square(tile, 180, 0.8))
    touch.convert("RGB").save(os.path.join(WEB_PUBLIC, "apple-touch-icon.png"))

    print("wrote icon.png, icon.icns, icon.ico, favicon.png, apple-touch-icon.png")


if __name__ == "__main__":
    main()
