#!/usr/bin/env bash
# 配置公网远程控制：SSH Unix 套接字反向隧道，以及共用一个端口的入口。
# 在服务器上：sudo bash setup-public-server.sh [公网端口]
# 从本机配置自己的服务器：npm run setup:public-server -- --user <用户> --host <地址> --port <公网端口>
set -euo pipefail

PORT="${1:-8765}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 运行此脚本" >&2
  exit 1
fi

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || [[ "$PORT" -lt 1 ]] || [[ "$PORT" -gt 65535 ]] || [[ "$PORT" -eq 22 ]]; then
  echo "公网端口需在 1–65535 之间，且不能是 22" >&2
  exit 1
fi

ensure_python3() {
  if command -v python3 >/dev/null 2>&1; then
    return
  fi
  echo "服务器没有 python3，正在安装…"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y python3
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y python3
  elif command -v yum >/dev/null 2>&1; then
    yum install -y python3
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache python3
  else
    echo "需要 python3 来运行公网入口，请先安装后再执行" >&2
    exit 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 安装后仍不可用" >&2
    exit 1
  fi
}

wait_listen() {
  python3 - "$1" << 'PY'
import socket, sys, time
port = int(sys.argv[1])
for _ in range(20):
    try:
        sock = socket.create_connection(("127.0.0.1", port), 0.5)
        sock.close()
        raise SystemExit(0)
    except OSError:
        time.sleep(0.25)
raise SystemExit(1)
PY
}

ensure_python3

CFG=/etc/ssh/sshd_config
if [[ ! -f "$CFG" ]]; then
  echo "找不到 $CFG" >&2
  exit 1
fi

backup="/root/sshd_config.bak.agentdesktop.$(date +%Y%m%d%H%M%S)"
cp -a "$CFG" "$backup"

set_directive() {
  local key="$1"
  local value="$2"
  local tmp
  tmp=$(mktemp)
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    /^[[:space:]]/ { print; next }
    {
      orig = $0
      line = orig
      commented = (line ~ /^#/)
      sub(/^#[[:space:]]*/, "", line)
      n = split(line, parts, /[[:space:]]+/)
      if (n >= 1 && parts[1] == key) {
        if (!done) {
          print key " " value
          done = 1
          next
        }
        if (commented) print orig
        next
      }
      print orig
    }
    END { if (!done) print key " " value }
  ' "$CFG" > "$tmp"
  cat "$tmp" > "$CFG"
  rm -f "$tmp"
}

restore() {
  cp -a "$backup" "$CFG"
  echo "sshd 配置校验失败，已恢复 $backup" >&2
}

set_directive AllowTcpForwarding yes
set_directive AllowStreamLocalForwarding yes
set_directive StreamLocalBindUnlink yes

if ! sshd -t; then
  restore
  exit 1
fi

effective() {
  sshd -T | awk -v key="$1" '$1 == key { print $2 }'
}

forward=$(effective allowtcpforwarding || true)
stream=$(effective allowstreamlocalforwarding || true)
unlink=$(effective streamlocalbindunlink || true)
if [[ "$forward" != "yes" || "$stream" != "yes" || "$unlink" != "yes" ]]; then
  dropin=/etc/ssh/sshd_config.d/00-agentdesktop-remote.conf
  mkdir -p /etc/ssh/sshd_config.d
  printf 'AllowTcpForwarding yes\nAllowStreamLocalForwarding yes\nStreamLocalBindUnlink yes\n' > "$dropin"
  if ! sshd -t; then
    rm -f "$dropin"
    restore
    exit 1
  fi
  forward=$(effective allowtcpforwarding || true)
  stream=$(effective allowstreamlocalforwarding || true)
  unlink=$(effective streamlocalbindunlink || true)
fi

if [[ "$forward" != "yes" || "$stream" != "yes" || "$unlink" != "yes" ]]; then
  restore
  echo "AllowTcpForwarding=$forward AllowStreamLocalForwarding=$stream StreamLocalBindUnlink=$unlink，配置未生效" >&2
  exit 1
fi

if command -v systemctl >/dev/null 2>&1 && systemctl cat sshd >/dev/null 2>&1; then
  systemctl reload sshd
elif command -v systemctl >/dev/null 2>&1 && systemctl cat ssh >/dev/null 2>&1; then
  systemctl reload ssh
elif command -v service >/dev/null 2>&1; then
  service sshd reload 2>/dev/null || service ssh reload
else
  kill -HUP "$(cat /run/sshd.pid)"
fi

install_gateway() {
  local dest=/usr/local/lib/agent-desktop
  mkdir -p "$dest"
  if [[ -n "${GATEWAY_B64:-}" ]]; then
    if ! printf '%s' "$GATEWAY_B64" | base64 -d > "$dest/public-gateway.py" 2>/dev/null; then
      printf '%s' "$GATEWAY_B64" | base64 --decode > "$dest/public-gateway.py"
    fi
  else
    local src
    src="$(cd "$(dirname "$0")" && pwd)/public-gateway.py"
    if [[ ! -f "$src" ]]; then
      echo "找不到 public-gateway.py。请在项目目录执行 npm run setup:public-server" >&2
      exit 1
    fi
    cp "$src" "$dest/public-gateway.py"
  fi
  chmod 644 "$dest/public-gateway.py"
  python3 -m py_compile "$dest/public-gateway.py"
}

install_gateway
PY="$(command -v python3)"
MKDIR="$(command -v mkdir)"
CHMOD="$(command -v chmod)"
UNIT=/etc/systemd/system/agent-desktop-gateway.service

if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  cat > "$UNIT" << EOF
[Unit]
Description=Agent Desktop public remote gateway
After=network.target

[Service]
Type=simple
ExecStartPre=${MKDIR} -p /run/agent-desktop
ExecStartPre=${CHMOD} 1777 /run/agent-desktop
ExecStart=${PY} /usr/local/lib/agent-desktop/public-gateway.py --port ${PORT}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable agent-desktop-gateway
  systemctl restart agent-desktop-gateway
  if ! systemctl is-active --quiet agent-desktop-gateway; then
    systemctl status agent-desktop-gateway --no-pager || true
    echo "公网入口没有启动。如果端口 ${PORT} 被占用，请先关闭旧版本的公网隧道。" >&2
    exit 1
  fi
else
  mkdir -p /run/agent-desktop
  chmod 1777 /run/agent-desktop
  if [[ -f /var/run/agent-desktop-gateway.pid ]]; then
    kill "$(cat /var/run/agent-desktop-gateway.pid)" 2>/dev/null || true
    rm -f /var/run/agent-desktop-gateway.pid
  fi
  mkdir -p /var/log
  nohup "$PY" /usr/local/lib/agent-desktop/public-gateway.py --port "$PORT" >> /var/log/agent-desktop-gateway.log 2>&1 &
  echo $! > /var/run/agent-desktop-gateway.pid
  sleep 0.5
  if ! kill -0 "$(cat /var/run/agent-desktop-gateway.pid)" 2>/dev/null; then
    echo "公网入口没有启动。如果端口 ${PORT} 被占用，请先关闭旧版本的公网隧道。" >&2
    exit 1
  fi
fi

if ! wait_listen "$PORT"; then
  echo "公网入口没有在 127.0.0.1:${PORT} 监听。如果端口被占用，请先关闭旧的公网隧道。" >&2
  exit 1
fi

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port="${PORT}/tcp"
  firewall-cmd --reload
  echo "firewalld 已放行 TCP ${PORT}"
elif command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow "${PORT}/tcp"
  echo "ufw 已放行 TCP ${PORT}"
else
  echo "未发现正在运行的 firewalld 或 ufw。"
fi

echo "公网入口已监听 0.0.0.0:${PORT}。多台电脑共用这个端口，链接形如 http://<服务器>:${PORT}/c/<电脑标识>/"
echo "SSH：AllowTcpForwarding=${forward} AllowStreamLocalForwarding=${stream} StreamLocalBindUnlink=${unlink}"
echo "请在云安全组放行 TCP ${PORT}。备份：$backup"
