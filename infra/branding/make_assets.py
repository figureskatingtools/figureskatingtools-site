"""Build the Entra External ID company-branding assets for figureskatingtools.com.

Sources: the site's own brand files (site/public). Output: /home/dev/fstools-branding/.
Sizes and limits follow Microsoft's company-branding requirements.
"""
import io
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageEnhance, ImageFont, ImageOps

SITE = Path(sys.argv[1])
OUT = Path(sys.argv[2])
WORK = Path(sys.argv[3])
OUT.mkdir(parents=True, exist_ok=True)
WORK.mkdir(parents=True, exist_ok=True)

INK = (13, 31, 51)
INK_DEEP = (10, 24, 40)
WHITE = (255, 255, 255)


def woff2_to_ttf(name: str) -> Path:
    src = SITE / "fonts" / name
    dst = WORK / (src.stem + ".ttf")
    if not dst.exists():
        f = TTFont(str(src))
        f.flavor = None
        f.save(str(dst))
    return dst


fraunces = woff2_to_ttf("fraunces-latin-opsz-normal.v5-3-0.woff2")


def display_font(size: int, weight: int = 600) -> ImageFont.FreeTypeFont:
    font = ImageFont.truetype(str(fraunces), size)
    try:
        axes = font.get_variation_axes()
        values = []
        for ax in axes:
            tag = ax.get("name", b"")
            tag = tag.decode() if isinstance(tag, bytes) else str(tag)
            if "eight" in tag:
                values.append(weight)
            elif "ptical" in tag:
                values.append(min(max(size, ax["minimum"]), ax["maximum"]))
            else:
                values.append(ax["default"])
        font.set_variation_by_axes(values)
    except Exception:
        pass
    return font


mark = Image.open(SITE / "landing" / "img" / "mark.png").convert("RGBA")
mark = mark.crop(mark.getbbox())


def save_png(img: Image.Image, name: str, limit_kb: int) -> None:
    path = OUT / name
    img.save(path, optimize=True)
    size = path.stat().st_size
    if size > limit_kb * 1024:
        # Quantise to a palette to get under the limit (keeps transparency).
        q = img.quantize(colors=128, method=Image.Quantize.FASTOCTREE)
        q.save(path, optimize=True)
        size = path.stat().st_size
    print(f"{name}: {img.size[0]}x{img.size[1]}, {size / 1024:.1f} KB (limit {limit_kb} KB)")


def lockup(width: int, height: int, text_color, mark_h: int, font_px: int) -> Image.Image:
    """The site's topbar brand: skate mark + 'FSTools' in Fraunces 600."""
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    m = mark.resize((round(mark.width * mark_h / mark.height), mark_h), Image.LANCZOS)
    font = display_font(font_px, 600)
    draw = ImageDraw.Draw(img)
    text = "FSTools"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    gap = round(mark_h * 0.32)
    x = 0
    img.alpha_composite(m, (x, (height - mark_h) // 2))
    draw.text((x + m.width + gap - bbox[0], (height - th) // 2 - bbox[1]), text, font=font, fill=text_color)
    return img


# Banner logo: top of the white sign-in box. 245x36, max 50 KB.
save_png(lockup(245, 36, INK + (255,), 32, 26), "banner-logo-245x36.png", 50)

# Header logo: page header over the dark background. 245x36, max 10 KB.
save_png(lockup(245, 36, WHITE + (255,), 32, 26), "header-logo-245x36.png", 10)

# Square logos: account tiles. 240x240, max 50 KB. The mark reads on light and dark.
for name, bg in (("square-logo-light-240.png", (0, 0, 0, 0)), ("square-logo-dark-240.png", (0, 0, 0, 0))):
    sq = Image.new("RGBA", (240, 240), bg)
    target_w = 200
    m = mark.resize((target_w, round(mark.height * target_w / mark.width)), Image.LANCZOS)
    sq.alpha_composite(m, ((240 - m.width) // 2, (240 - m.height) // 2))
    save_png(sq, name, 50)

# Favicon: 32x32, max 5 KB, from the site's own favicon.
fav = Image.open(SITE / "favicon.png").convert("RGBA").resize((32, 32), Image.LANCZOS)
save_png(fav, "favicon-32.png", 5)

# Background: 1920x1080, max 300 KB. The landing hero: the judges'-papers photo in
# greyscale at 28 % over ink, under the hero's 105° ink → rink shade.
photo = Image.open(SITE / "landing" / "img" / "papers-1600.webp").convert("RGB")
photo = ImageOps.fit(photo, (1920, 1080), Image.LANCZOS, centering=(0.5, 0.4))
photo = ImageEnhance.Contrast(ImageOps.grayscale(photo).convert("RGB")).enhance(1.1)
base = Image.blend(Image.new("RGB", (1920, 1080), INK), photo, 0.28)

# 105deg CSS gradient: rgba(13,31,51,.97) 0%, rgba(13,31,51,.88) 42%, rgba(13,90,146,.55) 100%.
import math

angle = math.radians(105)
dx, dy = math.sin(angle), -math.cos(angle)
w, h = 1920, 1080
half = abs(w / 2 * dx) + abs(h / 2 * dy)
stops = [(0.0, (13, 31, 51, 0.97)), (0.42, (13, 31, 51, 0.88)), (1.0, (13, 90, 146, 0.55))]


def shade_at(t: float):
    for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
        if t <= t1:
            k = (t - t0) / (t1 - t0) if t1 > t0 else 0
            return tuple(c0[i] + (c1[i] - c0[i]) * k for i in range(4))
    return stops[-1][1]


# The gradient only varies along its axis: build it on a small grid and scale up.
gw, gh = 480, 270
grad = Image.new("RGBA", (gw, gh))
px = grad.load()
for yy in range(gh):
    for xx in range(gw):
        X = (xx + 0.5) * w / gw - w / 2
        Y = (yy + 0.5) * h / gh - h / 2
        t = min(max((X * dx + Y * dy + half) / (2 * half), 0), 1)
        r, g, b, a = shade_at(t)
        px[xx, yy] = (round(r), round(g), round(b), round(a * 255))
grad = grad.resize((w, h), Image.BICUBIC)
bg = base.convert("RGBA")
bg.alpha_composite(grad)
bg = bg.convert("RGB")

for q in (86, 82, 78, 74, 70):
    buf = io.BytesIO()
    bg.save(buf, "JPEG", quality=q, optimize=True, progressive=True)
    if buf.tell() <= 300 * 1024:
        break
(OUT / "background-1920x1080.jpg").write_bytes(buf.getvalue())
print(f"background-1920x1080.jpg: 1920x1080, {buf.tell() / 1024:.1f} KB (limit 300 KB), quality {q}")
