#!/usr/bin/env python3
"""从透明吉祥物源图生成全套应用图标与前端品牌资源。

输入：一张**已经抠好底**的透明 PNG（默认 --src 指向 assets/brand/mascot-transparent.png）。
输出：
  - src-tauri/icons/*        macOS(.icns) / Windows(.ico + Square*Logo) / 通用 PNG
  - public/mascot.png        Hero 主视觉（透明，512）
  - public/mascot-mark.png   小尺寸品牌标记（透明，128）
  - public/favicon.png       圆角底 favicon（64）

用法：
  python3 scripts/make-icons.py --src <透明png> [--repo .]

只用 Pillow，不引入额外依赖。
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

# macOS Big Sur 之后的图标是「圆角方形」：圆角半径约为边长的 22.37%，
# 系统不会再替应用裁圆角，所以必须自己画。
CORNER_RATIO = 0.2237
# 吉祥物在图标画布中的高度占比与垂直位置（留出底座呼吸空间）。
ART_HEIGHT_RATIO = 0.74
ART_BOTTOM_RATIO = 0.10
# 浅色品牌底：与 Mascot 自身的淡蓝/青色调一致。
BG_TOP = (243, 249, 254, 255)
BG_BOTTOM = (206, 229, 246, 255)
BORDER = (255, 255, 255, 170)
SHADOW = (26, 64, 116, 60)

PNG_TARGETS = [
    ("src-tauri/icons/32x32.png", 32),
    ("src-tauri/icons/64x64.png", 64),
    ("src-tauri/icons/128x128.png", 128),
    ("src-tauri/icons/128x128@2x.png", 256),
    ("src-tauri/icons/icon.png", 1024),
    ("src-tauri/icons/Square30x30Logo.png", 30),
    ("src-tauri/icons/Square44x44Logo.png", 44),
    ("src-tauri/icons/Square71x71Logo.png", 71),
    ("src-tauri/icons/Square89x89Logo.png", 89),
    ("src-tauri/icons/Square107x107Logo.png", 107),
    ("src-tauri/icons/Square142x142Logo.png", 142),
    ("src-tauri/icons/Square150x150Logo.png", 150),
    ("src-tauri/icons/Square284x284Logo.png", 284),
    ("src-tauri/icons/Square310x310Logo.png", 310),
    ("src-tauri/icons/StoreLogo.png", 50),
    ("public/favicon.png", 64),
]

ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
# Android 各密度倍率（基准 mdpi=1，启动图标 48dp、自适应前景 108dp）
ANDROID_DENSITIES = {
    "mdpi": 1.0,
    "hdpi": 1.5,
    "xhdpi": 2.0,
    "xxhdpi": 3.0,
    "xxxhdpi": 4.0,
}
# 首页品牌图边长：CSS 里显示 136px，@2x 需要 272px，留一档余量。
HERO_PX = 384


def load_transparent(src: Path) -> Image.Image:
    """读入透明源图并裁掉四周空白，保证后续按内容比例排布。"""
    im = Image.open(src).convert("RGBA")
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    return im


def rounded_mask(size: int, radius_ratio: float = CORNER_RATIO) -> Image.Image:
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size * 4 - 1, size * 4 - 1),
        radius=int(size * 4 * radius_ratio),
        fill=255,
    )
    return mask.resize((size, size), Image.LANCZOS)


def vertical_gradient(size: int) -> Image.Image:
    grad = Image.new("RGB", (1, size))
    px = grad.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        px[0, y] = tuple(
            round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)
        )
    return grad.resize((size, size), Image.BILINEAR).convert("RGBA")


def build_icon(art: Image.Image, size: int) -> Image.Image:
    """圆角品牌底 + 居中吉祥物 + 底部投影。"""
    canvas = vertical_gradient(size)

    # 吉祥物：按高度占比缩放，水平居中、底部对齐固定留白。
    target_h = int(size * ART_HEIGHT_RATIO)
    scale = target_h / art.height
    art_scaled = art.resize(
        (max(1, round(art.width * scale)), target_h), Image.LANCZOS
    )

    # 投影：画在吉祥物底部的椭圆，先模糊再压在主体下面。
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    cx = size // 2
    base_y = size - int(size * ART_BOTTOM_RATIO)
    sd.ellipse(
        (cx - int(size * 0.30), base_y - int(size * 0.045), cx + int(size * 0.30), base_y + int(size * 0.035)),
        fill=SHADOW,
    )
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(size * 0.035)))

    paste_x = (size - art_scaled.width) // 2
    paste_y = base_y - art_scaled.height
    canvas.alpha_composite(art_scaled, (paste_x, max(0, paste_y)))

    # 内描边：在暗色 Dock 背景上也能看出图标边界。
    stroke = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(stroke).rounded_rectangle(
        (1, 1, size - 2, size - 2),
        radius=max(2, int(size * CORNER_RATIO) - 1),
        outline=BORDER,
        width=max(1, size // 256),
    )
    canvas.alpha_composite(stroke)

    canvas.putalpha(rounded_mask(size))
    return canvas


def build_foreground(art: Image.Image, size: int) -> Image.Image:
    """Android 自适应图标前景：透明底，主体落在中心安全区内。"""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    target_h = int(size * 0.58)
    scale = target_h / art.height
    scaled = art.resize(
        (max(1, round(art.width * scale)), target_h), Image.LANCZOS
    )
    canvas.alpha_composite(
        scaled, ((size - scaled.width) // 2, (size - scaled.height) // 2)
    )
    return canvas


def write_android(repo: Path, art: Image.Image, icon_1024: Image.Image) -> None:
    """只更新仓库里已存在的 Android 图标目录，不凭空造移动端工程。"""
    base = repo / "src-tauri/icons/android"
    if not base.is_dir():
        return
    for density, factor in ANDROID_DENSITIES.items():
        d = base / f"mipmap-{density}"
        if not d.is_dir():
            continue
        launcher = round(48 * factor)
        icon_1024.resize((launcher, launcher), Image.LANCZOS).save(d / "ic_launcher.png")

        # 圆形版本：同样内容，套一个圆遮罩。
        round_icon = icon_1024.resize((launcher, launcher), Image.LANCZOS)
        mask = Image.new("L", (launcher * 4, launcher * 4), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, launcher * 4 - 1, launcher * 4 - 1), fill=255)
        round_icon.putalpha(mask.resize((launcher, launcher), Image.LANCZOS))
        round_icon.save(d / "ic_launcher_round.png")

        fg = round(108 * factor)
        build_foreground(art, fg).save(d / "ic_launcher_foreground.png")

    bg = base / "values/ic_launcher_background.xml"
    if bg.is_file():
        bg.write_text(
            '<?xml version="1.0" encoding="utf-8"?>\n'
            "<resources>\n"
            '  <color name="ic_launcher_background">#eaf4fb</color>\n'
            "</resources>\n",
            encoding="utf-8",
        )
    print("  updated src-tauri/icons/android/*")


def write_icns(icon_1024: Image.Image, dest: Path) -> bool:
    """用 macOS 自带 iconutil 生成 .icns；非 macOS 上跳过。"""
    if not shutil.which("iconutil"):
        return False
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for s in ICNS_SIZES:
            img = icon_1024.resize((s, s), Image.LANCZOS)
            img.save(iconset / f"icon_{s}x{s}.png")
            if s <= 512:
                img.save(iconset / f"icon_{s}x{s}@2x.png")
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(dest)],
            check=True,
            capture_output=True,
        )
    return True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="透明背景吉祥物 PNG")
    ap.add_argument("--repo", default=".", help="仓库根目录")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    art = load_transparent(Path(args.src))
    print(f"source art: {art.width}x{art.height}")

    icon_1024 = build_icon(art, 1024)

    for rel, size in PNG_TARGETS:
        out = repo / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        icon_1024.resize((size, size), Image.LANCZOS).save(out, optimize=True)
        print(f"  wrote {rel} ({size}px)")

    icns = repo / "src-tauri/icons/icon.icns"
    if write_icns(icon_1024, icns):
        print(f"  wrote {icns.relative_to(repo)}")
    else:
        print("  skip icns (iconutil unavailable)")

    icon_1024.save(
        repo / "src-tauri/icons/icon.ico",
        sizes=[(s, s) for s in ICO_SIZES],
    )
    print("  wrote src-tauri/icons/icon.ico")

    write_android(repo, art, icon_1024)

    # ── 前端品牌资源：透明底，直接叠在页面背景上，不带圆角方底 ──────────
    # 放在 src/assets 而不是 public：让打包器处理（带 hash、可被 tree-shake），
    # 也避免 public/ 与仓库根出现同名文件时「谁生效」的歧义。
    assets = repo / "src/assets"
    assets.mkdir(parents=True, exist_ok=True)
    hero = art.copy()
    scale = min(HERO_PX / hero.width, HERO_PX / hero.height)
    hero.resize(
        (max(1, round(hero.width * scale)), max(1, round(hero.height * scale))),
        Image.LANCZOS,
    ).save(assets / "mascot.png", optimize=True)
    print("  wrote src/assets/mascot.png")

    # 保一份 1024 的圆角图标母版：调参数时可直接比对，不必重跑全流程。
    brand = repo / "assets/brand"
    brand.mkdir(parents=True, exist_ok=True)
    icon_1024.save(brand / "icon-1024.png", optimize=True)
    print("  wrote assets/brand/icon-1024.png")


if __name__ == "__main__":
    main()
