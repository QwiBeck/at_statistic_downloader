"""Build the original book/chart/download mark; no AT artwork is used."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1] / "extension" / "icons"
ROOT.mkdir(parents=True, exist_ok=True)

def quadratic(start, control, end):
    return [((1-t)**2*start[0] + 2*(1-t)*t*control[0] + t*t*end[0],
             (1-t)**2*start[1] + 2*(1-t)*t*control[1] + t*t*end[1])
            for t in (index/24 for index in range(25))]

scale = 8
def points(values):
    return [(round(x*scale), round(y*scale)) for x, y in values]

image = Image.new("RGBA", (128*scale, 128*scale))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((0, 0, 128*scale-1, 128*scale-1), radius=27*scale, fill="#24689d")
for x, y in [(29, 46), (48, 34), (67, 23)]:
    draw.rounded_rectangle((x*scale, y*scale, (x+12)*scale, 63*scale), radius=3*scale, fill="white")
draw.line(points([(97, 27), (97, 49)]), fill="#6ce0d0", width=7*scale)
draw.ellipse((93.5*scale, 23.5*scale, 100.5*scale, 30.5*scale), fill="#6ce0d0")
draw.polygon(points([(85, 44), (97, 58), (109, 44)]), fill="#6ce0d0")
left = quadratic((23, 70), (43, 64), (62, 77)) + [(62, 106)] + quadratic((62, 106), (43, 95), (23, 99))
right = quadratic((66, 77), (85, 64), (105, 70)) + [(105, 99)] + quadratic((105, 99), (85, 95), (66, 106))
draw.polygon(points(left), fill="white")
draw.polygon(points(right), fill="#d8f2fb")
for size in (16, 32, 48, 128):
    image.resize((size, size), Image.Resampling.LANCZOS).save(ROOT / f"icon{size}.png")
