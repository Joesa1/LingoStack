import http from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes, randomUUID } from 'node:crypto'
import { PROVIDERS, validateProvider } from '../src/shared/provider-config'
import { complete, listModels, ProviderError } from '../src/background/provider'

const root = path.dirname(fileURLToPath(import.meta.url))
const directory = process.env.LINGO_DATA_DIR || path.join(os.homedir(), 'Library/Application Support/LingoPreprocess')
await fs.mkdir(directory, { recursive: true, mode: 0o700 })
const token = randomBytes(24).toString('hex')
const jobs = new Map<string, any>()
for (const file of await fs.readdir(directory)) {
  if (!/^[a-f0-9-]+\.json$/.test(file)) continue
  try { const job = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')); if (['fetching', 'translating'].includes(job.status)) { job.status = 'failed'; job.error = '上次处理被中断，请点击重试。' }; jobs.set(job.id, job) } catch {}
}
let running: string | undefined
async function save(job: any) {
  const file = path.join(directory, `${job.id}.json`)
  await fs.writeFile(file + '.tmp', JSON.stringify(job), { mode: 0o600 }); await fs.rename(file + '.tmp', file)
}
export function youtubeId(raw: unknown) {
  if (typeof raw !== 'string' || raw.length > 2048) throw Error('请填写 YouTube 视频链接。')
  let u: URL; try { u = new URL(raw) } catch { throw Error('视频链接格式不正确。') }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) throw Error('请使用 https 的 YouTube 视频链接。')
  const id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(u.hostname) && u.pathname === '/watch' ? u.searchParams.get('v') : ''
  if (!id || !/^[\w-]{11}$/.test(id)) throw Error('此版支持 YouTube 普通视频链接和 youtu.be 短链接。')
  return id
}
function captionText(rows: any[]) {
  let previous = ''
  const lines: string[] = []
  for (const row of rows) {
    const text = String(row.text || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    let added = text
    if (text === previous) continue
    if (text.startsWith(previous + ' ')) added = text.slice(previous.length).trim()
    else { const a = previous.split(' '), b = text.split(' '); for (let n = Math.min(a.length, b.length); n >= 2; n--) if (a.slice(-n).join(' ') === b.slice(0, n).join(' ')) { added = b.slice(n).join(' '); break } }
    previous = text
    if (added) lines.push(added)
  }
  return lines.join(' ')
}
function segments(text: string) {
  const result: string[] = []; let current = ''
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)) {
    if (current.length + segment.length > 3500 && current) { result.push(current); current = '' }
    current += segment
    while (current.length > 3500) { let cut = current.lastIndexOf(' ', 3500); if (cut < 1000) cut = 3500; result.push(current.slice(0, cut)); current = current.slice(cut).trimStart() }
  }
  if (current.trim()) result.push(current.trim())
  return result
}
async function processJob(job: any, config: any) {
  try {
    if (!job.source) {
      job.status = 'fetching'; await save(job)
      const python = process.env.LINGO_PYTHON || path.join(root, '.venv/bin/python3')
      let data: any
      try { const { stdout } = await promisify(execFile)(python, [path.join(root, 'captions.py'), job.videoId], { timeout: 120_000, maxBuffer: 12_000_000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }); data = JSON.parse(stdout) }
      catch { throw Error('字幕获取超时或本地组件未就绪。请检查网络，重新启动后重试。') }
      if (data.error) throw Error(data.error === 'NO_CAPTIONS' ? '视频没有可获取的字幕。本版尚不含音频转录。' : data.error === 'UNAVAILABLE' ? '视频不存在、已下架或需要访问权限。' : 'YouTube 拒绝请求或网络连接失败。请确认视频可访问，检查代理后重试；本应用不会读取浏览器登录信息。')
      if (!Array.isArray(data.rows)) throw Error('字幕返回格式错误。')
      job.source = captionText(data.rows); job.title = data.title; job.language = data.language
      if (!job.source || job.source.length > 600_000) throw Error('字幕为空或超过本版长度限制。')
      job.parts = segments(job.source); job.translations = []
    }
    job.status = 'translating'; job.error = ''; await save(job)
    for (let i = job.translations.length; i < job.parts.length; i++) {
      const translated = await complete(config, 'Translate the supplied video transcript into natural Simplified Chinese. Reconstruct complete sentences across subtitle fragments. Preserve all substantive information, names, numbers and speaker distinctions; do not summarize or invent information. Output only the translation.', job.parts[i], fetch, 180_000)
      job.translations.push(translated); job.translation = job.translations.join('\n\n'); await save(job)
    }
    job.status = 'complete'; await save(job)
  } catch (e) { job.status = 'failed'; job.error = e instanceof ProviderError && e.code === 'timeout' ? `第 ${job.translations.length + 1} 段翻译等待超过 3 分钟，未收到完整译文。已保留完成的分段；请检查服务商状态与网络后重试。` : e instanceof Error ? e.message : '处理失败。'; await save(job) }
  finally { running = undefined }
}
const server = http.createServer(async (req, res) => {
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  const json = (value: unknown, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
  if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return json({ error: '拒绝外部页面请求。' }, 403)
  const route = new URL(req.url || '/', origin).pathname
  try {
    if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(route)) {
      const name = route === '/' ? 'index.html' : route.slice(1)
      let body = await fs.readFile(path.join(root, name), 'utf8')
      if (name === 'index.html') body = body.replace('__TOKEN__', token)
      res.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css', 'Cache-Control': 'no-store' }); res.end(body); return
    }
    if (req.headers['x-lingo-token'] !== token) return json({ error: '页面已失效，请刷新。' }, 403)
    if (req.method === 'GET' && route === '/api/config') return json({ version: '0.2.1', providers: PROVIDERS })
    if (req.method === 'GET' && route === '/api/jobs') return json([...jobs.values()].sort((a, b) => b.createdAt - a.createdAt))
    if (req.method !== 'POST') return json({ error: '接口不存在。' }, 404)
    if (!req.headers['content-type']?.startsWith('application/json')) return json({ error: '请求格式错误。' }, 400)
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 30_000) { json({ error: '请求过大。' }, 413); return } }
    const input = JSON.parse(body)
    if (route === '/api/test' || route === '/api/models') {
      const config = validateProvider(input.config, route === '/api/test')
      return json(route === '/api/test' ? { text: await complete(config, 'Translate into Simplified Chinese.', 'Hello, this connection works.', fetch, 180_000) } : { models: await listModels(config) })
    }
    if (route === '/api/jobs' || route === '/api/retry') {
      if (running) return json({ error: '已有任务处理中，请等待完成。' }, 409)
      const config = validateProvider(input.config)
      const videoId = route === '/api/jobs' ? youtubeId(input.url) : undefined
      const job = route === '/api/jobs' ? { id: randomUUID(), videoId, url: `https://www.youtube.com/watch?v=${videoId}`, title: '正在获取视频字幕…', createdAt: Date.now(), status: 'fetching', source: '', translation: '', parts: [], translations: [] } : jobs.get(input.id)
      if (!job || (route === '/api/retry' && job.status !== 'failed')) throw Error('没有可重试的失败任务。')
      // Reuse completed chunks only with the same model, endpoint and protocol.
      const identity = JSON.stringify([config.baseUrl, config.model, config.protocol])
      if (job.identity && job.identity !== identity) { job.translations = []; job.translation = '' }
      job.identity = identity; job.error = ''; job.status = job.source ? 'translating' : 'fetching'
      jobs.set(job.id, job); running = job.id; await save(job)
      void processJob(job, config); return json({ id: job.id }, 202)
    }
    return json({ error: '接口不存在。' }, 404)
  } catch (e) { json({ error: e instanceof SyntaxError ? '请求格式错误。' : e instanceof Error ? e.message : '请求失败。' }, 400) }
})
server.listen(Number(process.env.LINGO_PORT || 18743), '127.0.0.1', () => {
  const url = `http://127.0.0.1:${(server.address() as any).port}`
  console.log(`译伴视频预处理 0.2.1\n${url}\n关闭终端会停止服务；已完成内容保存在本机。`)
  if (process.env.LINGO_OPEN !== '0') execFile('open', [url], () => {})
})
server.on('error', () => { console.error('启动失败：端口可能已被占用。请关闭旧的译伴预处理窗口后重试。'); process.exitCode = 1 })
