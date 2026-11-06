"""Compare Bloom and Chrome renders: share of pixels that differ clearly, and a diff image."""
import sys
from PIL import Image, ImageChops
out = sys.argv[1]
for p in sys.argv[2:]:
    try:
        a = Image.open(f"{out}/{p}-bloom.png").convert("RGB")
        b = Image.open(f"{out}/{p}-chrome.png").convert("RGB").resize(a.size)
    except FileNotFoundError as e:
        print(f"{p}: missing {e.filename}")
        continue
    d = ImageChops.difference(a, b).convert("L")
    hist = d.histogram()
    big = sum(hist[40:])
    total = a.size[0] * a.size[1]
    d.point(lambda v: 255 if v > 40 else 0).save(f"{out}/{p}-diff.png")
    print(f"{p}: {100 * big / total:.2f}% of pixels differ by more than 40")
