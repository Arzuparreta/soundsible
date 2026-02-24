#!/usr/bin/env python3
"""Generate PWA and in-app icons from branding assets."""
import shutil
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
BRANDING_DIR = REPO_ROOT / "branding"
OUT_DIR = REPO_ROOT / "ui_web" / "assets" / "icons"

MAIN_SIZES = [(180, "apple-touch-icon.png"), (192, "icon-192.png"), (512, "icon-512.png")]
ALT_SIZES = [(180, "apple-touch-icon-alt.png"), (192, "icon-alt-192.png"), (512, "icon-alt-512.png")]
NO_CROP = True  # Use image as-is (center on square)


def make_square(img: Image.Image) -> Image.Image:
    w, h = img.size
    if NO_CROP:
        side = max(w, h)
        square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        ox = (side - w) // 2
        oy = (side - h) // 2
        square.paste(img, (ox, oy))
        return square
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
    return square


def generate_set(png_path: Path, sizes: list[tuple[int, str]]) -> None:
    if not png_path.exists():
        raise SystemExit(f"Logo not found: {png_path}")
    img = Image.open(png_path).convert("RGBA")
    square = make_square(img)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size, name in sizes:
        out = square.resize((size, size), Image.Resampling.LANCZOS)
        out.save(OUT_DIR / name, "PNG")
        print(f"Wrote {OUT_DIR / name} ({size}x{size})")


def main() -> None:
    main_logo = BRANDING_DIR / "logo-app.png"
    alt_logo = BRANDING_DIR / "logo-app-alt.png"
    logo_mark_svg = BRANDING_DIR / "logo-mark.svg"

    generate_set(main_logo, MAIN_SIZES)
    generate_set(alt_logo, ALT_SIZES)

    if logo_mark_svg.exists():
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copy2(logo_mark_svg, OUT_DIR / "logo-mark.svg")
        print(f"Wrote {OUT_DIR / 'logo-mark.svg'}")

    logo_sin_fondo = BRANDING_DIR / "Logo_sin_fondo.png"
    if not logo_sin_fondo.exists():
        logo_sin_fondo = BRANDING_DIR / "logo_sin_fondo.png"
    if logo_sin_fondo.exists():
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copy2(logo_sin_fondo, OUT_DIR / "logo_sin_fondo.png")
        print(f"Wrote {OUT_DIR / 'logo_sin_fondo.png'}")


if __name__ == "__main__":
    main()
