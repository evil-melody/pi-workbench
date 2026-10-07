#!/usr/bin/env python3
"""Generate a Pi Workbench app icon (1024x1024 PNG) for Tauri."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'src-tauri', 'icons', 'icon.png')
SIZE = 1024
RADIUS = 180

def find_font(preferred, fallback):
    for name in [preferred, fallback, '/System/Library/Fonts/Helvetica.ttc',
                 '/System/Library/Fonts/SFNS.ttf',
                 '/Library/Fonts/Arial.ttf']:
        try:
            return ImageFont.truetype(name, 540)
        except Exception:
            continue
    return ImageFont.load_default()

img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# subtle drop shadow
shadow = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
sdraw = ImageDraw.Draw(shadow)
sdraw.rounded_rectangle(
    (40, 50, SIZE - 30, SIZE - 20),
    radius=RADIUS,
    fill=(0, 0, 0, 60),
)
shadow = shadow.filter(ImageFilter.GaussianBlur(24))

# gradient background
bg = Image.new('RGBA', (SIZE, SIZE))
for y in range(SIZE):
    t = y / SIZE
    r = int(79 + (43 - 79) * t)
    g = int(140 + (111 - 140) * t)
    b = int(255 + (255 - 255) * t)
    bg.paste((r, g, b, 255), (0, y, SIZE, y + 1))

mask = Image.new('L', (SIZE, SIZE), 0)
mdraw = ImageDraw.Draw(mask)
mdraw.rounded_rectangle((40, 40, SIZE - 40, SIZE - 40), radius=RADIUS, fill=255)
bg.putalpha(mask)

img = Image.alpha_composite(img, shadow)
img = Image.alpha_composite(img, bg)

# π glyph
font = find_font('SF Pro Display', 'Arial')
draw = ImageDraw.Draw(img)
bbox = draw.textbbox((0, 0), 'π', font=font)
w = bbox[2] - bbox[0]
h = bbox[3] - bbox[1]
x = (SIZE - w) // 2
y = (SIZE - h) // 2 - 20
draw.text((x, y), 'π', font=font, fill=(255, 255, 255, 255))

img.save(OUT, 'PNG')
print(f'wrote {OUT} ({SIZE}x{SIZE})')
