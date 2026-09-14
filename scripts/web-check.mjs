import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lingo-web-check-'))
const data = path.join(temp, 'data')
const python = path.join(temp, 'captions')
const hook = path.join(temp, 'voice-fixture.mjs')
// Stub only the remote TTS transport; exercise the real server, adapter and MP3 encoder.
const wav = Buffer.alloc(44 + 12000)
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(12000, 40)
await fs.writeFile(hook, `const original = globalThis.fetch; globalThis.fetch = async (url, init) => {
 if (String(url).startsWith('https://dashscope.aliyuncs.com/')) {
  if (init.headers.Authorization !== 'Bearer fixture-voice-key') return new Response('{}', { status: 401 });
  return Response.json({output:{audio:{url:'https://dashscope-test.oss-cn-beijing.aliyuncs.com/fixture.wav'}}});
 }
 if (String(url).startsWith('https://dashscope-test.oss-cn-beijing.aliyuncs.com/')) return new Response(Buffer.from('${wav.toString('base64')}', 'base64'));
 return original(url, init);
}`)

// Replace only the external caption process for deterministic long-transcript testing.
await fs.writeFile(python, '#!/bin/sh\ncat ' + path.join(temp, 'captions.json') + '\n', { mode: 0o755 })
await fs.writeFile(path.join(temp, 'captions.json'), JSON.stringify({ title: '<img src=x onerror=alert(1)> Interview', language: 'en', rows: Array.from({ length: 180 }, (_, i) => ({ text: `Sentence ${i} contains a complete discussion about science and language learning.`, start: i * 10, duration: 10 })) }))
let calls = 0, fail = false, delayed = false
const model = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'fixture-chat' }] })); return }
  const messages = JSON.parse(raw).messages
  const text = messages.at(-1).content
  if (messages[0].content.startsWith('Assign each numbered')) {
    const batch = JSON.parse(text.split('Sentences:\n')[1])
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(batch.map((_, i) => i % 2 ? 'B' : 'A')) } }] })); return
  }
  calls++
  if (fail) { res.writeHead(401); res.end(JSON.stringify({ error: 'private-fixture-key' })); return }
  if (!delayed && text.length > 1000) { delayed = true; await new Promise(r => setTimeout(r, 28000)) }
  res.end(JSON.stringify({ choices: [{ message: { content: '中文译文：' + text.slice(0, 70) }, finish_reason: 'stop' }] }))
})
await new Promise(r => model.listen(0, '127.0.0.1', r))
let child
async function start() {
  child = spawn(process.execPath, ['server.mjs'], { cwd: 'release/译伴-视频预处理-0.3.0', env: { ...process.env, NODE_OPTIONS: '--import=' + pathToFileURL(hook).href, LINGO_AUDIO_PYTHON: process.env.LINGO_AUDIO_PYTHON || path.resolve('release/译伴-视频预处理-0.3.0/.venv/bin/python3'), LINGO_OPEN: '0', LINGO_PORT: '0', LINGO_DATA_DIR: data, LINGO_PYTHON: process.env.LINGO_LIVE_CAPTIONS === '1' ? path.resolve('release/译伴-视频预处理-0.3.0/.venv/bin/python3') : python } })
  return new Promise((resolve, reject) => { let out = ''; const timer = setTimeout(() => reject(Error('Server startup timeout')), 10000); child.stdout.on('data', d => { out += d; const match = out.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]) } }); child.on('error', reject) })
}
const browser = await chromium.launch({ headless: true })
try {
  let base = await start()
  const page = await browser.newPage(); page.setDefaultTimeout(process.env.LINGO_LIVE_CAPTIONS === '1' ? 150000 : 30000); const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto(base)
  await page.waitForFunction(() => document.querySelector('#provider').value === 'deepseek')
  assert.equal(await page.locator('#ttsProvider option').count(), 3)
  assert.equal(await page.inputValue('#voiceA'), 'Cherry')
  await page.selectOption('#ttsProvider', 'azure'); assert.equal(await page.inputValue('#voiceA'), 'zh-CN-XiaoxiaoNeural')
  await page.selectOption('#ttsProvider', 'minimax'); assert.equal(await page.locator('#ttsModel option').count(), 2)
  await page.selectOption('#ttsProvider', 'dashscope')
  await page.selectOption('#audioMode', 'multi'); assert.equal(await page.locator('#multiEditor').isVisible(), true)
  await page.fill('#audioScript', 'A: 我会保留这份草稿。')
  await page.selectOption('#audioMode', 'single'); assert.equal(await page.locator('#multiEditor').isVisible(), false)

  assert.equal(await page.inputValue('#base'), 'https://api.deepseek.com/v1')
  assert.equal(await page.locator('#provider option').count(), 9)
  await page.selectOption('#provider', 'custom'); await page.fill('#base', `http://127.0.0.1:${model.address().port}/v1`); await page.fill('#key', 'private-fixture-key')
  await page.click('#modelsButton'); await page.locator('#configStatus').filter({ hasText: '已获取' }).waitFor()
  assert.equal(await page.inputValue('#model'), 'fixture-chat')
  await page.click('#test'); await page.locator('#configStatus').filter({ hasText: '测试通过' }).waitFor()
  fail = true; await page.click('#test'); await page.locator('#configStatus').filter({ hasText: '401' }).waitFor(); assert.ok(!(await page.textContent('#configStatus')).includes('private-fixture-key')); fail = false
  await page.fill('#url', 'https://evil.example/watch?v=aYkZbuFfezU'); await page.click('#start'); await page.locator('#status').filter({ hasText: 'YouTube' }).waitFor()
  await page.fill('#url', 'https://youtu.be/aYkZbuFfezU?t=45'); await page.click('#start')
  await page.locator('article').filter({ hasText: '每段最多等待 3 分钟' }).waitFor()
  await page.locator('article').filter({ hasText: '已完成 ·' }).waitFor({ timeout: 150000 })
  assert.equal(await page.locator('#audioJob option').count(), 1)
  await page.selectOption('#audioMode', 'multi'); await page.click('#rolesButton')
  await page.locator('#audioMessage').filter({ hasText: '草稿已生成' }).waitFor()
  assert.match(await page.inputValue('#audioScript'), /^A: /)
  await page.fill('#audioScript', 'A: 手动修改后不会被轮询覆盖。')
  await page.waitForTimeout(2500)
  assert.equal(await page.inputValue('#audioScript'), 'A: 手动修改后不会被轮询覆盖。')
  await page.fill('#ttsKey', 'fixture-voice-key')
  await page.fill('#audioScript', 'Missing role label')
  await page.click('#audioStart'); await page.locator('#audioMessage').filter({ hasText: '每行请使用' }).waitFor()
  await page.fill('#audioScript', 'A: 欢迎来到测试。\nB: 谢谢，我们开始吧。')
  await page.click('#testA'); await page.locator('#audioMessage').filter({ hasText: '试听成功' }).waitFor()
  await page.click('#audioStart'); await page.locator('#audioProgress').filter({ hasText: 'MP3 已完成' }).waitFor()
  const mp3Promise = page.waitForEvent('download'); await page.click('#audioDownload'); const mp3 = await mp3Promise; await mp3.saveAs(path.join(temp, 'audio.mp3'))
  assert.ok((await fs.stat(path.join(temp, 'audio.mp3'))).size > 1000)
  await page.selectOption('#audioMode', 'single')
  assert.ok(delayed, 'Long translation must survive a response delayed beyond the old 25-second deadline'); assert.ok(calls >= 6); assert.equal(await page.locator('article img').count(), 0)
  await page.click('summary:has-text("查看原文")'); assert.ok((await page.locator('article textarea').first().inputValue()).length > 10000)
  const downloadPromise = page.waitForEvent('download'); await page.click('button:has-text("下载中文 TXT")'); const download = await downloadPromise; await download.saveAs(path.join(temp, 'result.txt')); assert.match(await fs.readFile(path.join(temp, 'result.txt'), 'utf8'), /中文译文/)
  fail = true; await page.click('#start'); await page.locator('article').filter({ hasText: '处理失败' }).waitFor(); fail = false
  await page.click('button:has-text("重试")'); await page.waitForFunction(() => !document.querySelector('#jobs').textContent.includes('处理失败') && document.querySelectorAll('article').length === 2 && [...document.querySelectorAll('article')].every(a => a.textContent.includes('已完成 ·')))
  const token = await page.locator('meta[name=lingo-token]').getAttribute('content')
  assert.equal((await fetch(base + '/api/jobs')).status, 403)
  assert.equal((await fetch(base + '/api/jobs', { headers: { 'X-Lingo-Token': token, Origin: 'https://evil.example' } })).status, 403)
  const files = await fs.readdir(data, { recursive: true }); for (const f of files.filter(f => f.endsWith('.json'))) { const saved = await fs.readFile(path.join(data, f), 'utf8'); assert.ok(!saved.includes('private-fixture-key')); assert.ok(!saved.includes('fixture-voice-key')) }
  await fs.mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/preprocess-0.3.0.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  child.kill(); await new Promise(r => child.once('exit', r)); base = await start(); await page.goto(base); await page.locator('article').first().waitFor(); assert.equal(await page.locator('article').count(), 2); assert.equal(await page.inputValue('#key'), ''); assert.equal(await page.inputValue('#ttsKey'), '')
  assert.deepEqual(errors, [])
  console.log('PASS: real MP3 export via mocked cloud transport, audio providers, voice defaults, editable role draft, invalid script rejection, 28-second delayed translation, providers, DeepSeek endpoint, models, test success/error redaction, URL validation, automatic caption task, chunked translation, safe rendering, retry, TXT, persistence, key isolation, origin protection, mobile layout.')
} finally { child?.kill(); await browser.close(); model.close(); await fs.rm(temp, { recursive: true, force: true }) }
