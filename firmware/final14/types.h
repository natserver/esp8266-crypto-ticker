#pragma once
#include <Arduino.h>
#include <Adafruit_GFX.h>

// 行版式（放在头文件里，避免 Arduino 自动原型插到它前面导致编译失败）
// final14：每行两列两行字
//   左上 币种(大) + /USDT(小)      右上 涨跌幅(大，带色)
//   左下 价格(小)                  右下 人民币(小)
// 字号由后台下发（fb/fs），行数多时自动缩小到能放下
struct Layout {
  int16_t rowH;                 // 行高
  int16_t bigTop, bigB;         // 大字：字形上沿 / 基线（相对行顶）
  int16_t subTop, subB;         // 小字：字形上沿 / 基线（相对行顶）
  int16_t bigH, subH;           // 字形高
  const GFXfont *bigF;          // 大字字体
  const GFXfont *subF;          // 小字字体
};
