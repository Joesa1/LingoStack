import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
execFileSync('node', ['scripts/release-check.mjs'], { stdio: 'inherit' })
const root = path.resolve('release/译栈')
await fs.mkdir(root, { recursive: true })
await fs.rm(path.join(root,'chrome'), { recursive:true,force:true })
await fs.cp('dist/chrome',path.join(root,'chrome'),{recursive:true})
for(const file of ['README.md','VALIDATION.md']) await fs.copyFile(file,path.join(root,file))
const manifest=JSON.parse(await fs.readFile(path.join(root,'chrome/manifest.json'),'utf8'))
if(manifest.permissions.includes('nativeMessaging') || manifest.key) throw new Error('Standalone identity or permissions check failed')
async function check(directory){ for(const item of await fs.readdir(directory,{withFileTypes:true})){const p=path.join(directory,item.name);if(item.isDirectory())await check(p);else if(/\.(js|json|html)$/.test(p)){const s=await fs.readFile(p,'utf8');if(/connectNative|sendNativeMessage/.test(s))throw new Error(`Unexpected old-project dependency: ${p}`)}}}
await check(path.join(root,'chrome'))
const instructions = `译栈 ${manifest.version}｜安装与使用

1. 解压分享包，把解压后的文件夹放到一个长期保留的位置。
2. 用电脑 Chrome 打开 chrome://extensions，开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择解压后包含 manifest.json 的 chrome 文件夹。
4. 从工具栏拼图菜单固定译栈，打开「设置」，选择服务商并填写自己的 API key。
5. 获取模型列表并选择模型，或手动填写模型 ID。测试通过后点击「保存配置」。
6. 刷新网页，点击译栈翻译网页；选中文字后可点击「译栈翻译」。

更新旧版：用新版 chrome 文件夹内容覆盖原安装目录，在扩展管理页点击「重新加载」，再刷新已打开的网页和视频。无需卸载，已有配置会保留。

安装后不要删除或移动扩展文件夹。不要直接把 ZIP 拖进 Chrome。使用者自行承担所选服务商的 API 费用。
字幕默认显示一行译文和一行原文；YouTube 没有字幕的视频暂不支持。朗读默认使用免费本机声音，也支持阿里百炼、Azure、MiniMax 云端音色。云端朗读与翻译分别配置、分别计费。

自然声音快速配置：
1. 推荐先在 https://bailian.console.aliyun.com/ 注册并开通百炼，创建北京区域 API Key。有可用试用额度时先试用，没有额度再按控制台提示开通付费。
2. 在译栈设置的「字幕朗读」选择阿里百炼、北京区域，填入自己的 Key，保留默认模型和音色。
3. 点击「试听并测试」，成功且满意后点击「保存朗读配置」。
4. 回到 YouTube 开启双语字幕和「译文朗读」。云端按短句生成后播放，会有网络等待；无字幕视频仍不支持。

其他服务：Azure https://portal.azure.com/（Speech 资源密钥和区域）；MiniMax https://platform.minimaxi.com/（国内站 API Key）。设置页也有开通链接。无需注册全部服务。
`
await fs.writeFile(path.join(root, 'INSTALL.txt'), instructions)
await fs.writeFile('release/译栈-安装说明.txt', instructions)
const shareZip = path.resolve(`release/译栈-${manifest.version}-朋友分享包.zip`)
await fs.rm(shareZip, { force: true })
execFileSync('zip', ['-qr', shareZip, 'chrome', 'INSTALL.txt'], { cwd: root })
const shareContents = execFileSync('unzip', ['-Z1', shareZip], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
if (!shareContents.includes('INSTALL.txt') || !shareContents.includes('chrome/manifest.json') || shareContents.some(item => item !== 'INSTALL.txt' && !item.startsWith('chrome/'))) {
  throw new Error('Share archive must contain only chrome/ and INSTALL.txt')
}
console.log(`Share archive: ${shareZip}`)
const zip=path.resolve(`release/译栈-${manifest.version}.zip`)
await fs.rm(zip,{force:true})
execFileSync('zip',['-qr',zip,'译栈'],{cwd:path.resolve('release')})
console.log(`Delivery: ${root}\nArchive: ${zip}`)

const sourceZip=path.resolve(`release/译栈-${manifest.version}-source.zip`)
await fs.rm(sourceZip,{force:true})
execFileSync('zip',['-qr',sourceZip,'src','entrypoints','public','scripts','tests','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','wxt.config.ts','vitest.config.ts','tsconfig.json','README.md','VALIDATION.md','.gitignore'])
console.log(`Source archive: ${sourceZip}`)
