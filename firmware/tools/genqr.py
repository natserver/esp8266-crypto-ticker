"""生成配网页所需的位图头文件：二维码 + 中文提示文字

用法：python genqr.py [输出目录]
默认输出到 ../final14/（也就是固件目录，重新编译即可生效）
"""
import os
import sys

import qrcode
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = (sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', 'final14')) + os.sep

# 用来渲染中文提示的字体，按平台顺序找第一个存在的
FONT_CANDIDATES = [
    'C:/Windows/Fonts/msyhbd.ttc',                    # Windows 微软雅黑
    '/System/Library/Fonts/PingFang.ttc',             # macOS
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', # Linux
]
FONT = next((f for f in FONT_CANDIDATES if os.path.exists(f)), None)


def pack(img, name, invert=False):
    """把 PIL 灰度图打包成 1bit/px 行位图"""
    w, h = img.size
    rb = (w + 7) // 8
    data = []
    px = img.load()
    for y in range(h):
        for bx in range(rb):
            b = 0
            for k in range(8):
                x = bx * 8 + k
                if x < w:
                    v = px[x, y]
                    on = (v > 128) if not invert else (v < 128)
                    if on:
                        b |= (0x80 >> k)
            data.append(b)
    with open(OUT + name + '.h', 'w', encoding='utf-8') as f:
        f.write('#pragma once\n#include <Arduino.h>\n')
        f.write('#define %s_W %d\n#define %s_H %d\n#define %s_RB %d\n' % (name, w, name, h, name, rb))
        f.write('static const uint8_t %s_BITS[] PROGMEM = {\n' % name)
        for i in range(0, len(data), 24):
            f.write('  ' + ','.join('0x%02X' % v for v in data[i:i + 24]) + ',\n')
        f.write('};\n')
    print('%-10s %dx%d  %d bytes' % (name, w, h, len(data)))


def qr_png(text, scale, border):
    q = qrcode.QRCode(border=border, error_correction=qrcode.constants.ERROR_CORRECT_M)
    q.add_data(text)
    q.make(fit=True)
    m = q.get_matrix()
    n = len(m)
    w = n * scale
    img = Image.new('L', (w, w), 255)
    d = ImageDraw.Draw(img)
    for y in range(n):
        for x in range(n):
            if m[y][x]:
                d.rectangle([x * scale, y * scale, x * scale + scale - 1, y * scale + scale - 1], fill=0)
    print('  qr %d modules x%d = %dpx' % (n, scale, w))
    return img


def label(text, size, fontpath):
    f = ImageFont.truetype(fontpath, size)
    tmp = ImageDraw.Draw(Image.new('L', (10, 10)))
    box = tmp.textbbox((0, 0), text, font=f)
    w, h = box[2] - box[0] + 4, box[3] - box[1] + 4
    img = Image.new('L', (w, h), 255)
    d = ImageDraw.Draw(img)
    d.text((2 - box[0], 2 - box[1]), text, font=f, fill=0)
    print('  label "%s" %dx%d' % (text, w, h))
    return img


if __name__ == '__main__':
    if not FONT:
        raise SystemExit('找不到中文字体，请手动指定 FONT 路径')
    # 黑模块为 1（前景）；二维码内容是盒子自己开的热点，和固件里的 AP_SSID/AP_PASS 保持一致
    pack(qr_png('WIFI:T:WPA;S:CryptoBox;P:12345678;;', 5, 2), 'QR_WIFI', invert=True)

    pack(label('扫码连接 CryptoBox', 20, FONT), 'LBL_1', invert=True)
    pack(label('自动打开 192.168.4.1', 17, FONT), 'LBL_2', invert=True)
    pack(label('配网中 请勿断电', 17, FONT), 'LBL_3', invert=True)
