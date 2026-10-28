#!/usr/bin/env bash
# A2A Exchange Hub 服务管理：start | stop | restart | status
# Node.js 服务（需要 node >= 22，使用内置 node:sqlite）；nohup 后台运行，日志写入 logs/
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT_DIR/run"
LOG_DIR="$ROOT_DIR/logs"

CLI="$ROOT_DIR/bin/a2a-exchange.mjs"

A2A_BIND_HOST="${A2A_BIND_HOST:-0.0.0.0}"
A2A_PORT="${A2A_PORT:-8787}"
A2A_DATA_DIR="${A2A_DATA_DIR:-$ROOT_DIR/.data}"
# 可选：设置后 Hub 需要 Bearer token（局域网共享凭据）；不设置则局域网内匿名可读写
A2A_TOKEN="${A2A_TOKEN:-}"
# 可选：指定 node 可执行文件（默认自动找 >= 22 的 node）
NODE_BIN="${NODE_BIN:-}"

SERVER_PID="$RUN_DIR/server.pid"
SERVER_LOG="$LOG_DIR/server.log"

usage() {
  cat <<EOF
用法: $0 {start|stop|restart|status}

环境变量（可选）:
  A2A_BIND_HOST   监听地址，默认 0.0.0.0（局域网可访问）
  A2A_PORT        监听端口，默认 8787
  A2A_DATA_DIR    数据目录（SQLite WAL），默认 $ROOT_DIR/.data
  A2A_TOKEN       Hub 访问 token（不设则为开放式，仅建议内网临时使用）
  NODE_BIN        node 可执行文件路径，默认自动探测 >= 22 的 node

日志: logs/server.log（追加写入，按启动分段）
PID:  run/server.pid
EOF
}

die() { echo "[a2a] $*" >&2; exit 1; }

setup_dirs() { mkdir -p "$RUN_DIR" "$LOG_DIR"; }

node_major() {
  "$1" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1 || true
}

resolve_node() {
  local candidates=() c major
  if [[ -n "$NODE_BIN" ]]; then
    candidates+=("$NODE_BIN")
  fi
  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi
  while IFS= read -r c; do
    [[ -n "$c" ]] && candidates+=("$c")
  done < <(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -rV || true)
  candidates+=(/usr/local/bin/node /usr/bin/node)
  for c in "${candidates[@]}"; do
    [[ -x "$c" ]] || continue
    major="$(node_major "$c")"
    if [[ -n "$major" && "$major" -ge 22 ]]; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

port_in_use() {
  ss -tln 2>/dev/null | grep -qE "[:.]${A2A_PORT}[[:space:]]"
}

port_owner() {
  ss -tlnp 2>/dev/null | grep -E "[:.]${A2A_PORT}[[:space:]]" || true
}

log_session_banner() {
  local logfile="$1"
  local extra="${2:-}"
  {
    echo ""
    echo "================================================================"
    echo " $(date '+%Y-%m-%d %H:%M:%S')  A2A Exchange Hub START  ${extra}"
    echo " cwd: $(pwd)"
    echo "================================================================"
  } >> "$logfile"
}

collect_ipv4_addrs() {
  local addrs=()
  if command -v ip &>/dev/null; then
    mapfile -t addrs < <(
      ip -4 -o addr show scope global 2>/dev/null \
        | awk '{print $4}' \
        | cut -d/ -f1 \
        | sort -u
    )
  fi
  if [[ ${#addrs[@]} -eq 0 ]] && command -v hostname &>/dev/null; then
    local hi
    hi="$(hostname -I 2>/dev/null || true)"
    read -ra addrs <<< "$hi"
  fi
  local a
  for a in "${addrs[@]}"; do
    [[ -n "$a" && "$a" != "127.0.0.1" ]] && echo "$a"
  done
}

print_access_info() {
  local hostname_fqdn
  hostname_fqdn="$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo "localhost")"
  local auth_state="开放（无 token）"
  [[ -n "$A2A_TOKEN" ]] && auth_state="需要 Bearer token"

  echo ""
  echo "============================================================"
  echo "  A2A Exchange Hub 服务信息"
  echo "============================================================"
  echo "  主机名:       ${hostname_fqdn}"
  echo "  Node:         ${NODE_RESOLVED:-$(command -v node || echo '未探测')}"
  echo "  监听:         ${A2A_BIND_HOST}:${A2A_PORT}"
  echo "  鉴权:         ${auth_state}"
  echo "  数据目录:     ${A2A_DATA_DIR}"
  echo "------------------------------------------------------------"
  echo "  本机访问:     http://127.0.0.1:${A2A_PORT}/"
  echo "  健康检查:     http://127.0.0.1:${A2A_PORT}/healthz"

  local ips=() ip
  mapfile -t ips < <(collect_ipv4_addrs)
  if [[ ${#ips[@]} -gt 0 ]]; then
    echo "  局域网访问"
    for ip in "${ips[@]}"; do
      echo "    房间页:     http://${ip}:${A2A_PORT}/"
      echo "    Hub:        http://${ip}:${A2A_PORT}"
    done
  else
    echo "  局域网访问:   未检测到全局 IPv4，请用 ip addr 查看后手动拼接端口"
  fi

  echo "------------------------------------------------------------"
  echo "  日志:         ${SERVER_LOG}"
  echo "  PID 文件:     ${SERVER_PID}"
  echo "------------------------------------------------------------"
  echo "  agent 注册示例（任意机器）:"
  echo "    curl -s -X POST http://<本机IP>:${A2A_PORT}/a2a -H 'content-type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"exchange/register\",\"params\":{\"agentId\":\"my-agent\",\"name\":\"My Agent\"}}'"
  echo "============================================================"
}

nohup_bg() {
  local logfile="$1"
  shift
  nohup "$@" </dev/null >>"$logfile" 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid"
}

is_pid_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  if [[ -f "$SERVER_PID" ]]; then
    tr -d '[:space:]' < "$SERVER_PID"
  fi
}

kill_pid_tree() {
  local pid="$1"
  [[ -z "$pid" ]] && return 0
  is_pid_alive "$pid" || return 0
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
  local i
  for i in 1 2 3 4 5; do
    is_pid_alive "$pid" || return 0
    sleep 1
  done
  pkill -KILL -P "$pid" 2>/dev/null || true
  kill -KILL "$pid" 2>/dev/null || true
}

kill_on_port() {
  pkill -f "a2a-exchange.mjs serve.*--port ${A2A_PORT}" 2>/dev/null || true
}

healthz() {
  curl -fsS --max-time 3 "http://127.0.0.1:${A2A_PORT}/healthz" 2>/dev/null || true
}

start_server() {
  local pid
  pid="$(read_pid)"
  if is_pid_alive "$pid"; then
    echo "[a2a] 已在运行 (pid=$pid)"
    return 0
  fi
  rm -f "$SERVER_PID"

  [[ -f "$CLI" ]] || die "找不到 CLI: $CLI"
  if ! NODE_RESOLVED="$(resolve_node)"; then
    die "未找到 node >= 22（本服务依赖内置 node:sqlite）。可用 NODE_BIN=/path/to/node 指定。"
  fi
  export NODE_RESOLVED

  if port_in_use; then
    echo "[a2a] 端口 ${A2A_PORT} 已被占用:" >&2
    port_owner >&2
    echo "[a2a] 请用 A2A_PORT=<其他端口> 启动，或先停掉占用进程。" >&2
    exit 1
  fi

  mkdir -p "$A2A_DATA_DIR"
  local args=( "$CLI" serve --host "$A2A_BIND_HOST" --port "$A2A_PORT" --data-dir "$A2A_DATA_DIR" )
  [[ -n "$A2A_TOKEN" ]] && args+=( --token "$A2A_TOKEN" )

  echo "[a2a] nohup 启动 Hub ${A2A_BIND_HOST}:${A2A_PORT} (node: $NODE_RESOLVED)..."
  cd "$ROOT_DIR"
  log_session_banner "$SERVER_LOG" "host=${A2A_BIND_HOST} port=${A2A_PORT} data=${A2A_DATA_DIR} node=$NODE_RESOLVED"

  pid="$(nohup_bg "$SERVER_LOG" env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy "$NODE_RESOLVED" "${args[@]}")"
  echo "$pid" > "$SERVER_PID"

  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if healthz | grep -q '"ok":true'; then
      echo "[a2a] 已启动 (pid=$pid, nohup)"
      return 0
    fi
    if ! is_pid_alive "$pid"; then
      break
    fi
    sleep 1
  done

  echo "[a2a] 启动失败，请查看: $SERVER_LOG" >&2
  tail -n 30 "$SERVER_LOG" 2>/dev/null || true
  rm -f "$SERVER_PID"
  exit 1
}

stop_server() {
  local pid
  pid="$(read_pid)"
  if [[ -z "$pid" ]]; then
    echo "[a2a] 未运行"
    kill_on_port
    return 0
  fi
  if is_pid_alive "$pid"; then
    echo "[a2a] 停止中 (pid=$pid)..."
    kill_pid_tree "$pid"
    {
      echo "-------- $(date '+%Y-%m-%d %H:%M:%S') A2A Exchange Hub STOP (pid=$pid) --------"
    } >> "$SERVER_LOG"
    echo "[a2a] 已停止，日志: $SERVER_LOG"
  else
    echo "[a2a] 进程不存在，清理陈旧 pid 文件"
  fi
  rm -f "$SERVER_PID"
  kill_on_port
}

status_server() {
  local pid
  pid="$(read_pid)"
  if [[ -n "$pid" ]] && is_pid_alive "$pid"; then
    echo "[a2a] 运行中  pid=$pid  log=$SERVER_LOG"
  elif [[ -n "$pid" ]]; then
    echo "[a2a] 已停止（陈旧 pid=$pid）"
  else
    echo "[a2a] 已停止"
  fi
  if port_in_use; then
    echo "[a2a] 端口 ${A2A_PORT} LISTEN 中"
    local hz
    hz="$(healthz)"
    [[ -n "$hz" ]] && echo "[a2a] healthz: $hz"
  else
    echo "[a2a] 端口 ${A2A_PORT} 未监听"
  fi
}

cmd_start() {
  setup_dirs
  echo ">>> 启动 A2A Exchange Hub..."
  start_server
  echo ""
  status_server
  print_access_info
}

cmd_stop() {
  setup_dirs
  echo ">>> 停止 A2A Exchange Hub..."
  stop_server
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  setup_dirs
  echo ">>> A2A Exchange Hub 服务状态"
  status_server
  print_access_info
}

main() {
  local action="${1:-}"
  case "$action" in
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    restart) cmd_restart ;;
    status)  cmd_status ;;
    -h|--help|help) usage ;;
    *) usage >&2; exit 1 ;;
  esac
}

main "$@"
