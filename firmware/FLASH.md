# 刷机手册（ESP-12F / ESP8266 版）

## 硬件已确认

背面照片上的丝印是 **ESP-12F**，下面一行小字 `ESP8266EX`。

| 项目 | 值 |
|---|---|
| 芯片 | ESP8266EX（乐鑫），**不是 ESP32** |
| 模组 | ESP-12F，板载 PCB 天线，金属屏蔽罩 |
| MAC 前缀 | `8c:ce:4e` = Espressif（和实物一致） |
| 逻辑电平 | **3.3V，绝对不能接 5V** |
| Flash | 4MB（ESP-12F 标准配置，`flash_id` 会确认） |
| 可用 GPIO | 0/2/4/5/12/13/14/15/16，其中 1、3 是串口 TX/RX |

**ESP8266 和 ESP32 的三点关键差异**（这也是你现在卡住的原因）：

1. **ROM 启动日志固定 74880 波特率**，不是 115200。串口助手里 115200 看到的乱码或空白，就是它在 74880 说话。
2. **进入下载模式后串口是静音的**。GPIO0 被拉低上电，芯片停在 bootloader 等指令，不打日志——看不到输出是正常现象，不是没接好。
3. **没有真正的双核/大内存**，可用堆约 40KB，所以服务端我专门加了 `/api/tiny`（204 字节），别用 `/api/device`（1560 字节，且字段重复）。

---

## 一、为什么 COM 口没输出（按顺序排查）

### 1. 波特率看错了 ← 最常见

关掉 115200，改成 **74880**，然后**给板子断电再上电**（不是按按钮）。正常会看到：

```
 ets Jan  8 2013,rst cause:2, boot mode:(3,7)

load 0x4010f000, len 1392, room 16
tail 0
chksum 0x66
csum 0x66
```

这行 `ets Jan 8 2013` 就是铁证：芯片活着，串口通了。
如果 115200 下是一堆乱码、74880 下是能读的英文，那就确认无疑。

### 2. 按住按钮上电 = 静音 ← 你现在大概率是这个

那个按钮接的是 **GPIO0**。按住上电 = 进下载模式 = 芯片在等 esptool，**不会打任何日志**。
所以：**想看日志，别按按钮**；**想刷机，才按按钮**。两件事不能同时干。

### 3. 接线（三个必查点）

```
盒子 RX  ←──  转接板 TX
盒子 TX  ──→  转接板 RX
盒子 GND ───  转接板 GND   ← 不共地，收到的是空的
```

- **TX/RX 必须交叉**。直连接的话，两边都在说话、两边都听不见。
- **转接板要切到 3.3V 档**。如果一直是 5V，ESP 的 RX 可能已经被打伤，后面怎么接都不通。
- **别用转接板给板子供电**。转接板的 3.3V 通常只有 50~100mA，ESP8266 发射瞬间要 300mA+，会反复掉电重启、串口一片乱。
  正确做法：**盒子用原来的电源线供电**，转接板只接 GND / TX / RX 三根，`3V` 那根空着。

### 4. 焊点

照片上那 4 个焊盘是 `RX / TX / 3V / GND`。放大看有没有虚焊、锡有没有连到旁边的铺铜。
用万用表通断档量一下：焊盘 ↔ ESP-12F 对应引脚（TX=GPIO1、RX=GPIO3）应该"嘀"一声。

### 5. 用探测脚本代替 PuTTY（推荐）

PuTTY 全白时什么都看不出来，这个脚本会把原始字节打成 hex，还会自动扫多个波特率：

```bash
python tools/serialprobe.py              # 扫全部波特率，每轮提示你重新上电
python tools/serialprobe.py --loop       # 自环测试（短接转接板 TX-RX）
python tools/serialprobe.py --listen 74880
```

跑之前**必须关掉 PuTTY**，否则端口被占用（报 `PermissionError 拒绝访问`）。

`--loop` 自环测试是判断"到底哪一侧坏了"的分水岭：
拔掉接盒子的线，用一根线把转接板的 TX 和 RX 短接，脚本能收到自己发的字 → 转接板、驱动、端口全好，
问题一定在盒子侧；收不到 → 换 USB 线/转接板，别再去查盒子。


---

## 二、决定性测试：esptool（不依赖串口日志）

串口助手能不能显示不重要，esptool 是直接和 bootloader 对话的，**只要接线对就一定回话**。

```bash
python -m pip install esptool
```

**按住按钮 → 插 USB → 松手**，然后：

```bash
python -m esptool --port COM5 chip_id
```

`COM5` 换成你设备管理器「端口 (COM 和 LPT)」里的实际编号。

### 三种返回值怎么读

| 输出 | 结论 | 下一步 |
|---|---|---|
| `Chip is ESP8266EX` + `MAC: 8c:ce:4e:...` | ✅ 全通，芯片活着 | 直接跳到第三节备份 |
| `Connecting........_____` 后 `Failed to connect` | 没进下载模式 / 接线错 | 重按按钮时机、对调 TX/RX |
| `could not open port COM5` | 驱动或端口号问题 | 装 CH340 驱动，重新插拔看端口号 |
| 卡在 `Connecting...` 转圈 | 供电不足 | 换原电源供电 |

连不上时再试这一条（板子已经处于下载模式、不想让它再发复位信号）：

```bash
python -m esptool --port COM5 --before no_reset --after no_reset chip_id
```

---

## 三、备份原厂固件（务必做，也就 3 分钟）

```bash
python -m esptool --port COM5 --baud 460800 read_flash 0 0x400000 original_4mb.bin
```

- `0x400000` = 4MB。如果 `flash_id` 显示 2MB，改成 `0x200000`。
- 读的时候别拔线，也别断电。
- 万一 460800 报错，去掉 `--baud 460800` 用默认速度。

**这个 bin 很有价值**：把文件放在这台电脑上告诉我路径，我可以从里面扒出原厂用的显示库（TFT_eSPI / LovyanGFX / Adafruit）、屏幕驱动型号，甚至卖家原来的服务器地址。有了它定引脚能省掉大量试错。

---

## 四、刷我们的固件

### 1. Arduino IDE 环境

1. 文件 → 首选项 → 附加开发板管理器网址填：
   `http://arduino.esp8266.com/stable/package_esp8266com_index.json`
2. 开发板管理器搜 `esp8266`，装 **esp8266 by ESP8266 Community**
3. 库管理器装：
   - `Adafruit GFX Library`
   - `Adafruit ST7789 and ST7735`（方屏）
   - `Adafruit GC9A01A`（只有圆屏才需要）
4. 打开 `esp8266_ticker/esp8266_ticker.ino`

### 2. 开发板设置（工具菜单，逐项对齐）

| 项 | 值 |
|---|---|
| 开发板 | Generic ESP8266 Module |
| Flash Size | **4MB (FS:none OTA:~1019KB)** |
| CPU Frequency | 160 MHz |
| Upload Speed | 115200 |
| Reset Method | **nodemcu**（如果上传失败改 `ck` 再试） |

### 3. 改三个地方

```cpp
const char* WIFI_SSID = "你的WiFi名";
const char* WIFI_PASS = "你的WiFi密码";
const char* API_URL   = "http://192.168.100.2:8095/api/tiny";
```

注意 **ESP8266 只支持 2.4G WiFi**，5G 的 SSID 连不上。

### 4. 上传

按住按钮 → 插 USB → 松手 → 点上传 → 看到 `Connecting....` 后面 `Writing at 0x...` 就是通了。

---

## 五、引脚：目前唯一的不确定项

屏幕引脚在固件里是硬编码的，不同批次板子不一样。已知：
- 硬 SPI 时 **SCLK 固定 GPIO14、MOSI 固定 GPIO13**（ESP8266 硬件限制，不用猜）
- 需要确定的只有 **DC / RST / CS / BL** 四个

固件里给了 3 组预设（`PIN_SET` 1/2/3），改一个数字重新上传，约 1 分钟一次。

**判断依据是开机自检**：固件启动时会依次闪 红 → 绿 → 蓝 → 白 四色。
- 闪了 → 引脚全对，问题只在驱动型号或偏移
- 不闪但背光亮 → 只有 BL 对了，DC/RST/CS 错
- 全黑 → 引脚全错，或者 BL 没接 GPIO（把 `PIN_BL` 改成 `-1`）

### 实在试不出来：万用表通断法（10 分钟，一次定死）

断电，万用表打蜂鸣档：
1. 一支表笔固定在屏幕排线/连接器的某个焊盘
2. 另一支依次碰 ESP-12F 的引脚（14/13/4/5/12/15/16/0/2）
3. 哪个"嘀"了，就是这条线

需要找出的 4 条：
- **SCLK** → 必是 GPIO14
- **MOSI** → 必是 GPIO13
- **DC**（寄存器/数据选择）
- **RST**（复位，可能直接接 3.3V 或 EN，那就填 -1）
- **CS**（片选，可能直接接地，那就填 -1）
- **BL**（背光，可能经三极管，量不到就填 -1）

量出来告诉我，我把 `PIN_SET` 写死成你的板子，以后不用再试。

---

## 六、刷完怎么验证

串口 115200，应该看到：

```
=== crypto-dash box (ESP-12F) ===
chip=00XXXXXX flash=4096KB heap=4XXXX
PIN_SET=1
[selftest] RED / GREEN / BLUE / WHITE
WiFi connecting....
[wifi] IP: 192.168.100.xxx
[http] 200, 204 bytes, heap=3XXXX
```

屏上：顶部时间走字，三行 BTC / ETH / ETC，涨红跌绿，底部一行显示数据源。

串口还能敲单字符调试：
- `r` `g` `b` `w` `k` → 整屏刷红/绿/蓝/白/黑（验证接线最快的办法）
- `t` → 重跑四色自检
- `i` → 打印芯片信息、Flash、堆、当前引脚
- `d` → 重绘界面

---

## 七、常见问题

**Q：`Failed to connect to ESP8266: Timed out waiting for packet header`**
1. 按钮要在**插 USB 之前**按住，插上后松开（不是插上再按）
2. TX/RX 对调一次
3. 板子改用原电源供电
4. `--before no_reset` 再试

**Q：能刷进去，但串口 115200 什么都没有**
ESP8266 的 app 日志也是 115200，如果 74880 有 ROM 日志、115200 无 app 日志，说明固件在 `setup()` 之前就崩了——多半是屏幕初始化卡住（引脚错）。先把 `PIN_BL` 改 `-1` 试。

**Q：屏全黑，背光不亮**
BL 引脚不对，或者背光根本没接 GPIO（直连 3.3V）。`PIN_BL -1` 试一次。

**Q：背光亮但全白**
ST7789 的 INVON 差异，在 `tft.init()` 之后加一行 `tft.invertDisplay(true);`。

**Q：花屏、斜条纹**
SPI 太快，把 `setSPISpeed(40000000)` 改成 `20000000`。

**Q：刷坏想回原厂**

```bash
python -m esptool --port COM5 --baud 460800 write_flash 0x0 original_4mb.bin
```
