import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lingo-web-check-'))
const data = path.join(temp, 'data')
const python = path.join(temp, 'captions')
// Replace only the external caption process for deterministic long-transcript testing.
await fs.writeFile(python, '#!/bin/sh\ncat ' + path.join(temp, 'captions.json') + '\n', { mode: 0o755 })
await fs.writeFile(path.join(temp, 'captions.json'), JSON.stringify({ title: '<img src=x onerror=alert(1)> Interview', language: 'en', rows: Array.from({ length: 180 }, (_, i) => ({ text: `Sentence ${i} contains a complete discussion about science and language learning.`, start: i * 10, duration: 10 })) }))
let calls = 0, fail = false, delayed = false
const model = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'fixture-chat' }] })); return }
  const text = JSON.parse(raw).messages.at(-1).content
  calls++
  if (fail) { res.writeHead(401); res.end(JSON.stringify({ error: 'private-fixture-key' })); return }
  if (!delayed && text.length > 1000) { delayed = true; await new Promise(r => setTimeout(r, 28000)) }
  res.end(JSON.stringify({ choices: [{ message: { content: '中文译文：' + text.slice(0, 70) }, finish_reason: 'stop' }] }))
})
await new Promise(r => model.listen(0, '127.0.0.1', r))
let child
async function start() {
  child = spawn(process.execPath, ['server.mjs'], { cwd: 'release/译伴-视频预处理-0.2.1', env: { ...process.env, LINGO_OPEN: '0', LINGO_PORT: '0', LINGO_DATA_DIR: data, LINGO_PYTHON: process.env.LINGO_LIVE_CAPTIONS === '1' ? path.resolve('release/译伴-视频预处理-0.2.1/.venv/bin/python3') : python } })
  return new Promise((resolve, reject) => { let out = ''; const timer = setTimeout(() => reject(Error('Server startup timeout')), 10000); child.stdout.on('data', d => { out += d; const match = out.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]) } }); child.on('error', reject) })
}
const browser = await chromium.launch({ headless: true })
try {
  let base = await start()
  const page = await browser.newPage(); page.setDefaultTimeout(process.env.LINGO_LIVE_CAPTIONS === '1' ? 150000 : 30000); const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto(base)
  await page.waitForFunction(() => document.querySelector('#provider').value === 'deepseek')
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
  assert.ok(delayed, 'Long translation must survive a response delayed beyond the old 25-second deadline'); assert.ok(calls >= 6); assert.equal(await page.locator('article img').count(), 0)
  await page.click('summary:has-text("查看原文")'); assert.ok((await page.locator('article textarea').first().inputValue()).length > 10000)
  const downloadPromise = page.waitForEvent('download'); await page.click('button:has-text("下载中文 TXT")'); const download = await downloadPromise; await download.saveAs(path.join(temp, 'result.txt')); assert.match(await fs.readFile(path.join(temp, 'result.txt'), 'utf8'), /中文译文/)
  fail = true; await page.click('#start'); await page.locator('article').filter({ hasText: '处理失败' }).waitFor(); fail = false
  await page.click('button:has-text("重试")'); await page.waitForFunction(() => !document.querySelector('#jobs').textContent.includes('处理失败') && document.querySelectorAll('article').length === 2 && [...document.querySelectorAll('article')].every(a => a.textContent.includes('已完成 ·')))
  const token = await page.locator('meta[name=lingo-token]').getAttribute('content')
  assert.equal((await fetch(base + '/api/jobs')).status, 403)
  assert.equal((await fetch(base + '/api/jobs', { headers: { 'X-Lingo-Token': token, Origin: 'https://evil.example' } })).status, 403)
  const files = await fs.readdir(data); for (const f of files) assert.ok(!(await fs.readFile(path.join(data, f), 'utf8')).includes('private-fixture-key'))
  await fs.mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/preprocess-0.2.1.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  child.kill(); await new Promise(r => child.once('exit', r)); base = await start(); await page.goto(base); await page.locator('article').first().waitFor(); assert.equal(await page.locator('article').count(), 2); assert.equal(await page.inputValue('#key'), '')
  assert.deepEqual(errors, [])
  console.log('PASS: 28-second delayed translation, providers, DeepSeek endpoint, models, test success/error redaction, URL validation, automatic caption task, chunked translation, safe rendering, retry, TXT, persistence, key isolation, origin protection, mobile layout.')
} finally { child?.kill(); await browser.close(); model.close(); await fs.rm(temp, { recursive: true, force: true }) }
