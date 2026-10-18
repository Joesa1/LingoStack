import { defineConfig } from "wxt"

export default defineConfig({
  outDir: "dist",
  outDirTemplate: "chrome",
  manifest: {
    name: "译栈 · 网页与字幕翻译",
    description: "使用自己的模型 API 翻译网页与 YouTube 字幕，用系统或云端自然声音朗读译文。",
    options_ui: { page: "options.html", open_in_tab: true },
    minimum_chrome_version: "124",
    permissions: ["storage", "contextMenus", "tts", "activeTab", "offscreen"],
    host_permissions: ["http://*/*", "https://*/*"],
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; media-src 'self' blob: data:; connect-src https: http://localhost:* http://127.0.0.1:*;" },
    icons: { 16: "icon/16.png", 32: "icon/32.png", 48: "icon/48.png", 128: "icon/128.png" },
    commands: { "toggle-translate": { suggested_key: { default: "Alt+T" }, description: "翻译当前网页 / 恢复原文" } },
  },
})
