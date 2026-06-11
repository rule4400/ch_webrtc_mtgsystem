#!/usr/bin/env python3

from pathlib import Path
from subprocess import run
import math
import shutil

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SIZE = 1024
ICONSET_SLOTS = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


APPS = {
    "client": {
        "dir": ROOT / "client" / "build",
        "title": "meeting-client",
        "bg": ("#123232", "#0D1824"),
        "accent": "#4ADE80",
        "accent2": "#8AB4F8",
        "symbol": "camera",
    },
    "viewer": {
        "dir": ROOT / "viewer" / "build",
        "title": "meeting-viewer",
        "bg": ("#241B38", "#111827"),
        "accent": "#A78BFA",
        "accent2": "#60A5FA",
        "symbol": "eye",
    },
    "server-gui": {
        "dir": ROOT / "server-gui" / "build",
        "title": "meeting-server",
        "bg": ("#10233B", "#101419"),
        "accent": "#5AB0FF",
        "accent2": "#38D996",
        "symbol": "server",
    },
    "screen-share": {
        "dir": ROOT / "screen-share" / "build",
        "title": "meeting-screen-share",
        "bg": ("#31230E", "#101419"),
        "accent": "#F6C35B",
        "accent2": "#4ADE80",
        "symbol": "share",
    },
}


def hex_to_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[index:index + 2], 16) for index in range(0, 6, 2))


def gradient(size, start, end):
    start_rgb = hex_to_rgb(start)
    end_rgb = hex_to_rgb(end)
    image = Image.new("RGBA", (size, size))
    pixels = image.load()
    for y in range(size):
        for x in range(size):
            t = (x * 0.58 + y * 0.42) / size
            pixels[x, y] = tuple(int(start_rgb[i] * (1 - t) + end_rgb[i] * t) for i in range(3)) + (255,)
    return image


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def paste_shadow(base, box, radius, opacity=110, blur=26):
    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(shadow)
    x1, y1, x2, y2 = box
    draw.rounded_rectangle((x1, y1 + 18, x2, y2 + 18), radius=radius, fill=(0, 0, 0, opacity))
    base.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(blur)))


def draw_common_badge(draw, accent):
    draw.rounded_rectangle((72, 72, 248, 166), radius=36, fill=(255, 255, 255, 30))
    draw.text((116, 100), "CH", fill=accent, anchor="la")


def draw_camera(draw, accent, accent2):
    accent = hex_to_rgb(accent)
    accent2 = hex_to_rgb(accent2)
    body = (220, 328, 704, 694)
    draw.rounded_rectangle(body, radius=86, fill=accent + (255,))
    draw.rounded_rectangle((268, 272, 508, 370), radius=46, fill=accent + (255,))
    draw.polygon([(704, 418), (846, 344), (846, 678), (704, 604)], fill=accent2 + (255,))
    draw.ellipse((350, 416, 574, 640), fill=(15, 24, 32, 255))
    draw.ellipse((410, 476, 514, 580), fill=accent2 + (255,))
    draw.rounded_rectangle((274, 722, 750, 784), radius=31, fill=(255, 255, 255, 44))


def draw_eye(draw, accent, accent2):
    accent = hex_to_rgb(accent)
    accent2 = hex_to_rgb(accent2)
    draw.ellipse((154, 314, 870, 704), fill=(255, 255, 255, 34))
    draw.arc((154, 302, 870, 760), start=200, end=340, fill=accent + (255,), width=54)
    draw.arc((154, 266, 870, 724), start=20, end=160, fill=accent2 + (255,), width=54)
    draw.ellipse((356, 326, 668, 638), fill=accent + (255,))
    draw.ellipse((434, 404, 590, 560), fill=(12, 18, 28, 255))
    draw.ellipse((488, 438, 548, 498), fill=(255, 255, 255, 210))
    for x in (300, 512, 724):
        draw.rounded_rectangle((x - 50, 742, x + 50, 790), radius=24, fill=(255, 255, 255, 48))


def draw_server(draw, accent, accent2):
    accent = hex_to_rgb(accent)
    accent2 = hex_to_rgb(accent2)
    for index, y in enumerate((278, 426, 574)):
        fill = accent if index != 1 else accent2
        draw.rounded_rectangle((220, y, 804, y + 104), radius=34, fill=fill + (255,))
        draw.ellipse((264, y + 34, 300, y + 70), fill=(15, 24, 32, 255))
        draw.rounded_rectangle((356, y + 38, 742, y + 66), radius=14, fill=(15, 24, 32, 130))
    draw.line((512, 678, 512, 754), fill=accent2 + (255,), width=34)
    for point in ((330, 800), (512, 800), (694, 800)):
        draw.line((512, 754, point[0], point[1]), fill=accent2 + (220,), width=24)
        draw.ellipse((point[0] - 42, point[1] - 42, point[0] + 42, point[1] + 42), fill=accent2 + (255,))


def draw_share(draw, accent, accent2):
    accent = hex_to_rgb(accent)
    accent2 = hex_to_rgb(accent2)
    draw.rounded_rectangle((178, 270, 846, 670), radius=58, outline=accent + (255,), width=48, fill=(255, 255, 255, 24))
    draw.rounded_rectangle((430, 694, 594, 748), radius=27, fill=accent + (255,))
    draw.rounded_rectangle((334, 760, 690, 818), radius=29, fill=(255, 255, 255, 58))
    draw.line((512, 572, 512, 354), fill=accent2 + (255,), width=58)
    draw.polygon([(512, 214), (342, 396), (440, 396), (440, 430), (584, 430), (584, 396), (682, 396)], fill=accent2 + (255,))
    draw.rounded_rectangle((290, 524, 734, 590), radius=33, fill=(255, 255, 255, 52))


def draw_icon(spec):
    image = gradient(SIZE, spec["bg"][0], spec["bg"][1])
    mask = rounded_mask(SIZE, 214)
    image.putalpha(mask)

    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for radius, alpha in ((370, 35), (230, 28)):
        draw.ellipse((SIZE - radius - 70, 40, SIZE + radius // 3, radius + 110), fill=hex_to_rgb(spec["accent"]) + (alpha,))
    paste_shadow(overlay, (150, 220, 874, 850), 80, opacity=92, blur=38)

    symbol_draw = ImageDraw.Draw(overlay)
    if spec["symbol"] == "camera":
        draw_camera(symbol_draw, spec["accent"], spec["accent2"])
    elif spec["symbol"] == "eye":
        draw_eye(symbol_draw, spec["accent"], spec["accent2"])
    elif spec["symbol"] == "server":
        draw_server(symbol_draw, spec["accent"], spec["accent2"])
    elif spec["symbol"] == "share":
        draw_share(symbol_draw, spec["accent"], spec["accent2"])

    image.alpha_composite(overlay)
    return image


def write_svg(path, spec):
    color = spec["accent"]
    color2 = spec["accent2"]
    title = spec["title"]
    symbol = spec["symbol"]
    svg_symbols = {
        "camera": f"""
  <rect x="220" y="328" width="484" height="366" rx="86" fill="{color}"/>
  <rect x="268" y="272" width="240" height="98" rx="46" fill="{color}"/>
  <path d="M704 418 846 344v334l-142-74z" fill="{color2}"/>
  <circle cx="462" cy="528" r="112" fill="#0F1820"/>
  <circle cx="462" cy="528" r="52" fill="{color2}"/>
""",
        "eye": f"""
  <path d="M154 524c118-164 238-222 358-222s240 58 358 222c-118 164-238 222-358 222s-240-58-358-222z" fill="rgba(255,255,255,.14)"/>
  <path d="M190 524c100-134 207-190 322-190s222 56 322 190" fill="none" stroke="{color2}" stroke-width="54" stroke-linecap="round"/>
  <path d="M190 524c100 134 207 190 322 190s222-56 322-190" fill="none" stroke="{color}" stroke-width="54" stroke-linecap="round"/>
  <circle cx="512" cy="482" r="156" fill="{color}"/>
  <circle cx="512" cy="482" r="78" fill="#0C121C"/>
""",
        "server": f"""
  <rect x="220" y="278" width="584" height="104" rx="34" fill="{color}"/>
  <rect x="220" y="426" width="584" height="104" rx="34" fill="{color2}"/>
  <rect x="220" y="574" width="584" height="104" rx="34" fill="{color}"/>
  <path d="M512 678v76M512 754 330 800M512 754l182 46" fill="none" stroke="{color2}" stroke-width="30" stroke-linecap="round"/>
  <circle cx="330" cy="800" r="42" fill="{color2}"/><circle cx="512" cy="800" r="42" fill="{color2}"/><circle cx="694" cy="800" r="42" fill="{color2}"/>
""",
        "share": f"""
  <rect x="178" y="270" width="668" height="400" rx="58" fill="rgba(255,255,255,.09)" stroke="{color}" stroke-width="48"/>
  <path d="M512 572V214M512 214 342 396h98v34h144v-34h98z" fill="{color2}"/>
  <rect x="334" y="760" width="356" height="58" rx="29" fill="rgba(255,255,255,.24)"/>
""",
    }
    path.write_text(f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="{title}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{spec["bg"][0]}"/>
      <stop offset="1" stop-color="{spec["bg"][1]}"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="214" fill="url(#bg)"/>
  <circle cx="820" cy="210" r="230" fill="{color}" opacity=".18"/>
{svg_symbols[symbol]}
</svg>
""", encoding="utf-8")


def generate_for_app(app_name, spec):
    target_dir = spec["dir"]
    target_dir.mkdir(parents=True, exist_ok=True)
    image = draw_icon(spec)

    png_path = target_dir / "icon.png"
    image.save(png_path)
    write_svg(target_dir / "icon.svg", spec)

    iconset = target_dir / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()
    for filename, slot_size in ICONSET_SLOTS:
        image.resize((slot_size, slot_size), Image.Resampling.LANCZOS).save(iconset / filename)

    icns_path = target_dir / "icon.icns"
    if icns_path.exists():
        icns_path.unlink()
    run(["iconutil", "-c", "icns", str(iconset), "-o", str(icns_path)], check=True)
    shutil.rmtree(iconset)

    ico_images = [image.resize(size, Image.Resampling.LANCZOS) for size in ICO_SIZES]
    ico_images[-1].save(target_dir / "icon.ico", sizes=ICO_SIZES, append_images=ico_images[:-1])
    print(f"generated {app_name}: {target_dir}")


def main():
    for app_name, spec in APPS.items():
        generate_for_app(app_name, spec)


if __name__ == "__main__":
    main()
