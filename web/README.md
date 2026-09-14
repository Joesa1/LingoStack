# 译伴视频预处理 0.2.1（Mac）

解压后双击「启动译伴.command」。第一次启动会安装字幕组件，随后自动打开本地网页；无需安装 Chrome 扩展，也不要直接打开 index.html。

需要 Python 3.10 或更新版本。如启动提示缺少 Python，安装 https://www.python.org/downloads/macos/ 后重试。随包附有 Apple Silicon（M1/M2/M3/M4 等）Mac 的 Node 运行时。Intel Mac 需要另行构建运行时包。

1. 选择 DeepSeek，填写你的 DeepSeek API Key。
2. 点击「获取模型列表」，选择模型；也可以手动输入账户支持的模型 ID。
3. 点击「测试连接」，确认成功。
4. 粘贴 YouTube 普通视频或 youtu.be 短链接，点击「获取字幕并翻译」。
5. 等待字幕获取和分段翻译，可查看中英全文、下载中文 TXT。失败后可重试；相同模型保留已经完成的翻译段。

本版是 P1-A：链接自动获取字幕到中文全文，不包含 MP3、无字幕 ASR 或 BBC。长视频会分段请求模型，不把整部视频一次发送。一次处理一个任务。关闭网页不取消任务，关闭启动终端会停止服务；重新启动后失败任务可以恢复。

优先获取英文字幕，无英文时选其他现有字幕。读取器使用 youtube-transcript-api 和 yt-dlp；YouTube 限流、登录要求、区域限制、无字幕和网络故障可能导致获取失败，本版不会读取浏览器 Cookie。

API Key 只在运行内存中使用，不写盘。不读取扩展里已经保存的 Key。任务保存在 ~/Library/Application Support/LingoPreprocess，可备份此目录；只监听本机 127.0.0.1:18743。

Provider 和四种翻译协议复用 Chrome 扩展的源码。页面以文本方式显示模型输出，不把字幕或标题当作 HTML 执行。

项目来源：
- https://github.com/jdepoix/youtube-transcript-api
- https://github.com/yt-dlp/yt-dlp

## 验证记录（2026-09-14）

- 实际获取用户视频 aYkZbuFfezU：Kimi Secretly Passed Inputs To Claude，979 条英文字幕。
- 使用实际字幕和本机模拟模型接口，验证链接提交、自动标题、11 段翻译、TXT 导出、失败重试和重启恢复。
- 独立浏览器测试验证 9 个 Provider、DeepSeek 地址、模型列表、连接反馈、错误不回显密钥、恶意标题作为普通文本显示、来源检查和窄屏布局。
- 真实 DeepSeek 账户权限、余额、译文质量尚需用户配置后确认。

源码构建：node scripts/package-web.mjs。自动化验证：node scripts/web-check.mjs；设置 LINGO_LIVE_CAPTIONS=1 可使用真实字幕源。

## 0.2.1 修复

长字幕翻译和连接测试现在最多等待 3 分钟，不再沿用扩展划词请求的 25 秒限制。页面显示当前翻译段，任务失败时会清除旧的“正在获取字幕”提示。超时不会自动重复计费请求；相同配置下点击重试从未完成段继续。

升级：先在旧启动终端按 Control+C 停止旧服务，再解压此版，双击启动译伴.command，刷新页面并重新填写 Key。旧任务保存在同一本机目录，无需重新获取字幕；点击原失败任务的重试即可。

回归验证：模拟模型故意等待 28 秒后返回，验证超过旧截止时间仍能完成全文及导出；四种协议均验证等待上限和响应正文超时。此验证不等于真实 DeepSeek 长文本调用已验证。
