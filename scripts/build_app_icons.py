#!/usr/bin/env python3
"""Crop transparent padding from logo and generate PWA icon sizes."""
from pathlib import Path

from PIL import Image

# Cursor-saved asset path (when image is attached in chat); update filename to switch icon
ICON_FILENAME = "Gemini_Generated_Image_sbbindsbbindsbbi-4e6b8624-45ad-433f-9247-eac03e52d2ab.png"
CURSOR_ASSETS = Path.home() / ".cursor" / "projects" / "home-arsu-Git-projects-soundsible" / "assets" / ICON_FILENAME
OUT_DIR = Path(__file__).resolve().parent.parent / "ui_web" / "assets" / "icons"
SIZES = [(180, "apple-touch-icon.png"), (192, "icon-192.png"), (512, "icon-512.png")]
NO_CROP = True  # Use image as-is (already square, no transparent padding to trim)


def main() -> None:
    workspace_logo = Path(__file__).resolve().parent.parent / "assets" / ICON_FILENAME
    if workspace_logo.exists():
        path = workspace_logo
    elif CURSOR_ASSETS.exists():
        path = CURSOR_ASSETS
    else:
        raise SystemExit(f"Logo not found at {workspace_logo} or {CURSOR_ASSETS}")

    img = Image.open(path).convert("RGBA")
    w, h = img.size
    if NO_CROP:
        side = max(w, h)
        square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        ox = (side - w) // 2
        oy = (side - h) // 2
        square.paste(img, (ox, oy))
    else:
        bbox = img.getbbox()
        if not bbox:
            raise SystemExit("Image is fully transparent")
        pad = max(1, int(0.02 * min(w, h)))
        x1, y1 = max(0, bbox[0] - pad), max(0, bbox[1] - pad)
        x2, y2 = min(w, bbox[2] + pad), min(h, bbox[3] + pad)
        cropped = img.crop((x1, y1, x2, y2))
        cw, ch = cropped.size
        side = max(cw, ch)
        square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        square.paste(cropped, ((side - cw) // 2, (side - ch) // 2))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size, name in SIZES:
        out = square.resize((size, size), Image.Resampling.LANCZOS)
        out.save(OUT_DIR / name, "PNG")
        print(f"Wrote {OUT_DIR / name} ({size}x{size})")


if __name__ == "__main__":
    main()
