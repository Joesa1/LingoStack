import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const root = path.resolve('release/译伴')
await fs.mkdir(root, { recursive: true })
await fs.rm(path.join(root,'chrome'), { recursive:true,force:true })
await fs.cp('dist/chrome',path.join(root,'chrome'),{recursive:true})
for(const file of ['README.md','VALIDATION.md']) await fs.copyFile(file,path.join(root,file))
const manifest=JSON.parse(await fs.readFile(path.join(root,'chrome/manifest.json'),'utf8'))
if(manifest.permissions.includes('nativeMessaging') || manifest.key) throw new Error('Standalone identity or permissions check failed')
async function check(directory){ for(const item of await fs.readdir(directory,{withFileTypes:true})){const p=path.join(directory,item.name);if(item.isDirectory())await check(p);else if(/\.(js|json|html)$/.test(p)){const s=await fs.readFile(p,'utf8');if(/connectNative|@archships|hmligbkccehjdcchldakljjnbcemfndn|dimcode:\/\//.test(s))throw new Error(`Unexpected old-project dependency: ${p}`)}}}
await check(path.join(root,'chrome'))
const zip=path.resolve(`release/译伴-${manifest.version}.zip`)
await fs.rm(zip,{force:true})
execFileSync('zip',['-qr',zip,'译伴'],{cwd:path.resolve('release')})
console.log(`Delivery: ${root}\nArchive: ${zip}`)

const sourceZip=path.resolve(`release/译伴-${manifest.version}-source.zip`)
await fs.rm(sourceZip,{force:true})
execFileSync('zip',['-qr',sourceZip,'src','entrypoints','public','scripts','tests','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','wxt.config.ts','vitest.config.ts','tsconfig.json','README.md','VALIDATION.md','.gitignore'])
console.log(`Source archive: ${sourceZip}`)
