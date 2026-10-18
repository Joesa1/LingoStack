# LingoStack · 译栈

[English](#english) | [中文](#中文)

## English

LingoStack is an independent Chrome extension for translating webpages and YouTube captions with an AI provider you configure yourself. It does not require a desktop app, a local server, or the original Dim Agent project.

### What it does

- Translates the current webpage on demand, with bilingual view, translation-only view, restore, and selected-text translation.
- Translates captions on regular YouTube watch pages and can read translated captions with Chrome system voices or supported cloud TTS providers.
- Supports OpenAI-compatible Chat Completions, OpenAI Responses, Anthropic Messages, and Gemini Generate Content translation APIs.
- Keeps translation and cloud-voice configuration separate. Translation color can follow the source page or use a custom color.

### Install locally in Chrome

1. Download a release archive and unzip it into a folder you will keep.
2. Open `chrome://extensions`, enable **Developer mode**, then choose **Load unpacked**.
3. Select the unzipped `chrome` folder, which contains `manifest.json`.
4. Pin LingoStack, open **Settings**, choose a provider, enter your own API key and model, test the connection, then save.
5. Refresh pages that were already open before installation.

Do not drag a ZIP into Chrome. Do not move or delete the loaded folder after installation. To update, replace the contents of the existing `chrome` folder and click **Reload** in `chrome://extensions`; keeping the same folder preserves local settings.

### Your API key and data

API keys are stored in Chrome extension local storage, not Chrome Sync. They are read by trusted extension pages and the extension background only; ordinary webpages do not receive them. Text you choose to translate, selected-text context, and video captions are sent directly to the provider you configure. LingoStack has no account system, analytics service, or hosted proxy.

Cloud TTS is optional and uses credentials and billing configured with that voice provider. A chat-product subscription is not necessarily API access.

### Current scope

LingoStack supports webpages and captioned videos on standard YouTube `/watch` pages. It does not include ASR for videos without captions, arbitrary video-site support, speaker recognition, voice cloning, MP3 preprocessing, or a Chrome Web Store listing.

### Build from source

Requires Node.js 22+ and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm run package
```

The build creates an unpacked extension in `dist/chrome` and release archives in `release/`. `pnpm run package` includes a credential-safe preflight scan. It prints only a file path and rule category if it finds a possible credential; it never prints the matched value.

## 中文

LingoStack（译栈）是独立的 Chrome 扩展，用用户自行配置的 AI 服务翻译网页与 YouTube 字幕。它不需要桌面应用、本机后台服务，也不依赖原 Dim Agent 项目。

### 功能

- 手动翻译当前网页，支持双语对照、仅译文、恢复原文和划词翻译。
- 翻译 YouTube 普通视频页字幕；可用 Chrome 系统声音或已支持的云端语音朗读译文。
- 支持兼容 Chat Completions、OpenAI Responses、Anthropic Messages 和 Gemini Generate Content 的翻译接口。
- 翻译和云端朗读分别配置；网页译文颜色可跟随原文或使用自定义颜色。

### 在 Chrome 本地安装

1. 下载发布包，解压到一个长期保留的文件夹。
2. 打开 `chrome://extensions`，开启右上角的「开发者模式」，点击「加载已解压的扩展程序」。
3. 选择解压后的 `chrome` 文件夹，其中必须包含 `manifest.json`。
4. 固定 LingoStack，打开「设置」，选择服务商，填入自己的 API Key 和模型，测试后保存。
5. 刷新安装前已打开的网页。

不要把 ZIP 直接拖入 Chrome。安装后不要移动或删除已加载的文件夹。升级时，用新版本的 `chrome` 文件夹内容覆盖原安装目录，在 `chrome://extensions` 点击「重新加载」；保留同一目录可以保留本机设置。

### API Key 与数据

API Key 保存于 Chrome 扩展本机存储，不使用 Chrome 同步。只有扩展可信页面和后台可以读取，普通网页无法取得。用户选择翻译的网页文字、划词上下文和视频字幕会直接发送给用户选择的服务商。译栈没有账户系统、埋点服务或自建中转服务器。

云端朗读是可选功能，凭证和费用由用户与所选语音服务商分别配置和结算。聊天产品订阅不等同于 API 使用资格。

### 当前范围

译栈支持网页和 YouTube 普通 `/watch` 页中的现有字幕。不提供无字幕视频的语音识别、任意视频网站适配、说话人识别、声音克隆、MP3 预处理，也尚未上架 Chrome 应用商店。

### 从源码构建

需要 Node.js 22+ 与 pnpm。

```sh
pnpm install --frozen-lockfile
pnpm run package
```

构建后，`dist/chrome` 是可加载扩展，`release/` 包含发布包。`pnpm run package` 会先执行不泄露内容的凭证检查：发现疑似凭证时只报告文件路径和规则类别，绝不输出匹配值。

## Verification

See [VALIDATION.md](VALIDATION.md) for the recorded validation boundary. See [docs/release/README.md](docs/release/README.md) for the public-release checklist.
