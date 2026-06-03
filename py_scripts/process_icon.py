"""Generate Android / Linux / PWA icons from assets/new_icon.png.

Strips the white background (flood-fill from edges), then emits:

- client/public/{favicon.png, apple-touch-icon.png, icon-192.png, icon-512.png}
- client/electron/assets/{appIcon.png, appIcon.ico}
- client/android/app/src/main/res/mipmap-*/ic_launcher.png
- client/android/app/src/main/res/mipmap-*/ic_launcher_round.png
- client/android/app/src/main/res/mipmap-*/ic_launcher_foreground.png
- client/android/app/src/main/res/mipmap-*/ic_launcher_background.png
"""

from __future__ import annotations

import os
from collections import deque

import numpy as np
from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(REPO, "assets", "new_icon.png")

WHITE_THRESHOLD = 235  # any channel >= → "white-ish"
GREY_BG = (54, 55, 59, 255)  # sampled from inside the rounded square

ANDROID_DENSITIES = {
    "mipmap-ldpi": (36, 81),
    "mipmap-mdpi": (48, 108),
    "mipmap-hdpi": (72, 162),
    "mipmap-xhdpi": (96, 216),
    "mipmap-xxhdpi": (144, 324),
    "mipmap-xxxhdpi": (192, 432),
}


def strip_white_background(src_path: str) -> Image.Image:
    """Flood-fill near-white pixels from the image border to alpha = 0."""
    src = Image.open(src_path).convert("RGBA")
    arr = np.array(src)
    h, w = arr.shape[:2]
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    whiteish = (r >= WHITE_THRESHOLD) & (g >= WHITE_THRESHOLD) & (b >= WHITE_THRESHOLD)

    # BFS from every border pixel that is white-ish.
    visited = np.zeros((h, w), dtype=bool)
    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            if whiteish[y, x] and not visited[y, x]:
                visited[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if whiteish[y, x] and not visited[y, x]:
                visited[y, x] = True
                q.append((y, x))

    while q:
        y, x = q.popleft()
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and whiteish[ny, nx]:
                visited[ny, nx] = True
                q.append((ny, nx))

    arr[visited, 3] = 0  # make the outside transparent

    # Crop to the visible content's bounding box so the rounded square
    # sits flush against the canvas edges.
    keep = arr[:, :, 3] > 0
    ys, xs = np.where(keep)
    y0, y1 = ys.min(), ys.max() + 1
    x0, x1 = xs.min(), xs.max() + 1
    cropped = arr[y0:y1, x0:x1]

    # Pad to a square so downstream resizes stay aspect-correct.
    ch, cw = cropped.shape[:2]
    side = max(ch, cw)
    canvas = np.zeros((side, side, 4), dtype=np.uint8)
    oy = (side - ch) // 2
    ox = (side - cw) // 2
    canvas[oy : oy + ch, ox : ox + cw] = cropped
    return Image.fromarray(canvas, "RGBA")


def save_resized(img: Image.Image, path: str, size: int) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    out = img.resize((size, size), Image.LANCZOS)
    out.save(path, format="PNG")
    print(f"  wrote {os.path.relpath(path, REPO)} ({size}x{size})")


def save_ico(img: Image.Image, path: str) -> None:
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    img.save(path, format="ICO", sizes=sizes)
    print(f"  wrote {os.path.relpath(path, REPO)} (multi-size .ico)")


def make_solid_grey(size: int) -> Image.Image:
    return Image.new("RGBA", (size, size), GREY_BG)


def main() -> None:
    print(f"source: {SRC}")
    icon = strip_white_background(SRC)
    print(f"processed icon: {icon.size}")

    # Keep a clean reference copy beside the source.
    icon.save(os.path.join(REPO, "assets", "new_icon_processed.png"), format="PNG")

    # PWA icons
    pub = os.path.join(REPO, "client", "public")
    save_resized(icon, os.path.join(pub, "favicon.png"), 32)
    save_resized(icon, os.path.join(pub, "apple-touch-icon.png"), 180)
    save_resized(icon, os.path.join(pub, "icon-192.png"), 192)
    save_resized(icon, os.path.join(pub, "icon-512.png"), 512)

    # Linux Electron AppImage + Windows .ico
    el = os.path.join(REPO, "client", "electron", "assets")
    save_resized(icon, os.path.join(el, "appIcon.png"), 512)
    save_ico(icon.resize((256, 256), Image.LANCZOS), os.path.join(el, "appIcon.ico"))

    # Android icons
    android_res = os.path.join(REPO, "client", "android", "app", "src", "main", "res")
    for density, (legacy_size, adaptive_size) in ANDROID_DENSITIES.items():
        d = os.path.join(android_res, density)
        save_resized(icon, os.path.join(d, "ic_launcher.png"), legacy_size)
        save_resized(icon, os.path.join(d, "ic_launcher_round.png"), legacy_size)
        # Adaptive icon: foreground = the processed icon at full canvas size.
        # The launcher's mask clips both fg + bg; the bg behind any clipped
        # corners is solid grey so the visible silhouette is always grey + girl.
        save_resized(icon, os.path.join(d, "ic_launcher_foreground.png"), adaptive_size)
        save_resized(
            make_solid_grey(adaptive_size),
            os.path.join(d, "ic_launcher_background.png"),
            adaptive_size,
        )


if __name__ == "__main__":
    main()
