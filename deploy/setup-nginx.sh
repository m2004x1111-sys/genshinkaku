#!/usr/bin/env bash
# 一键配置 nginx：安装 nginx、创建证书验证目录、安装站点配置、重载
# 用法: bash deploy/setup-nginx.sh
set -e
cd "$(dirname "$0")"

echo "[1/4] 检查/安装 nginx..."
if ! command -v nginx >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y nginx
fi

echo "[2/4] 创建证书验证目录..."
sudo mkdir -p /var/www/well-known/pki-validation

echo "[3/4] 安装站点配置..."
sudo cp nginx.conf /etc/nginx/sites-available/genshinkaku
sudo ln -sf /etc/nginx/sites-available/genshinkaku /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

echo "[4/4] 检查并重载 nginx..."
sudo nginx -t
sudo systemctl reload nginx

echo ""
echo "================ 完成 ================"
echo "现在放验证文件（把腾讯云给的文件名和内容代入）："
echo "  sudo tee /var/www/well-known/pki-validation/<文件名>.txt > /dev/null <<'EOF'"
echo "  <粘贴验证内容>"
echo "  EOF"
echo ""
echo "然后本机/服务器验证："
echo "  curl http://gk.longlian.online/.well-known/pki-validation/<文件名>.txt"
echo "  或 curl http://kakurd.longlian.online/.well-known/pki-validation/<文件名>.txt"
echo "能返回内容即可回控制台点验证。"
