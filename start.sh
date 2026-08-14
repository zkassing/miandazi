#!/usr/bin/env bash
# start.sh — 双击或命令行启动 面搭子
# macOS:  双击或在终端 ./start.sh
# Linux:  终端 ./start.sh
#
# 这个脚本只做两件事：
#   1. 切到脚本所在目录（避免双击 / 运行时的 cwd 问题）
#   2. 把参数透传给 node scripts/launch.mjs

set -e

# cd 到脚本所在目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]:-$0}" )" >/dev/null 2>&1 && pwd )"
cd "$SCRIPT_DIR"

# 颜色（如果终端支持）
if [ -t 1 ]; then
  BOLD="\033[1m"; CYAN="\033[36m"; DIM="\033[2m"; RESET="\033[0m"
else
  BOLD=""; CYAN=""; DIM=""; RESET=""
fi

echo ""
echo -e "${BOLD}${CYAN}  🍜 面搭子 · 启动中...${RESET}"
echo -e "${DIM}  Node $(node --version)${RESET}"
echo -e "${DIM}  项目目录: $SCRIPT_DIR${RESET}"
echo ""

# 检查 Node
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "[ERROR] 未检测到 Node.js，请先安装 Node.js 22 或更高版本："
  echo "        https://nodejs.org/"
  echo ""
  if [ -t 1 ]; then read -p "按回车键退出..." _; fi
  exit 1
fi

# 透传参数
node scripts/launch.mjs "$@"
EXIT_CODE=$?

# 如果 launch 异常退出，暂停（仅当是交互终端时）
if [ $EXIT_CODE -ne 0 ] && [ -t 1 ]; then
  echo ""
  echo "[launch] 异常退出，code=$EXIT_CODE"
  read -p "按回车键退出..." _
fi

exit $EXIT_CODE
