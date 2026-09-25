#!/usr/bin/env bash
# 配置公网远程控制所需的 SSH 反向隧道。
# 在服务器上：sudo bash setup-public-server.sh [公网端口]
# 从本机一键执行请用：npm run setup:public-server
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
set_directive GatewayPorts clientspecified

if ! sshd -t; then
  restore
  exit 1
fi

effective() {
  sshd -T | awk -v key="$1" '$1 == key { print $2 }'
}

gateway=$(effective gatewayports || true)
forward=$(effective allowtcpforwarding || true)
if [[ "$gateway" != "clientspecified" && "$gateway" != "yes" ]] || [[ "$forward" != "yes" ]]; then
  dropin=/etc/ssh/sshd_config.d/00-agentdesktop-remote.conf
  mkdir -p /etc/ssh/sshd_config.d
  printf 'AllowTcpForwarding yes\nGatewayPorts clientspecified\n' > "$dropin"
  if ! sshd -t; then
    rm -f "$dropin"
    restore
    exit 1
  fi
  gateway=$(effective gatewayports || true)
  forward=$(effective allowtcpforwarding || true)
fi

if [[ "$gateway" != "clientspecified" && "$gateway" != "yes" ]] || [[ "$forward" != "yes" ]]; then
  restore
  echo "GatewayPorts=$gateway AllowTcpForwarding=$forward，配置未生效" >&2
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

echo "SSH 反向隧道已就绪：AllowTcpForwarding=${forward} GatewayPorts=${gateway}"
echo "请在云安全组放行 TCP ${PORT}。备份：$backup"
