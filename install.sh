#!/bin/sh
# 一键部署：在路由器上执行 sh install.sh
# 会自动检查 docker、构建镜像、启动容器，并打印盒子该填的地址。
#
# 可选：同目录放一个 .env 文件，写 PORT=8095 和 BASE_IMAGE=... 来改端口/基础镜像。

set -e
cd "$(dirname "$0")"

[ -f .env ] && . ./.env

PORT="${PORT:-8080}"
NETWORK="${NETWORK:-host}"
NAME="crypto-dash"

if ! command -v docker >/dev/null 2>&1; then
  echo "[x] 没找到 docker。iStoreOS 请在 应用商店/Docker 里先装上并启动 Docker 服务。"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[x] docker 服务没运行，先启动它（/etc/init.d/dockerd start 或 Docker 应用里点启动）。"
  exit 1
fi

echo "[1/3] 构建镜像..."
if [ -n "$BASE_IMAGE" ]; then
  echo "      基础镜像：${BASE_IMAGE}（用本地已有的，不联网拉取）"
  docker build --build-arg BASE_IMAGE="${BASE_IMAGE}" -t ${NAME}:1.0.0 .
else
  docker build -t ${NAME}:1.0.0 .
fi

echo "[2/3] 启动容器..."
docker rm -f ${NAME} >/dev/null 2>&1 || true

# 先删掉旧容器再查端口，否则会把自己上次占的端口当成冲突
if netstat -lnt 2>/dev/null | grep -q ":${PORT} "; then
  echo "[!] 端口 ${PORT} 被别的程序占用了，改 .env 里的 PORT 换一个空闲端口再跑。"
  exit 1
fi

# host 网络：沿用路由器自己的 DNS(dnsmasq) 和代理通道。
# 用 bridge 的话，docker 会给容器下发 8.8.8.8 之类的 DNS，碰到被拦的网络就解析不了域名。
if [ "$NETWORK" = "host" ]; then
  NET_ARGS="--network host"
  echo "      网络模式：host"
else
  NET_ARGS="-p ${PORT}:${PORT} --dns 192.168.100.2"
  echo "      网络模式：bridge（已指定 DNS）"
fi

docker run -d \
  --name ${NAME} \
  --restart unless-stopped \
  ${NET_ARGS} \
  -e PORT=${PORT} \
  -e TZ=Asia/Shanghai \
  -e SYMBOLS="BTCUSDT,ETHUSDT,ETCUSDT" \
  -e PROVIDERS="binancefutures,okxswap,binance,okx,gate,mexc,coingecko" \
  -v "$(pwd)/data:/app/data" \
  ${NAME}:1.0.0

echo "[3/3] 等它抓第一笔数据..."
sleep 7

IP=$(ip -4 addr show br-lan 2>/dev/null | grep -o 'inet [0-9.]*' | head -1 | awk '{print $2}')
[ -z "$IP" ] && IP=$(hostname -i 2>/dev/null | awk '{print $1}')
[ -z "$IP" ] && IP="路由器IP"

SELF_HTTP=$(wget -q -T 5 -O - "http://127.0.0.1:${PORT}/health" 2>/dev/null | grep -o '"ok":true' | head -1)

echo ""
echo "===================================================="
echo " 部署完成"
echo ""
echo " 服务自检： ${SELF_HTTP:-失败，稍后看 docker logs crypto-dash}"
echo ""
echo " 电脑上看效果： http://${IP}:${PORT}/"
echo " 屏效果预览：   http://${IP}:${PORT}/preview"
echo ""
echo " >>> 盒子配网页面里填这个地址："
echo "     http://${IP}:${PORT}/api/device"
echo "===================================================="
echo ""
docker logs --tail 6 ${NAME} 2>&1 || true
