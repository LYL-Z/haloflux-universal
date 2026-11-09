"""Shrink repository screenshots without changing file names or formats.

Originals are moved to screenshots/_originals/ (gitignored). Every PNG wider than
1600 px is downscaled to 1600 px wide with LANCZOS and re-encoded with optimize.
Exact-duplicate "-gpu" copies are moved aside as well.
"""
from pathlib import Path
from PIL import Image
import hashlib
import shutil

ROOT = Path(r"D:\HALOFLUX")
SHOTS = ROOT / "screenshots"
ORIG = SHOTS / "_originals"
ORIG.mkdir(exist_ok=True)

DUPLICATES = ["bridge-compact-gpu.png", "bridge-overlay-gpu.png", "bridge-window-gpu.png"]

def digest(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()

moved = []
for name in DUPLICATES:
    p = SHOTS / name
    if p.exists():
        shutil.move(str(p), str(ORIG / name))
        moved.append(name)

resized = 0
kept = 0
for p in sorted(SHOTS.glob("*.png")):
    if p.name.startswith("_"):
        continue
    with Image.open(p) as im:
        w, h = im.size
        if w <= 1600:
            kept += 1
            continue
        shutil.copy2(p, ORIG / p.name)
        new_h = round(h * 1600 / w)
        out = im.convert("RGBA").resize((1600, new_h), Image.LANCZOS)
        out.save(p, format="PNG", optimize=True)
        resized += 1

print({"moved_duplicates": moved, "resized": resized, "kept": kept})
