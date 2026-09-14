import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
const require = createRequire(import.meta.url)
const packages = await fs.readdir('node_modules/.pnpm')
const esbuild = require(path.resolve('node_modules/.pnpm', packages.find(n => n.startsWith('esbuild@')), 'node_modules/esbuild/lib/main.js'))
const out = path.resolve('release/译伴-视频预处理-0.2.0')
await fs.mkdir(out, { recursive: true })
await esbuild.build({ entryPoints: ['web/server.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(out, 'server.mjs'), target: 'node22' })
for (const name of ['index.html', 'app.js', 'style.css', 'captions.py', 'requirements.txt', 'NODE-LICENSE.txt', 'README.md', '启动译伴.command']) await fs.copyFile('web/' + name, path.join(out, name))
await fs.chmod(path.join(out, '启动译伴.command'), 0o755)
await fs.mkdir(path.join(out, 'runtime'), { recursive: true })
await fs.copyFile(await fs.realpath(process.execPath), path.join(out, 'runtime/node'))
await fs.chmod(path.join(out, 'runtime/node'), 0o755)
const zip = path.resolve('release/译伴-视频预处理-0.2.0-Mac.zip')
await fs.rm(zip, { force: true })
execFileSync('zip', ['-qr', zip, path.basename(out), '-x', '*/.venv/*', '*/__pycache__/*'], { cwd: path.dirname(out) })
console.log(zip)
