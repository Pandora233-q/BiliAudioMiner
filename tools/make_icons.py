"""生成扩展图标：粉→橙渐变圆角方块 + 白色均衡器条。"""
from PIL import Image, ImageDraw
import numpy as np

S = 512
C1 = (251, 114, 153)   # #FB7299
C2 = (255, 159, 107)   # #FF9F6B


def gradient(size):
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    t = (x / (size - 1) * 0.45 + y / (size - 1) * 0.55)
    t = t[..., None]
    arr = (np.array(C1, np.float32) * (1 - t) + np.array(C2, np.float32) * t).astype(np.uint8)
    return Image.fromarray(arr, "RGB")


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def build():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    grad = gradient(S).convert("RGBA")
    img.paste(grad, (0, 0), rounded_mask(S, 116))

    draw = ImageDraw.Draw(img)
    bars = [(0.30, 0.34), (0.56, 0.68), (0.82, 0.42), (0.56, 0.30)]  # (高度比例, x 中心比例)
    # 重新排布：四根条均匀分布
    heights = [0.30, 0.52, 0.74, 0.40]
    bw = 46
    gap = 22
    total_w = bw * 4 + gap * 3
    x = (S - total_w) / 2
    cy = S / 2
    for h in heights:
        y0 = cy - S * h / 2
        y1 = cy + S * h / 2
        draw.rounded_rectangle([x, y0, x + bw, y1], radius=bw / 2, fill=(255, 255, 255, 242))
        x += bw + gap
    return img


if __name__ == "__main__":
    master = build()
    master.save("icons/icon512.png")
    for size in (128, 48, 32, 16):
        master.resize((size, size), Image.LANCZOS).save(f"icons/icon{size}.png")
    print("icons written")
