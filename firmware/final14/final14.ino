// final14 - 顶部时间条 + 两列两行式行情表（照用户给的参考图排版）
//  1) 顶部白色圆角条：左边走时 HH:MM:SS（时间来自行情服务下发，不用 NTP），右边 WiFi 图标
//  2) 每行左上 币种(大) + /USDT(小)，右上 涨跌幅(大，绿涨红跌)
//  3) 每行左下 USDT 价(小)，右下 人民币价(小，前面一个 ¥ 点阵字模)
//  4) 字号由后台（行情服务 /admin）下发：fb=主字号 fs=次字号，各 4 档；行多了自动缩到能放下
//  5) 增量刷新：只重画变化的字符，整屏不闪
//  6) 网页增删/修改币种、扫码配网、OTA 升级
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266HTTPUpdateServer.h>
#include <ESP8266HTTPClient.h>
#include <DNSServer.h>
#include <EEPROM.h>
#include <SPI.h>
#include <math.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <Fonts/FreeSansBold9pt7b.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSansBold18pt7b.h>
#include <Fonts/FreeSansBold24pt7b.h>
#include "types.h"
#include "QR_WIFI.h"
#include "LBL_1.h"
#include "LBL_2.h"
#include "LBL_3.h"
#include "glyphs.h"

#define PIN_DC   0
#define PIN_RST  2
#define PIN_BL   5
#define MAXSYM   4
#define HEAD_H   30                  // 顶部时间条高度
#define X_L      6                   // 左侧文字起点
#define X_R      232                 // 右侧文字右边界（右对齐贴到这里）
#define CFG_MAGIC 0xCB0C0009UL

static const char *AP_SSID = "CryptoBox";
static const char *AP_PASS = "12345678";

ESP8266WebServer server(80);
ESP8266HTTPUpdateServer httpUpdater;
static DNSServer dns;
static bool apMode = false;   // 开机就进配网模式（STA 未连上）
static bool apOn = false;     // 热点已开启（可用于在线自测）

// ---------------------------------------------------------------- 配置
struct Config {
  uint32_t magic;
  char ssid[33];
  char pass[65];
  char api[40];
  char syms[MAXSYM][12];
  uint8_t n;
  uint8_t rot;
  uint8_t mirror;
  uint8_t swapUD;
  uint8_t flipRB;
  uint8_t forceAP;     // 强制进配网模式（用户点“重新配网”时置 1）
  uint16_t refresh;
};

static Config cfg;

static void cfgDefaults() {
  memset(&cfg, 0, sizeof(cfg));
  cfg.magic = CFG_MAGIC;
  // 出厂不带 WiFi：第一次开机会直接进配网模式（热点 CryptoBox，见 /ap 页面），
  // 连上后把 SSID/密码/服务地址写进 EEPROM，所以密码不落在源码里
  cfg.ssid[0] = 0;
  cfg.pass[0] = 0;
  strcpy(cfg.api, "192.168.1.10:8095");   // 你的行情服务地址（路由器 LAN IP:端口）
  strcpy(cfg.syms[0], "BTC");
  strcpy(cfg.syms[1], "ETH");
  strcpy(cfg.syms[2], "XAU");
  cfg.n = 3;
  cfg.rot = 2;
  cfg.mirror = 0;
  cfg.swapUD = 0;
  cfg.flipRB = 0;
  cfg.forceAP = 0;
  cfg.refresh = 10;
}

static void cfgLoad() {
  EEPROM.begin(512);
  EEPROM.get(0, cfg);
  if (cfg.magic != CFG_MAGIC || cfg.n == 0 || cfg.n > MAXSYM) cfgDefaults();
  if (cfg.refresh < 2 || cfg.refresh > 600) cfg.refresh = 10;
  if (cfg.rot > 3) cfg.rot = 2;
}

static void cfgSave() {
  cfg.magic = CFG_MAGIC;
  EEPROM.put(0, cfg);
  EEPROM.commit();
}

// ---------------------------------------------------------------- 显示
static Adafruit_ST7789 *tft = nullptr;
static const GFXfont *F9  = &FreeSansBold9pt7b;
static const GFXfont *F12 = &FreeSansBold12pt7b;
static const GFXfont *F18 = &FreeSansBold18pt7b;
static const GFXfont *F24 = &FreeSansBold24pt7b;
// 字号档位：0=小(9pt) 1=中(12pt) 2=大(18pt) 3=特大(24pt)
static const GFXfont *FONTS[4] = { F9, F12, F18, F24 };

// 后台下发的字号（0~3），默认主 18pt / 次 12pt
static int gFontBig = 2;
static int gFontSub = 1;

#define C_BG    0x0862   // #0B0E11 页面底色
#define C_LINE  0x1905   // #1E2329 行分隔线
#define C_TEXT  0xEF7E   // #EAECF0 主文字
#define C_SUB   0x8473   // #848E9C 次要文字
#define C_UP    0x2DF0   // #2EBD85 涨（绿，跟币安 App 一致）
#define C_DOWN  0xF22B   // #F6465D 跌（红）
#define C_BADGE 0x2987   // #2B3139 永续徽标底
#define C_BADGEFG 0xB5F8 // #B7BDC7 徽标文字
#define C_PRICE 0xEF7E   // 价格（白）
#define C_HEAD  0xF7BE   // 顶部时间条底（近白 #F5F7FA）
#define C_DARK  0x18E3   // 时间条上的深色文字 / 图标


static void applyOrientation() {
  if (!tft) return;
  uint8_t r = cfg.rot & 3;
  tft->setRotation(r);
  if (cfg.mirror) {
    uint8_t base = (r == 0) ? 0xC0 : (r == 1) ? 0xA0 : (r == 2) ? 0x00 : 0x60;
    uint8_t m = base ^ 0x40;
    tft->sendCommand(ST77XX_MADCTL, &m, 1);
  }
}

static void panelBegin() {
  if (tft) { delete tft; tft = nullptr; }
  tft = new Adafruit_ST7789(-1, PIN_DC, PIN_RST);
  tft->init(240, 240, SPI_MODE3);
  applyOrientation();
  tft->fillScreen(C_BG);
}

static void blOn() {
  pinMode(PIN_BL, OUTPUT);
  digitalWrite(PIN_BL, HIGH);
}

static uint16_t chgColor(bool up) {
  if (cfg.swapUD) up = !up;
  bool red = up;
  if (cfg.flipRB) red = !red;
  return red ? C_UP : C_DOWN;
}

// 位图绘制：1=前景色
static void drawMask(int16_t x, int16_t y, const uint8_t *bits, int w, int h, int rb,
                     uint16_t fg, uint16_t bg) {
  static uint16_t row[240];
  for (int yy = 0; yy < h; yy++) {
    const uint8_t *p = bits + (size_t)yy * rb;
    for (int xx = 0; xx < w; xx++) {
      uint8_t b = pgm_read_byte(p + (xx >> 3));
      row[xx] = (b & (0x80 >> (xx & 7))) ? fg : bg;
    }
    tft->drawRGBBitmap(x, y + yy, row, w, 1);
  }
}

static int16_t strW(const char *s, const GFXfont *f) {
  tft->setFont(f);
  int16_t x1, y1; uint16_t w, h;
  tft->getTextBounds(s, 0, 0, &x1, &y1, &w, &h);
  return (int16_t)(x1 + (int16_t)w);
}

static void drawStr(int16_t x, int16_t yb, const char *s, const GFXfont *f, uint16_t c) {
  tft->setFont(f);
  tft->setTextColor(c);
  tft->setCursor(x, yb);
  tft->print(s);
}

// 带底色的文字：Adafruit 的 GFXfont 自定义字体「不支持」背景色
// （库源码 drawChar 里写明了：自定义字体只画字形，textbgcolor 会被忽略），
// 所以必须先按包围盒填底色再画字，否则新字压在旧字上会糊成乱码
static void drawStrBg(int16_t x, int16_t yb, const char *s, const GFXfont *f,
                      uint16_t c, uint16_t bg) {
  if (!s || !*s) return;
  tft->setFont(f);
  int16_t x1, y1; uint16_t w, h;
  tft->getTextBounds(s, x, yb, &x1, &y1, &w, &h);
  tft->fillRect(x1, y1 - 1, (int16_t)w, (int16_t)h + 2, bg);
  tft->setTextColor(c);
  tft->setCursor(x, yb);
  tft->print(s);
}

// 逐字符比对，只重画变化的字符（整屏不闪）
static void fieldUpdate(int16_t x, int16_t yb, const char *oldS, const char *newS,
                        const GFXfont *f, uint16_t color, uint16_t bg,
                        int16_t bx, int16_t by, int16_t bw, int16_t bh) {
  if (oldS && newS && strcmp(oldS, newS) == 0) return;
  if (!oldS || strlen(oldS) != strlen(newS)) {
    tft->fillRect(bx, by, bw, bh, bg);
    drawStr(x, yb, newS, f, color);
    return;
  }
  tft->setFont(f);
  int16_t gx, gy; uint16_t gw, gh;
  tft->getTextBounds("0", 0, 0, &gx, &gy, &gw, &gh);
  int16_t ty = yb + gy;
  size_t n = strlen(newS);
  char pre[24];
  for (size_t i = 0; i < n; i++) {
    if (oldS[i] == newS[i]) continue;
    size_t k1 = i;        if (k1 > 23) k1 = 23;
    memcpy(pre, newS, k1); pre[k1] = 0;
    int16_t xa = x + (k1 ? strW(pre, f) : 0);
    size_t k2 = i + 1;    if (k2 > 23) k2 = 23;
    memcpy(pre, newS, k2); pre[k2] = 0;
    int16_t xb = x + strW(pre, f);
    if (xb <= xa) xb = xa + 1;
    tft->fillRect(xa, ty, xb - xa + 1, gh, bg);
    char one[2] = { newS[i], 0 };
    drawStrBg(xa, yb, one, f, color, bg);
  }
}

static void fieldUpdateR(int16_t xr, int16_t yb, const char *oldS, const char *newS,
                         const GFXfont *f, uint16_t color, uint16_t bg,
                         int16_t bx, int16_t by, int16_t bw, int16_t bh) {
  int16_t wn = strW(newS, f);
  int16_t x = xr - wn;
  if (!oldS || strW(oldS, f) != wn) {
    tft->fillRect(bx, by, bw, bh, bg);
    drawStr(x, yb, newS, f, color);
    return;
  }
  fieldUpdate(x, yb, oldS, newS, f, color, bg, bx, by, bw, bh);
}

// ---------------------------------------------------------------- 行情状态
static String gSym[MAXSYM], gPrice[MAXSYM], gChg[MAXSYM], gCny[MAXSYM], gVol[MAXSYM];
static bool   gUp[MAXSYM];
static int    gRows = 0;
static String gErr = "";

// 上一次画到屏上的值（增量刷新用）
static String pPrice[MAXSYM], pChg[MAXSYM], pCny[MAXSYM], pVol[MAXSYM];
static bool   pUp[MAXSYM];
static bool   pValid = false;
static int    pRows = 0;

static void snapshot() {
  for (int i = 0; i < MAXSYM; i++) {
    pPrice[i] = gPrice[i]; pChg[i] = gChg[i];
    pCny[i] = gCny[i]; pVol[i] = gVol[i]; pUp[i] = gUp[i];
  }
  pRows = gRows;
  pValid = true;
}

// 取某字体数字的实际高度：top 相对基线（负值），h 为字形高
static void textMetrics(const GFXfont *f, int16_t &top, int16_t &h) {
  tft->setFont(f);
  int16_t x1 = 0, y1 = 0; uint16_t w = 0, hh = 0;
  tft->getTextBounds("0", 0, 0, &x1, &y1, &w, &hh);
  top = y1; h = (int16_t)hh;
}

// 版式：顶部时间条以下平均分行，每行「大字一行 + 小字一行」
// 字号来自后台（gFontBig/gFontSub），行数多、字号大时自动往下降一档直到放得下
static Layout layoutFor(int n) {
  Layout L;
  if (n < 1) n = 1;
  if (n > 4) n = 4;
  L.rowH = (240 - HEAD_H) / n;

  int fb = gFontBig, fsb = gFontSub;
  if (fb < 0) fb = 0; if (fb > 3) fb = 3;
  if (fsb < 0) fsb = 0; if (fsb > 3) fsb = 3;

  // 纵向：大字 + 小字 + 最小行距放得下，放不下就往下降一档
  int16_t tb, hb, ts, hs;
  for (;;) {
    textMetrics(FONTS[fb], tb, hb);
    textMetrics(FONTS[fsb], ts, hs);
    if (hb + hs + 4 <= L.rowH) break;
    if (fb == 0 && fsb == 0) break;
    if (fb >= fsb) { if (fb > 0) fb--; } else { if (fsb > 0) fsb--; }
  }

  // 横向：左下价格 + 右下人民币（或成交额）必须放得下，否则次字号也降一档
  // 否则两个数字会糊在一起，宁可字小一点也不能叠
  for (;;) {
    int16_t need = 0;
    for (int i = 0; i < n && i < gRows; i++) {
      int16_t w = X_L + strW(gPrice[i].c_str(), FONTS[fsb]) + 8;
      if (gCny[i].length()) w += M_YEN_W + 2 + strW(gCny[i].c_str(), FONTS[fsb]);
      else if (gVol[i].length()) w += strW(gVol[i].c_str(), FONTS[fsb]) + 2 + M_YI_W;
      if (w > need) need = w;
    }
    if (need <= X_R || fsb == 0) break;
    fsb--;
  }
  // 上面降过次字号，间距按最终字号重算
  textMetrics(FONTS[fb], tb, hb);
  textMetrics(FONTS[fsb], ts, hs);

  // 行内两行字贴紧一点（像行情表那样成组），整块在行里垂直居中
  int16_t lgap = hb / 8;
  if (lgap < 2) lgap = 2;
  if (lgap > 6) lgap = 6;
  int16_t content = hb + lgap + hs;
  int16_t topPad = (L.rowH - content) / 2;
  if (topPad < 1) topPad = 1;

  L.bigF = FONTS[fb];
  L.subF = FONTS[fsb];
  L.bigH = hb;
  L.subH = hs;
  L.bigTop = topPad;
  L.subTop = L.bigTop + hb + lgap;
  L.bigB = L.bigTop - tb;                     // textMetrics 给的 top 是相对基线的负值
  L.subB = L.subTop - ts;
  return L;
}

// ---------------------------------------------------------------- 顶部时间条
// 走时直接用行情服务下发的 HH:MM:SS（SSE 报文里的 t），盒子不跑 NTP，
// 断网时停在最后一次收到的时刻，不会乱跳
static String gTime = "--:--:--";
static String pTime = "";          // 上一帧的时间，用来算哪几位变了
static int16_t gTimeB = 19;

// WiFi 图标：底部一个实心点 + 三道弧（半径 6/10/14，弧厚 2px，弧间留 2px 空隙）
// 用距离场逐像素判断，比按角度打点更干净——弧不会糊成一坨
static void drawWifi(int16_t cx, int16_t cy, uint16_t col) {
  tft->fillCircle(cx, cy, 2, col);
  for (int16_t dy = -16; dy <= 1; dy++) {
    for (int16_t dx = -16; dx <= 16; dx++) {
      if (dx == 0 && dy == 0) continue;
      float d = sqrtf((float)dx * (float)dx + (float)dy * (float)dy);
      if (d > 15.2f) continue;
      float ang = atan2f((float)(-dy), (float)dx) * 57.29578f;   // 0=右 90=上
      if (ang < 40.0f || ang > 140.0f) continue;                  // 只画上半圈
      bool on = false;
      for (int i = 0; i < 3; i++) {
        float r = 6.0f + (float)i * 4.0f;
        if (d > r - 1.0f && d < r + 1.0f) { on = true; break; }
      }
      if (on) tft->drawPixel(cx + dx, cy + dy, col);
    }
  }
}

// 白条 + 时间 + WiFi：圆角只留在顶部
static void drawHeader() {
  tft->fillRoundRect(0, 0, 240, HEAD_H + 10, 9, C_HEAD);
  tft->fillRect(0, HEAD_H, 240, 10, C_BG);
  int16_t t12, h12;
  textMetrics(F12, t12, h12);
  int16_t top = (HEAD_H - h12) / 2;
  if (top < 1) top = 1;
  gTimeB = top - t12;
  drawStrBg(10, gTimeB, gTime.c_str(), F12, C_DARK, C_HEAD);
  drawWifi(219, HEAD_H - 7, C_DARK);
  pTime = gTime;
}

// 每秒走时：只擦掉与上一帧不同的「尾部区域」再整串重画，
// 擦得干净又不会让整块时间闪一下
static void drawTime() {
  if (!tft) return;
  tft->setFont(F12);
  size_t keep = 0;
  while (keep < pTime.length() && keep < gTime.length() && pTime[keep] == gTime[keep]) keep++;

  int16_t x1, y1; uint16_t w, h;
  tft->getTextBounds(gTime.c_str(), 10, gTimeB, &x1, &y1, &w, &h);
  int16_t maxW = strW("88:88:88", F12);              // 最宽的走时，擦到它后面就不会留残影
  int16_t right = 10 + maxW + 2;
  int16_t xe = x1;                                  // 默认整串都擦
  if (keep > 0) {
    String pre = gTime.substring(0, keep);
    int16_t px1, py1; uint16_t pw, ph;
    tft->getTextBounds(pre.c_str(), 10, gTimeB, &px1, &py1, &pw, &ph);
    xe = px1 + (int16_t)pw - 1;                     // 相同前缀的笔画不动
  }
  if (xe < 0) xe = 0;
  if (xe > right) xe = right;
  if (right > xe) tft->fillRect(xe, y1 - 1, right - xe, (int16_t)h + 2, C_HEAD);

  tft->setTextColor(C_DARK);
  tft->setCursor(10, gTimeB);
  tft->print(gTime);
  pTime = gTime;
}

// ---------------------------------------------------------------- 行内文字
// 人民币：¥ 是点阵字模（矢量字体只有 ASCII），数字右对齐到 X_R
static void drawCnyV(int16_t yb, const char *txt, const GFXfont *f) {
  if (!txt || !*txt) return;
  int16_t w = strW(txt, f);
  int16_t x = X_R - (M_YEN_W + 2 + w);
  drawMask(x, yb - M_YEN_H + 1, M_YEN_BITS, M_YEN_W, M_YEN_H, M_YEN_RB, C_SUB, C_BG);
  drawStr(x + M_YEN_W + 2, yb, txt, f, C_SUB);
}

// 成交额：数字 + 「亿」字模（人民币关掉时顶到右下角）
static void drawVolV(int16_t yb, const char *txt, const GFXfont *f) {
  if (!txt || !*txt) return;
  int16_t w = strW(txt, f);
  int16_t x = X_R - (w + 2 + M_YI_W);
  drawStr(x, yb, txt, f, C_SUB);
  drawMask(x + w + 2, yb - M_YI_H + 1, M_YI_BITS, M_YI_W, M_YI_H, M_YI_RB, C_SUB, C_BG);
}

static void drawStrR(int16_t xr, int16_t yb, const char *s, const GFXfont *f, uint16_t c) {
  drawStr(xr - strW(s, f), yb, s, f, c);
}

// BTC/USDT → 本体 BTC + 尾巴 /USDT
static void splitSym(const String &sym, char *base, int cap, String &tail) {
  int slash = sym.indexOf('/');
  int n = slash > 0 ? slash : (int)sym.length();
  if (n > cap - 1) n = cap - 1;
  for (int i = 0; i < n; i++) base[i] = sym[i];
  base[n] = 0;
  tail = slash > 0 ? sym.substring(slash) : String("/USDT");
}

static void drawRowStatic(int i, const Layout &L) {
  int16_t y0 = HEAD_H + i * L.rowH;
  char base[16];
  String tail;
  splitSym(gSym[i], base, sizeof(base), tail);

  // 右上：涨跌幅大字（先算它左边界，左边 /USDT 要避让）
  int16_t chgW = strW(gChg[i].c_str(), L.bigF);
  int16_t chgX = X_R - chgW;

  // 左上：BTC 大字 + /USDT（固定 9pt 小字；撞到涨跌幅就不画，宁可少一个后缀也不叠字）
  drawStr(X_L, y0 + L.bigB, base, L.bigF, C_TEXT);
  int16_t symW = strW(base, L.bigF);
  if (X_L + symW + 2 + strW(tail.c_str(), F9) <= chgX - 3)
    drawStr(X_L + symW + 2, y0 + L.bigB, tail.c_str(), F9, C_SUB);

  drawStr(chgX, y0 + L.bigB, gChg[i].c_str(), L.bigF, chgColor(gUp[i]));

  // 左下：USDT 价
  drawStr(X_L, y0 + L.subB, gPrice[i].c_str(), L.subF, C_PRICE);

  // 右下：人民币（没开就退回成交额）
  if (gCny[i].length()) drawCnyV(y0 + L.subB, gCny[i].c_str(), L.subF);
  else if (gVol[i].length()) drawVolV(y0 + L.subB, gVol[i].c_str(), L.subF);
}

static void drawTickerFull() {
  if (!tft) return;
  tft->fillScreen(C_BG);
  drawHeader();
  if (gRows == 0) {
    drawStr(16, 118, "NO DATA", F12, C_DOWN);
    drawStr(16, 144, gErr.c_str(), F9, C_SUB);
    snapshot();
    return;
  }
  Layout L = layoutFor(gRows);
  for (int i = 0; i < gRows; i++) drawRowStatic(i, L);
  snapshot();
}

// 只重画变化的字符：时间 / 涨跌幅 / 价格 / 人民币
static void updateTicker() {
  if (!tft) return;
  if (!pValid || pRows != gRows || gRows == 0) { drawTickerFull(); return; }
  if (gTime != pTime) drawTime();

  Layout L = layoutFor(gRows);
  for (int i = 0; i < gRows; i++) {
    int16_t y0 = HEAD_H + i * L.rowH;

    // 涨跌幅（右上大字；宽度变了就整块重画）
    if (strcmp(pChg[i].c_str(), gChg[i].c_str()) != 0 || pUp[i] != gUp[i]) {
      int16_t wn = strW(gChg[i].c_str(), L.bigF);
      int16_t wo = strW(pChg[i].c_str(), L.bigF);
      if (pUp[i] != gUp[i] || wo != wn) {
        int16_t wMax = wo > wn ? wo : wn;
        tft->fillRect(X_R - wMax - 2, y0 + L.bigTop - 1, wMax + 4, L.bigH + 3, C_BG);
        drawStrR(X_R, y0 + L.bigB, gChg[i].c_str(), L.bigF, chgColor(gUp[i]));
      } else {
        fieldUpdateR(X_R, y0 + L.bigB, pChg[i].c_str(), gChg[i].c_str(), L.bigF,
                     chgColor(gUp[i]), C_BG, X_R - wn - 2, y0 + L.bigTop - 1, wn + 4, L.bigH + 3);
      }
      pChg[i] = gChg[i];
      pUp[i] = gUp[i];
    }

    // 价格（左下）：宽度要让开右下角那块
    int16_t cw = 0;
    if (gCny[i].length()) cw = M_YEN_W + 2 + strW(gCny[i].c_str(), L.subF);
    else if (gVol[i].length()) cw = strW(gVol[i].c_str(), L.subF) + 2 + M_YI_W;
    int16_t pboxW = X_R - X_L - (cw ? cw + 4 : 0);
    if (pboxW < 24) pboxW = 24;
    fieldUpdate(X_L, y0 + L.subB, pPrice[i].c_str(), gPrice[i].c_str(), L.subF, C_PRICE, C_BG,
                X_L, y0 + L.subTop - 1, pboxW, L.subH + 3);
    pPrice[i] = gPrice[i];

    // 人民币 / 成交额（右下）
    if (strcmp(pCny[i].c_str(), gCny[i].c_str()) != 0 ||
        strcmp(pVol[i].c_str(), gVol[i].c_str()) != 0) {
      int16_t wNew = gCny[i].length() ? (M_YEN_W + 2 + strW(gCny[i].c_str(), L.subF))
                  : gVol[i].length() ? (strW(gVol[i].c_str(), L.subF) + 2 + M_YI_W) : 0;
      int16_t wOld = pCny[i].length() ? (M_YEN_W + 2 + strW(pCny[i].c_str(), L.subF))
                  : pVol[i].length() ? (strW(pVol[i].c_str(), L.subF) + 2 + M_YI_W) : 0;
      int16_t wClear = wNew > wOld ? wNew : wOld;
      int16_t cx = X_R - wClear - 2;
      tft->fillRect(cx, y0 + L.subTop - 1, wClear + 4, L.subH + 3, C_BG);
      // 擦到价格了就顺手重画价格，避免残缺
      if (cx < X_L + strW(gPrice[i].c_str(), L.subF) + 2) {
        tft->fillRect(X_L, y0 + L.subTop - 1, pboxW, L.subH + 3, C_BG);
        drawStr(X_L, y0 + L.subB, gPrice[i].c_str(), L.subF, C_PRICE);
      }
      if (gCny[i].length()) drawCnyV(y0 + L.subB, gCny[i].c_str(), L.subF);
      else if (gVol[i].length()) drawVolV(y0 + L.subB, gVol[i].c_str(), L.subF);
      pCny[i] = gCny[i];
      pVol[i] = gVol[i];
    }
  }
}

// ---------------------------------------------------------------- 取数
static String apiBase() { return String("http://") + cfg.api; }

static String symsJoined() {
  String s;
  for (int i = 0; i < cfg.n; i++) {
    if (i) s += ",";
    s += cfg.syms[i];
  }
  return s;
}

static bool httpGetBody(const String &url, String &out) {
  WiFiClient c;
  HTTPClient h;
  h.setTimeout(5000);
  if (!h.begin(c, url)) return false;
  int code = h.GET();
  if (code == 200) out = h.getString();
  h.end();
  return code == 200;
}

static void pushSymbols() {
  String url = apiBase() + "/api/symbols?set=" + symsJoined();
  String tmp;
  httpGetBody(url, tmp);
}

static String jstr(const String &s, const char *key) {
  String k = String("\"") + key + "\":\"";
  int p = s.indexOf(k);
  if (p < 0) return "";
  p += k.length();
  int e = s.indexOf('"', p);
  if (e < 0) return "";
  return s.substring(p, e);
}

// 取一个数字字段（"fb":2）；没有这个字段返回 -99
static int jnum(const String &s, const char *key) {
  String k = String("\"") + key + "\":";
  int p = s.indexOf(k);
  if (p < 0) return -99;
  p += k.length();
  int e = p;
  while (e < (int)s.length() && (isdigit(s[e]) || s[e] == '-' || s[e] == '+')) e++;
  if (e == p) return -99;
  return s.substring(p, e).toInt();
}

// 把服务端 JSON 解析进全局数组；全部解析成功才替换，避免中途失败把屏幕刷成 NO DATA
static bool parseBody(const String &body) {
  String tSym[MAXSYM], tPrice[MAXSYM], tChg[MAXSYM], tCny[MAXSYM], tVol[MAXSYM];
  bool   tUp[MAXSYM];
  int    tRows = 0;
  int from = 0;

  // 顶部走时（服务端 tz 时区）与后台下发的字号：改字号要整套重排，所以把 pValid 打掉
  String tm = jstr(body, "t");
  if (tm.length() == 8) gTime = tm;
  int fb = jnum(body, "fb"), fs = jnum(body, "fs");
  if (fb >= 0 && fb <= 3 && fb != gFontBig) { gFontBig = fb; pValid = false; }
  if (fs >= 0 && fs <= 3 && fs != gFontSub) { gFontSub = fs; pValid = false; }

  for (int i = 0; i < MAXSYM; i++) {
    int p = body.indexOf("\"l\":\"", from);
    if (p < 0) break;
    int start = body.lastIndexOf('{', p);
    int end = body.indexOf('}', p);
    if (start < 0 || end < 0) break;
    String item = body.substring(start, end + 1);
    from = end + 1;

    // 服务端下发的就是 "BTC/USDT" 这种带斜杠的名字，原样保留
    String label = jstr(item, "l");
    String clean;
    for (unsigned k = 0; k < label.length() && clean.length() < 14; k++) {
      char c = label[k];
      if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '/')
        clean += (char)toupper(c);
    }
    if (!clean.length()) clean = cfg.syms[i];
    if (clean.indexOf('/') < 0) clean += "/USDT";   // 没带计价单位就补 USDT
    tSym[i] = clean;

    tPrice[i] = jstr(item, "p");
    tCny[i] = jstr(item, "y");
    tVol[i] = jstr(item, "v");
    tChg[i] = jstr(item, "c");
    // 颜色：服务端下发 k（1=绿 0=平 -1=红），已经把「绿涨红跌/红涨绿跌」
    // 的换算做完了，盒子照着上色即可 → 网页后台换配色不用再刷固件
    if (item.indexOf("\"k\":1") >= 0) tUp[i] = true;
    else if (item.indexOf("\"k\":-1") >= 0) tUp[i] = false;
    else tUp[i] = tChg[i].startsWith("-") ? false : true;   // 老服务端没有 k 时按符号猜
    tRows = i + 1;
  }
  if (tRows == 0) { gErr = "no rows"; return false; }
  for (int i = 0; i < tRows; i++) {
    gSym[i] = tSym[i]; gPrice[i] = tPrice[i]; gChg[i] = tChg[i];
    gCny[i] = tCny[i]; gVol[i] = tVol[i]; gUp[i] = tUp[i];
  }
  gRows = tRows;
  gErr = "";
  return true;
}

// HTTP 轮询（只在 SSE 连不上时作为兜底）
static bool fetchQuotes() {
  if (WiFi.status() != WL_CONNECTED) { gErr = "wifi down"; return false; }
  String body;
  if (!httpGetBody(apiBase() + "/api/tiny", body)) { gErr = "http fail"; return false; }
  return parseBody(body);
}

// ---------------------------------------------------------------- 实时推送（SSE）
// 服务端 /api/stream 用 Server-Sent Events：一条长连接常驻，
// 币安每笔成交由服务端立刻下发，盒子收到就刷屏。
// 相比轮询：延迟从"一个轮询周期"降到"一次局域网往返"（实测 0.1~0.3 秒）。

static WiFiClient sseCli;
static bool     sseOn = false;
static String   sseBuf;
static uint32_t sseLastRx = 0;
static uint32_t sseNextTry = 0;
static uint32_t sseConnAt = 0;
static uint32_t sseMsgCount = 0;
static int      sseFails = 0;

static void updateTicker();      // 前置声明：SSE 处理里要用

static void sseStop() {
  if (sseCli) sseCli.stop();
  sseOn = false;
  sseBuf = "";
}

static bool sseStart() {
  sseStop();
  if (WiFi.status() != WL_CONNECTED) return false;

  String host = String(cfg.api);
  int port = 80;
  int c = host.indexOf(':');
  if (c > 0) { port = host.substring(c + 1).toInt(); host = host.substring(0, c); }
  if (port <= 0) port = 80;

  if (!sseCli.connect(host.c_str(), port)) { gErr = "sse connect"; return false; }
  sseCli.setNoDelay(true);
  sseCli.setTimeout(4000);
  sseCli.print(String("GET /api/stream HTTP/1.1\r\nHost: ") + host + ":" + String(port) +
               "\r\nAccept: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n");

  // 读掉响应头直到空行
  uint32_t t0 = millis();
  bool headerDone = false;
  int  code = 0;
  while (millis() - t0 < 5000) {
    if (!sseCli.available()) { delay(1); continue; }
    String line = sseCli.readStringUntil('\n');
    line.trim();
    if (line.startsWith("HTTP/")) code = line.substring(9, 12).toInt();
    if (line.length() == 0) { headerDone = true; break; }
  }
  if (!headerDone || code != 200) { sseStop(); gErr = "sse " + String(code); return false; }

  sseOn = true;
  sseBuf = "";
  sseLastRx = millis();
  sseConnAt = millis();
  sseMsgCount = 0;
  gErr = "";
  Serial.println("[sse] 已连接 " + host + ":" + String(port) + " （实时推送模式）");
  return true;
}

static void sseHandleLine(String line) {
  if (!line.length()) return;
  if (line[0] == ':') return;                    // 心跳注释行
  if (!line.startsWith("data:")) return;
  String body = line.substring(5);
  body.trim();
  if (body.indexOf("\"d\":[") < 0) return;
  if (parseBody(body)) {
    sseMsgCount++;
    updateTicker();                              // 只重画变化的字符
  }
}

static void ssePoll() {
  if (!sseOn) return;
  // 逐字节累积成行：readStringUntil 在半个包时会阻塞，这里非阻塞更稳
  while (sseCli.available()) {
    char ch = sseCli.read();
    sseLastRx = millis();
    if (ch == '\n') {
      String line = sseBuf;
      sseBuf = "";
      if (line.endsWith("\r")) line.remove(line.length() - 1);
      sseHandleLine(line);
    } else if (sseBuf.length() < 900) {
      sseBuf += ch;
    }
  }
  if (!sseCli.connected() && !sseCli.available()) {
    Serial.println("[sse] 连接断开，准备重连");
    sseStop();
  } else if (millis() - sseLastRx > 45000UL) {
    Serial.println("[sse] 45 秒无数据，主动重连");
    sseStop();
  }
}


// ---------------------------------------------------------------- 网页公共
static const char *CSS =
  "<style>body{font-family:-apple-system,'Segoe UI',sans-serif;background:#0f1115;color:#e6e9ef;"
  "margin:0;padding:16px;max-width:620px;margin:auto}"
  "h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;color:#8b949e;margin:0 0 10px;font-weight:500}"
  ".c{background:#171b22;border:1px solid #222833;border-radius:12px;padding:14px;margin-bottom:14px}"
  "a{color:#6cb6ff;text-decoration:none;margin-right:14px;display:inline-block;padding:3px 0}"
  "input,select{background:#0f1115;border:1px solid #2b3340;color:#e6e9ef;padding:8px 10px;"
  "border-radius:8px;font-size:15px;width:100%;box-sizing:border-box;margin:4px 0 10px}"
  "button{background:#2563eb;color:#fff;border:0;padding:11px 20px;border-radius:9px;font-size:15px;width:100%}"
  "button.g{background:#1f6f43}button.r{background:#7f1d1d}"
  ".r{display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid #232833;font-size:15px}"
  ".k{color:#8b949e;font-size:13px}.up{color:#ff4d4f}.dn{color:#22c55e}"
  ".t{font-variant-numeric:tabular-nums}"
  "</style>";

static void page(const String &title, const String &body) {
  String h = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>";
  h += "<title>" + title + "</title>";
  h += CSS;
  h += body;
  server.send(200, "text/html; charset=utf-8", h);
}

// ---------------------------------------------------------------- 页面
static void handleRoot() {
  String b;
  b += "<h1>币价小屏</h1><h2>" + WiFi.localIP().toString() + " · " + String(cfg.n) + " 个币种 · "
       + (sseOn ? String("实时推送") : String(cfg.refresh) + "s 轮询兜底") + "</h2>";

  b += "<div class='c'>";
  for (int i = 0; i < gRows; i++) {
    b += "<div class='r'><div><b>" + gSym[i] + "</b><div class='k' style='font-size:12px'>"
         + gVol[i] + "亿</div></div>"
         "<div style='flex:1;text-align:right'><div class='t'>" + gPrice[i]
         + "</div><div class='k t'>¥" + gCny[i] + "</div></div>"
         "<div class='t " + String(gUp[i] ? "up" : "dn") + "' style='width:66px;text-align:right'>"
         + gChg[i] + "</div></div>";
  }
  if (gRows == 0) b += "<div class='dn'>取数失败：" + gErr + "</div>";
  b += "</div>";

  b += "<div class='c'><div class='k'>币种</div><span style='font-size:15px'>" + symsJoined() + "</span>"
       "<div style='height:10px'></div><a href='/syms'>＋ 增删 / 修改币种</a></div>";

  b += "<div class='c'><div class='k'>屏幕方向</div><p style='margin:6px 0 10px'>";
  const char *nm[4] = {"0°", "90°", "180°", "270°"};
  for (int i = 0; i < 4; i++) {
    b += "<a href='/rot?r=" + String(i) + "&m=" + String((int)cfg.mirror) + "' style='color:"
       + (cfg.rot == i ? "#22c55e" : "#6cb6ff") + "'>" + nm[i] + (cfg.rot == i ? " ✓" : "") + "</a>";
  }
  b += "<a href='/rot?r=" + String((int)cfg.rot) + "&m=" + String(cfg.mirror ? 0 : 1) + "' style='color:"
     + (cfg.mirror ? "#22c55e" : "#8b949e") + "'>左右镜像" + (cfg.mirror ? " ✓" : "") + "</a></p>";
  b += "<a href='/orient'>方向校验图</a><a href='/quad'>四宫格</a><a href='/bars'>三色竖条</a>"
       "<a href='/white'>全白</a><a href='/ticker'>回到行情</a></div>";

  b += "<div class='c'><form action='/cfg' method='post'>"
       "<div class='k'>刷新间隔（秒）</div><input name=r type=number min=2 max=600 value='" + String(cfg.refresh) + "'>"
       "<label style='font-size:14px'><input type=checkbox name=swap value=1 style='width:auto' "
       + String(cfg.swapUD ? "checked" : "") + "> 涨跌配色对调</label><br>"
       "<label style='font-size:14px'><input type=checkbox name=flip value=1 style='width:auto' "
       + String(cfg.flipRB ? "checked" : "") + "> 红绿对调</label><br><br>"
       "<button>保存</button></form></div>";

  b += "<div class='c'><div class='k'>网络 / 数据源</div><p style='font-size:14px'>WiFi：" + String(cfg.ssid)
       + "<br>行情服务：" + String(cfg.api)
       + "<br>取数方式：" + String(sseOn ? "实时推送（SSE 长连接）" : "轮询兜底中")
       + (sseOn ? String(" · 已推 ") + String(sseMsgCount) + " 条" : "")
       + "</p>"
       "<a href='/wifi'>更换 WiFi</a><a href='/ap'>重新配网（扫码）</a>"
       "<a href='http://" + String(cfg.api) + "/admin' target='_blank'>上游接口配置 ↗</a></div>";

  b += "<div class='c'><a href='/update'>固件升级</a><a href='/status'>状态 JSON</a></div>";
  page("币价小屏", b);
}

// ---------------------------------------------------------------- 远程改行情服务地址
// 路由器上的行情服务后台会请求 http://<盒子IP>/setapi?api=192.168.100.2:8095
// 只接受 host:port 形式，存 EEPROM，立刻用新地址重连（不用重启盒子）
static bool validApi(const String &a) {
  if (a.length() < 7 || a.length() > 39) return false;
  int colons = 0;
  for (unsigned i = 0; i < a.length(); i++) {
    char c = a[i];
    if (c == ':') { colons++; continue; }
    bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
              (c >= 'A' && c <= 'Z') || c == '.' || c == '-';
    if (!ok) return false;
  }
  return colons == 1;
}

static bool gApiChanged = false;

static void handleSetApi() {
  String a = server.arg("api");
  a.trim();
  if (!validApi(a)) {
    server.send(400, "application/json",
                "{\"ok\":false,\"error\":\"need host:port, e.g. 192.168.100.2:8095\"}");
    return;
  }
  if (a != String(cfg.api)) {
    strncpy(cfg.api, a.c_str(), 39);
    cfg.api[39] = 0;
    cfgSave();
    gApiChanged = true;      // 交给 loop 去重连，别在 HTTP 处理里阻塞
  }
  server.send(200, "application/json",
              "{\"ok\":true,\"api\":\"" + String(cfg.api) + "\"}");
}

static void handleStatus() {
  String j = "{\"ip\":\"" + WiFi.localIP().toString() + "\",\"api\":\"" + String(cfg.api) + "\",\"ap\":" + String(apMode ? 1 : 0) +
             ",\"rot\":" + String((int)cfg.rot) + ",\"mirror\":" + String((int)cfg.mirror) +
             ",\"refresh\":" + String(cfg.refresh) + ",\"n\":" + String(cfg.n) +
             ",\"fb\":" + String(gFontBig) + ",\"fs\":" + String(gFontSub) +
             ",\"time\":\"" + gTime + "\"" +
             ",\"syms\":\"" + symsJoined() + "\",\"rows\":" + String(gRows) +
             ",\"sse\":" + String(sseOn ? 1 : 0) + ",\"pushed\":" + String(sseMsgCount) +
             ",\"heap\":" + String(ESP.getFreeHeap()) + ",\"data\":[";
  for (int i = 0; i < gRows; i++) {
    if (i) j += ",";
    j += "{\"s\":\"" + gSym[i] + "\",\"p\":\"" + gPrice[i] + "\",\"y\":\"" + gCny[i]
       + "\",\"v\":\"" + gVol[i] + "\",\"c\":\"" + gChg[i] + "\"}";
  }
  j += "]}";
  server.send(200, "application/json", j);
}

static void handleSymsGet() {
  String b = "<h1>币种设置</h1><h2>最多 4 个，填币种代号，如 BTC / ETH / SOL / DOGE</h2>";
  b += "<div class='c'><form action='/syms' method='post'>";
  for (int i = 0; i < MAXSYM; i++) {
    // 预填屏幕当前显示的币种（来自服务端），而不是本地存的旧值
    String cur = "";
    if (i < gRows) {
      cur = gSym[i];
      int sl = cur.indexOf('/');
      if (sl > 0) cur = cur.substring(0, sl);
    } else if (i < cfg.n) {
      cur = cfg.syms[i];
    }
    b += "<div class='k'>第 " + String(i + 1) + " 个</div><input name='s" + String(i) + "' value='"
         + cur + "' placeholder='留空表示不使用' autocapitalize=characters>";
  }
  b += "<div class='k'>行情服务地址</div><input name=api value='" + String(cfg.api) + "'>";
  b += "<button>保存并立即生效</button></form></div>";
  b += "<div class='c'><a href='/'>返回</a></div>";
  page("币种设置", b);
}

static void handleSymsPost() {
  int n = 0;
  char tmp[MAXSYM][12];
  for (int i = 0; i < MAXSYM; i++) {
    String v = server.arg("s" + String(i));
    v.trim(); v.toUpperCase();
    String clean;
    for (unsigned k = 0; k < v.length() && clean.length() < 10; k++) {
      char c = v[k];
      if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) clean += c;
    }
    if (clean.length()) { strncpy(tmp[n], clean.c_str(), 11); tmp[n][11] = 0; n++; }
  }
  if (n == 0) { page("错误", "<h1>至少填一个币种</h1><div class='c'><a href='/syms'>返回</a></div>"); return; }

  if (server.hasArg("api")) {
    String a = server.arg("api");
    a.trim();
    a.replace("http://", "");
    if (a.length() && a.length() < 39) { strncpy(cfg.api, a.c_str(), 39); cfg.api[39] = 0; }
  }
  memset(cfg.syms, 0, sizeof(cfg.syms));
  for (int i = 0; i < n; i++) { strncpy(cfg.syms[i], tmp[i], 11); cfg.syms[i][11] = 0; }
  cfg.n = (uint8_t)n;
  cfgSave();
  pushSymbols();
  // 服务端是异步刷新的，等它把新币种抓回来（最多约 4 秒）
  for (int k = 0; k < 6; k++) {
    delay(700);
    if (fetchQuotes() && gRows == (int)cfg.n) break;
  }
  drawTickerFull();

  String b = "<h1>已保存</h1><div class='c'><p>当前币种：" + symsJoined() + "</p>"
             "<a href='/'>返回首页</a></div>";
  page("已保存", b);
}

static void handleWifiGet() {
  int n = WiFi.scanNetworks();
  String b = "<h1>更换 WiFi</h1><h2>当前连接：" + String(cfg.ssid) + "</h2>";
  b += "<div class='c'><form action='/wifisave' method='post'>";
  b += "<div class='k'>WiFi 名称</div><input name=s list=ap value='" + String(cfg.ssid) + "' autocapitalize=off>";
  b += "<datalist id=ap>";
  for (int i = 0; i < n && i < 20; i++) b += "<option value='" + WiFi.SSID(i) + "'>";
  b += "</datalist>";
  b += "<div class='k'>密码</div><input name=p type=password value='" + String(cfg.pass) + "'>";
  b += "<button>保存并重启</button></form></div>";
  b += "<div class='c'><div class='k'>扫描到 " + String(n) + " 个网络</div>";
  for (int i = 0; i < n && i < 12; i++) {
    b += "<div class='r'><span>" + WiFi.SSID(i) + "</span><span class='k'>" + String(WiFi.RSSI(i)) + " dBm</span></div>";
  }
  b += "</div>";
  if (apMode) b += "<div class='c'><a href='/apcancel'>取消配网，回到原来的 WiFi</a></div>";
  b += "<div class='c'><a href='/'>返回</a></div>";
  page("更换 WiFi", b);
}

static void handleWifiSave() {
  String s = server.arg("s"), p = server.arg("p");
  s.trim();
  if (s.length() && s.length() < 32) {
    memset(cfg.ssid, 0, sizeof(cfg.ssid));
    memset(cfg.pass, 0, sizeof(cfg.pass));
    strncpy(cfg.ssid, s.c_str(), 32);
    strncpy(cfg.pass, p.c_str(), 64);
    cfg.forceAP = 0;
    cfgSave();
  }
  page("重启中", "<h1>已保存，正在重启</h1><div class='c'><p>盒子会尝试连接 <b>" + s +
       "</b>，约 20 秒后可用。</p></div>");
  delay(600);
  ESP.restart();
}

static void handleCfg() {
  if (server.hasArg("r")) {
    int v = server.arg("r").toInt();
    if (v >= 2 && v <= 600) cfg.refresh = (uint16_t)v;
  }
  cfg.swapUD = server.hasArg("swap") ? 1 : 0;
  cfg.flipRB = server.hasArg("flip") ? 1 : 0;
  cfgSave();
  drawTickerFull();
  server.sendHeader("Location", "/");
  server.send(302, "text/plain", "");
}

static void handleRot() {
  if (server.hasArg("r")) { int v = server.arg("r").toInt(); if (v >= 0 && v <= 3) cfg.rot = (uint8_t)v; }
  if (server.hasArg("m")) cfg.mirror = (server.arg("m") == "1") ? 1 : 0;
  cfgSave();
  if (tft) { applyOrientation(); tft->fillScreen(C_BG); drawTickerFull(); }
  server.sendHeader("Location", "/");
  server.send(302, "text/plain", "");
}

static void handleAp() {
  page("配网模式", "<h1>进入配网模式</h1><div class='c'><p>盒子会重启并开一个热点 "
       "<b>" + String(AP_SSID) + "</b>（密码 " + String(AP_PASS) + "），"
       "屏幕上会显示二维码，手机扫码即可连接并设置新的 WiFi。</p></div>");
  cfg.forceAP = 1;
  cfgSave();
  delay(500);
  WiFi.disconnect(true);
  delay(200);
  ESP.restart();
}

static void handleApCancel() {
  cfg.forceAP = 0;
  cfgSave();
  page("返回", "<h1>已退出配网模式</h1><div class='c'><p>正在重启并尝试连接原来的 WiFi：<b>"
       + String(cfg.ssid) + "</b></p></div>");
  delay(500);
  ESP.restart();
}

static void handleOrient() {
  if (!tft) { server.send(503, "text/plain", "no panel"); return; }
  tft->fillScreen(C_BG);
  drawStr(78, 40, "TOP", F12, 0xFFFF);
  drawStr(10, 150, "L", F18, 0xFFFF);
  drawStr(80, 190, "F", F18, 0xFFFF);
  server.send(200, "text/plain", "ok");
}

static void handleQuad() {
  if (!tft) { server.send(503, "text/plain", "no"); return; }
  tft->fillRect(0, 0, 120, 120, 0xF800);
  tft->fillRect(120, 0, 120, 120, 0x07E0);
  tft->fillRect(0, 120, 120, 120, 0x001F);
  tft->fillRect(120, 120, 120, 120, 0xFFFF);
  server.send(200, "text/plain", "ok");
}

static void handleBars() {
  if (!tft) { server.send(503, "text/plain", "no"); return; }
  tft->fillRect(0, 0, 80, 240, 0xF800);
  tft->fillRect(80, 0, 80, 240, 0x07E0);
  tft->fillRect(160, 0, 80, 240, 0x001F);
  server.send(200, "text/plain", "ok");
}

static void handleSolid() {
  if (!tft) { server.send(503, "text/plain", "no"); return; }
  String p = server.uri();
  uint16_t c = 0x0000;
  if (p == "/white") c = 0xFFFF;
  else if (p == "/red") c = 0xF800;
  else if (p == "/green") c = 0x07E0;
  else if (p == "/blue") c = 0x001F;
  tft->fillScreen(c);
  server.send(200, "text/plain", "ok");
}

// ---------------------------------------------------------------- 配网屏
static void drawProvisionScreen() {
  if (!tft) return;
  tft->fillScreen(0xFFFF);
  int x0 = (240 - QR_WIFI_W) / 2;
  drawMask(x0, 4, QR_WIFI_BITS, QR_WIFI_W, QR_WIFI_H, QR_WIFI_RB, 0x0000, 0xFFFF);
  drawMask((240 - LBL_1_W) / 2, 172, LBL_1_BITS, LBL_1_W, LBL_1_H, LBL_1_RB, 0x0000, 0xFFFF);
  drawMask((240 - LBL_2_W) / 2, 201, LBL_2_BITS, LBL_2_W, LBL_2_H, LBL_2_RB, 0x0000, 0xFFFF);
  tft->setFont(F9);
  tft->setTextColor(0x0000);
  tft->setCursor(64, 238);
  tft->print("pass 12345678");
}

// ---------------------------------------------------------------- 启动
static bool connectSTA(uint32_t ms) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(cfg.ssid, cfg.pass);
  uint32_t t0 = millis();
  while (millis() - t0 < ms) {
    if (WiFi.status() == WL_CONNECTED) return true;
    delay(200);
  }
  return WiFi.status() == WL_CONNECTED;
}

static bool startProvision() {
  WiFi.mode(WIFI_AP_STA);
  delay(100);
  bool ok = WiFi.softAP(AP_SSID, AP_PASS);
  if (ok) dns.start(53, "*", WiFi.softAPIP());
  apOn = true;
  drawProvisionScreen();
  Serial.printf("AP %s / %s ip=%s dns=%d\n", AP_SSID, AP_PASS,
                WiFi.softAPIP().toString().c_str(), (int)ok);
  return ok;
}

static bool startAP() {
  apMode = true;
  return startProvision();
}

// 在线自测：保持 STA 连接的同时开热点，用来验证配网流程是否可用
static void handleApTest() {
  bool ok = true;
  if (!apOn) ok = startProvision();
  String j = "{\"ok\":" + String(ok ? 1 : 0) +
             ",\"ssid\":\"" + String(AP_SSID) + "\",\"pass\":\"" + String(AP_PASS) + "\"" +
             ",\"softap\":\"" + WiFi.softAPIP().toString() + "\"" +
             ",\"sta\":\"" + WiFi.localIP().toString() + "\"" +
             ",\"mode\":" + String((int)WiFi.getMode()) + "}";
  server.send(200, "application/json", j);
}

static void handleApStop() {
  dns.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  apOn = false;
  drawTickerFull();
  server.send(200, "text/plain", "ap off");
}

void setup() {
  Serial.begin(115200);
  delay(60);
  Serial.println("\n=== final13 boot ===");

  cfgLoad();
  blOn();
  SPI.begin();
  panelBegin();

  // 开机自检
  tft->fillRect(0, 0, 120, 120, 0xF800);
  tft->fillRect(120, 0, 120, 120, 0x07E0);
  tft->fillRect(0, 120, 120, 120, 0x001F);
  tft->fillRect(120, 120, 120, 120, 0xFFFF);
  delay(1200);

  bool ok = false;
  if (cfg.forceAP) {
    Serial.println("forceAP=1 -> 直接进配网");
  } else {
    ok = (cfg.ssid[0] != 0) && connectSTA(15000);
  }
  if (!ok) {
    Serial.println("STA fail -> AP mode");
    startAP();
  } else {
    Serial.printf("IP:%s\n", WiFi.localIP().toString().c_str());
  }

  server.on("/", handleRoot);
  server.on("/status", handleStatus);
  server.on("/setapi", handleSetApi);
  server.on("/apiset", handleSetApi);
  server.on("/syms", HTTP_GET, handleSymsGet);
  server.on("/syms", HTTP_POST, handleSymsPost);
  server.on("/wifi", handleWifiGet);
  server.on("/wifisave", HTTP_POST, handleWifiSave);
  server.on("/cfg", HTTP_POST, handleCfg);
  server.on("/rot", handleRot);
  server.on("/ap", handleAp);
  server.on("/aptest", handleApTest);
  server.on("/apstop", handleApStop);
  server.on("/apcancel", handleApCancel);
  server.on("/orient", handleOrient);
  server.on("/quad", handleQuad);
  server.on("/bars", handleBars);
  server.on("/white", handleSolid);
  server.on("/red", handleSolid);
  server.on("/green", handleSolid);
  server.on("/blue", handleSolid);
  server.on("/ticker", []() { server.send(200, "text/plain", "ok"); drawTickerFull(); });
  httpUpdater.setup(&server, "/update");

  server.onNotFound([]() {
    if (!apOn) { server.send(404, "text/plain", "not found"); return; }
    String host = server.hostHeader();
    if (host == WiFi.localIP().toString() || host == WiFi.softAPIP().toString()) {
      server.send(404, "text/plain", "not found");
      return;
    }
    // 手机连上热点后的“联网检测”请求全部劫持到配网页
    server.sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/wifi");
    server.send(302, "text/plain", "");
  });
  server.begin();

  if (!apMode) {
    // 不再开机 pushSymbols()：币种以服务端配置为准。
    // 否则在 8095 后台改完币种，盒子一重启就把本地旧列表推回去覆盖掉。
    if (fetchQuotes()) drawTickerFull();
    else drawTickerFull();
  }
}

static uint32_t lastFetch = 0;
static uint32_t downSince = 0;

void loop() {
  if (apMode) {
    dns.processNextRequest();
    server.handleClient();
    delay(2);
    return;
  }

  if (apOn) dns.processNextRequest();
  server.handleClient();

  // 后台把行情服务地址改了：断开旧长连接，立刻用新地址重连并重绘
  if (gApiChanged) {
    gApiChanged = false;
    sseStop();
    sseNextTry = millis();
    lastFetch = 0;
    if (WiFi.status() == WL_CONNECTED) {
      if (fetchQuotes()) drawTickerFull();
    }
  }

  if (WiFi.status() != WL_CONNECTED) {
    if (!downSince) downSince = millis();
    else if (millis() - downSince > 60000UL) ESP.restart();
  } else {
    downSince = 0;
  }

  // 主通道：SSE 长连接，服务端有跳动就立刻推过来
  if (WiFi.status() == WL_CONNECTED) {
    ssePoll();
    if (!sseOn && (int32_t)(millis() - sseNextTry) >= 0) {
      if (sseStart()) {
        sseFails = 0;
      } else {
        sseFails++;
        sseNextTry = millis() + (sseFails > 3 ? 10000UL : 2500UL);
      }
    }
  } else if (sseOn) {
    sseStop();
  }

  // 兜底：SSE 没连上时才用 HTTP 轮询，保证屏幕永远有数
  if (!sseOn && millis() - lastFetch > (uint32_t)cfg.refresh * 1000UL) {
    lastFetch = millis();
    if (WiFi.status() == WL_CONNECTED) {
      if (fetchQuotes()) updateTicker();
    }
  }
  delay(2);
}
