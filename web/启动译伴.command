#!/bin/zsh
cd -- "${0:A:h}"
export PATH="/Library/Frameworks/Python.framework/Versions/3.13/bin:/Library/Frameworks/Python.framework/Versions/3.12/bin:/Library/Frameworks/Python.framework/Versions/3.11/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v python3 >/dev/null; then
  echo '请先安装 Python 3.10 或更新版本：https://www.python.org/downloads/macos/'
  read -r '?按回车关闭'; exit 1
fi
if ! python3 -c 'import sys; assert sys.version_info >= (3,10)' 2>/dev/null; then
  echo '需要 Python 3.10 或更新版本：https://www.python.org/downloads/macos/'
  read -r '?按回车关闭'; exit 1
fi
if [[ ! -x .venv/bin/python3 ]]; then
  python3 -m venv .venv || { read -r '?初始化失败，按回车关闭'; exit 1; }
fi
if ! .venv/bin/python3 -c 'import yt_dlp, youtube_transcript_api' 2>/dev/null; then
  echo '首次启动：正在安装字幕获取组件，请保持联网…'
  .venv/bin/python3 -m pip install -r requirements.txt || { read -r '?安装失败，请检查网络后重试。按回车关闭'; exit 1; }
fi
export SSL_CERT_FILE="$(.venv/bin/python3 -m certifi)"
export REQUESTS_CA_BUNDLE="$SSL_CERT_FILE"
./runtime/node server.mjs
read -r '?服务已停止。按回车关闭'
