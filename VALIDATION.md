# 1.3.0 UI release validation

Date: 2026-09-15.

- Production build: Chrome MV3, version 1.3.0, name 译栈 · 网页与字幕翻译. Supplied SVG rendered at 16/32/48/128 px. No additional runtime dependencies.
- Real Chromium extension checks passed: translation configuration, model lists, test feedback, webpage translation, dynamic content, restore, selection action, cloud TTS settings for three providers, voices, persistence, preview playback, cancellation and responsive layout. Cloud calls use test audio at the HTTP boundary, not a paid live account.
- Popup verified at 390 × 600 px with the new icon loaded and no overflow. Original options form IDs are preserved; panel navigation only changes visibility. Full npm run typecheck and targeted strict TypeScript checks passed. Nineteen provider and TTS unit tests passed.
- The full test suite did not complete in this environment: jsdom worker initialization timed out, and an unrelated preprocessing test initially lacked its Python runtime. The successful extension browser checks and targeted checks above are not a claim that the full suite passed.
- Main branch unchanged. No changes to translation/voice algorithms, provider configuration, storage keys, extension permissions, or the preprocessing app. Runtime string changes are branding only.

---

# 验证记录

验证日期：2026-09-11。以下按真实执行结果记录，不把测试数据当作真实模型输出。

## 1.1.0 多服务商语音验证

- 支持系统、阿里百炼、Azure、MiniMax；三家云端请求分别按官方接口实现，没有增加运行时依赖或中转服务器。
- 类型检查、33 项自动化测试、生产构建通过。新增测试覆盖分句长度、SSML 转义、三家请求参数、音频解析、区域校验、取消请求、错误脱敏，以及阿里音频下载域名限制和不携带 Key。
- 实际 Chromium 加载生产扩展，验证三家配置、音色列表/预设、手动 ID、配置切换与持久化、试听成功/失败、停止、丢弃过时结果、删除凭证和窄屏布局。
- 云端测试仅替换付费 HTTP 接口，返回测试生成的 PCM WAV；扩展实际使用隐藏页面的 Audio 元素播放，并收到 playing/ended 事件。没有把 HTTP 成功视为播放成功。
- 从真实内容脚本端口验证：生成期间暂停后不自动播放；继续后开始；播放中暂停后不提前结束；停止生成或关闭标签页后不迟到播放。播放和暂停期间由隐藏页面定期保留后台任务状态。
- 会话存储不含凭证；普通内容脚本仍被拒绝读取本机密钥存储。测试截图和临时凭证不会进入安装包。
- 真实云账户权限、额度、音色听感及云服务延迟尚未验收；本版不是流式合成，也未实现视频原声情绪识别。

## 1.0.2 划词与滚动字幕修复验证

- 回归用例在修改前复现了两种行为：划词请求排在等待中的整页任务之后；滚动字幕从 A 变为 A+B、再变为 B+C 时，把 A、B 重复送去翻译。修复后分别优先执行划词、只翻译 A/B/C 各一次。
- 实际 Chromium 加载生产扩展，真实鼠标划词并点击「译伴翻译」得到译文；再次查询命中缓存，没有再次调用本机模型服务。
- 实际扩展的备用字幕路径，三个滚动窗口分别只传入新增句子，macOS 系统朗读接口依次收到三句不同译文，各一次；原生 CC 在译伴字幕显示时隐藏，关闭后恢复。
- 带时间轴的视频字幕、系统声音 start/end 事件、跳转、关闭和原音量恢复的浏览器回归通过。测试音量为 0，译文来自本机固定响应。
- 测试覆盖：慢请求期间字幕继续增长、切换后丢弃过时结果、拖动进度后允许重读、重叠的重复句不重启朗读、稍后真实再次出现的同一句仍可朗读、空白差异不造成双份字幕。
- 查询真实 YouTube 页面的 DOM，确认原生字幕容器的 ID 和 class 均为 ytp-caption-window-container。此次没有复现用户所述的所有“双行重复”画面；一行译文加一行原文仍是预期双语显示。
- 未找到旧平台连接提示或跳转调用。清理了源码注释、调试变量和说明里的旧品牌引用。若刷新页面后仍出现此类提示，需核对是否来自另一个扩展。

## 1.0.1 设置页修复验证

- 在实际加载扩展的 Chromium 中，使用本机测试 API 验证「测试翻译」的等待状态、成功译文、HTTP 401 错误、缺少模型提示，以及结束后按钮恢复可点击。
- 验证模型列表显示两个完整选项，不受已填写模型名过滤；选择模型后正确填入输入框，仍支持手动填写其他模型。
- 验证空列表、HTTP 403 均显示就地错误提示，并隐藏过期选项；修改服务商配置后，不显示旧请求返回的模型列表或测试结果。
- 同一浏览器脚本再次通过网页翻译、动态内容翻译及原文恢复检查。截图：`test-results/options.png`、`test-results/options-error.png`。
- 本次接口响应来自本机测试服务，没有使用用户的 API key。

## 已通过

- 独立依赖安装、TypeScript 类型检查、生产构建。
- 自动化检查：四种 API 协议的请求与结果解析、批次 ID 对应、错误时不回显密钥、模型列表、自定义地址校验、划词词典结果、字幕调度、空字幕后的播放器响应回退、字幕回填与停止清理、实时 CC 回退丢弃过时结果、朗读暂停/继续/跳转/原声恢复。
- Chrome for Testing 151 实际加载打包后的扩展，使用全新临时浏览器配置，独立运行。
- 扩展设置保存、本机测试 API 连接测试、模型列表获取、网页双语翻译、动态段落翻译、恢复原文、输入框保护。
- 带真实 HTMLVideoElement 播放的字幕测试页面：读取带时间轴的字幕 → 本机测试 API → 双语覆盖层 → macOS 系统语音。语音引擎实际返回 start、word、end 事件（测试音量为 0）；没有把模拟事件当作系统语音成功。
- 通过扩展弹窗的消息路径开关字幕和朗读、跳转播放位置、关闭后恢复原音量状态。
- 在实际网页的扩展隔离执行环境尝试读取 API 配置，Chrome 返回拒绝访问。
- 此 Mac 在测试浏览器中枚举到 181 个系统声音，含“婷婷”“瀚（高音质）”“美嘉”等中文声音。其他设备以其本机列表为准。

## 尚未通过的外部验收

- 真实 YouTube 页面已能读取视频 ID 和字幕轨。测试了 `jNQXAC9IVRw` 与 `arj7oStGLkU`，但本次测试环境中 YouTube 自己的 CC 请求和扩展的字幕请求都返回 HTTP 200 空响应，播放器自身也未显示字幕。因此不能宣称真实 YouTube 字幕获取已经通过。
- 扩展已提供播放器响应缓存和已显示 CC 文本的备用读取路径；这些路径的逻辑检查通过。若 YouTube 本身也无法显示 CC，备用路径无法凭空生成字幕。
- 没有使用用户真实 API key。模型协议通过固定响应和本机测试服务验证，尚未验证某个用户账户的权限、额度、真实译文质量与端到端延迟。
- 没有完成主观听感验收；系统语音调用成功不等于已经听评音色或所有视频的配音同步效果。

## 交付边界

可安装的独立扩展、完整独立源码和构建方式已提供。网页、字幕、朗读三部分均已实现；真实服务商与真实 YouTube 的最终使用验收尚需在用户配置 API 后进行。视频无字幕时的音频识别不在本版范围。

## 复现

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
pnpm exec playwright install chromium
node scripts/browser-check.mjs
node scripts/video-flow-check.mjs
node scripts/tts-browser-check.mjs
LINGO_CLOUD_TTS=1 node scripts/video-flow-check.mjs
node scripts/youtube-check.mjs
```

浏览器脚本使用独立临时配置，结束后删除测试配置，不读写用户日常 Chrome 的密钥、登录信息或扩展配置。`test-results/` 保存页面截图及结果快照；它不会打入扩展。
