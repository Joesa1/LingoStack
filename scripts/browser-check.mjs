import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'lingo-check-'))
const extension = path.resolve('dist/chrome')
let translationRequests = 0
let testMode = 'success'
let modelsMode = 'success'
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.url === '/v1/chat/completions') {
    translationRequests++
    await new Promise(resolve => setTimeout(resolve, 400))
    if (testMode === 'error') { res.writeHead(401); res.end('{}'); return }
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const text = body.messages.at(-1).content
    const parts = text.split(/\n\s*%%\s*\n/)
    const content = parts.map((p, i) => p.includes('Hello world') ? '你好，世界。' : `测试译文 ${i + 1}`).join('\n%%\n')
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content } }] }))
  } else if (req.url === '/v1/models') {
    await new Promise(resolve => setTimeout(resolve, 400))
    if (modelsMode === 'error') { res.writeHead(403); res.end('{}'); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: modelsMode === 'empty' ? [] : [{ id: 'fixture-model' }, { id: 'another-model' }] }))
  }
  else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html lang="en"><body><h1>Read this page</h1><p id="source">Hello world. This paragraph should be translated.</p><p>Testing an independent browser extension.</p><input value="Do not translate editable text"></body></html>') }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = `http://127.0.0.1:${server.address().port}`
let context
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  const extensionId = new URL(worker.url()).host
  console.log('Loaded extension:', extensionId)
  const errors = []
  context.on('weberror', e => errors.push(e.error().message))
  const options = await context.newPage()
  await options.goto(`chrome-extension://${extensionId}/options.html`)
  await options.locator('#status').filter({ hasText: '填写' }).waitFor()
  await options.locator('#baseUrl').fill(address + '/v1')
  await options.locator('#model').fill('fixture-model')
  await options.locator('#save').click()
  await options.locator('#status').filter({ hasText: 'API 配置已保存' }).waitFor()
  await fs.mkdir('test-results', { recursive: true })
  const testStatus = options.locator('#testStatus')
  const modelsStatus = options.locator('#modelsStatus')
  await options.locator('#test').click()
  assert.equal(await options.locator('#test').isDisabled(), true)
  await testStatus.filter({ hasText: '正在测试翻译' }).waitFor()
  await options.locator('#testStatus[data-state=success]').waitFor()
  assert.match(await testStatus.textContent(), /测试通过：测试译文/)
  assert.equal(await options.locator('#test').isEnabled(), true)
  testMode = 'error'
  await options.locator('#test').click()
  await options.locator('#testStatus[data-state=error]').waitFor()
  assert.match(await testStatus.textContent(), /测试未通过.*401/)
  assert.equal(await options.locator('#test').isEnabled(), true)
  await options.screenshot({ path: 'test-results/options-error.png', fullPage: true })
  testMode = 'success'
  await options.locator('#model').fill('')
  await options.locator('#test').click()
  await options.locator('#testStatus[data-state=error]').waitFor()
  assert.match(await testStatus.textContent(), /模型/)
  await options.locator('#model').fill('fixture-model')
  await options.locator('#loadModels').click()
  assert.equal(await options.locator('#loadModels').isDisabled(), true)
  await modelsStatus.filter({ hasText: '正在获取' }).waitFor()
  await modelsStatus.filter({ hasText: '已获取 2' }).waitFor()
  assert.equal(await options.locator('#modelPicker').isVisible(), true)
  assert.deepEqual(await options.locator('#modelSelect option').allTextContents(), ['请选择模型', 'another-model', 'fixture-model'])
  assert.equal(await options.locator('#modelSelect').inputValue(), 'fixture-model')
  await options.locator('#modelSelect').selectOption('another-model')
  assert.equal(await options.locator('#model').inputValue(), 'another-model')
  await options.locator('#model').fill('custom-manual-model')
  assert.equal(await options.locator('#modelSelect').inputValue(), '')
  assert.equal(await options.locator('#modelSelect option').count(), 3)
  for (const [mode, expected] of [['empty', /空列表/], ['error', /403/]]) {
    modelsMode = mode
    await options.locator('#loadModels').click()
    await options.locator('#modelsStatus[data-state=error]').waitFor()
    assert.match(await modelsStatus.textContent(), expected)
    assert.equal(await options.locator('#modelPicker').isHidden(), true)
    assert.equal(await options.locator('#loadModels').isEnabled(), true)
  }
  modelsMode = 'success'
  await options.locator('#loadModels').click()
  await options.locator('#baseUrl').fill(address + '/changed')
  await options.waitForFunction(() => !document.querySelector('#loadModels').disabled)
  assert.equal(await options.locator('#modelPicker').isHidden(), true)
  assert.equal(await modelsStatus.isHidden(), true)
  await options.locator('#baseUrl').fill(address + '/v1')
  await options.locator('#loadModels').click()
  await modelsStatus.filter({ hasText: '已获取 2' }).waitFor()
  await options.locator('#modelSelect').selectOption('fixture-model')
  await options.locator('#test').click()
  await options.locator('#model').fill('changed-during-test')
  await options.waitForFunction(() => !document.querySelector('#test').disabled)
  assert.equal(await testStatus.isHidden(), true)
  await options.locator('#modelSelect').selectOption('fixture-model')
  await options.locator('#test').click()
  await options.locator('#testStatus[data-state=success]').waitFor()
  await options.screenshot({ path: 'test-results/options.png', fullPage: true })
  const voices = await worker.evaluate(async () => (await chrome.tts.getVoices()).map(v => ({ name: v.voiceName, lang: v.lang, remote: v.remote, extension: Boolean(v.extensionId) })))
  await fs.writeFile('test-results/voices.json', JSON.stringify(voices, null, 2))
  console.log('System voices:', voices.length, 'Chinese:', voices.filter(v => v.lang?.startsWith('zh')).map(v => v.name).join(', '))
  const page = await context.newPage(); await page.goto(address + '/article')
  const tabId = await worker.evaluate(async address => (await chrome.tabs.query({})).find(t => t.url === address + '/article').id, address)
  await worker.evaluate(async ({tabId}) => { await chrome.tabs.sendMessage(tabId, {type:'TR_SET_MODE', mode:'bilingual',targetLang:'zh-CN',generation:0}) }, {tabId})
  await page.getByText('你好，世界。', { exact: true }).waitFor({ timeout: 30000 })
  assert.equal(await page.locator('#source').getAttribute('data-lingo-tr-state'), 'done')
  await page.evaluate(() => { document.querySelector('#source').style.color = 'rgb(230, 230, 230)'; document.body.style.backgroundColor = '#181818' })
  const translated = '#source .lingo-tr__text'
  assert.equal(await page.locator(translated).evaluate(el => getComputedStyle(el).color), 'rgb(230, 230, 230)')
  const beforeColor = translationRequests
  await options.getByText('网页译文颜色', { exact: true }).click()
  await options.selectOption('#translationColorMode', 'custom')
  await options.locator('#colorStatus').filter({ hasText: '已保存' }).waitFor()
  await options.locator('#translationColor').fill('#ff6600')
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#source .lingo-tr__text')).color === 'rgb(255, 102, 0)')
  await options.reload(); await options.locator('#status').filter({ hasText: '配置已就绪' }).waitFor()
  assert.equal(await options.inputValue('#translationColorMode'), 'custom'); assert.equal(await options.inputValue('#translationColor'), '#ff6600')
  await options.getByText('网页译文颜色', { exact: true }).click()
  await options.selectOption('#translationColorMode', 'auto')
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#source .lingo-tr__text')).color === 'rgb(230, 230, 230)')
  await page.evaluate(() => { document.querySelector('#source').style.color = 'rgb(20, 20, 20)'; document.body.style.backgroundColor = '#ffffff' })
  assert.equal(await page.locator(translated).evaluate(el => getComputedStyle(el).color), 'rgb(20, 20, 20)')
  assert.equal(translationRequests, beforeColor, 'Color changes must not request another translation')

  assert.equal(await page.locator('input').inputValue(), 'Do not translate editable text')
  await page.evaluate(() => { const p=document.createElement('p'); p.textContent='Hello world. Added after translation.'; document.body.append(p) })
  await page.waitForFunction(() => [...document.querySelectorAll('p')].at(-1).textContent.includes('你好'))
  await worker.evaluate(async tabId => chrome.tabs.sendMessage(tabId,{type:'TR_SET_MODE', mode:'off',targetLang:'zh-CN',generation:0}),tabId)
  assert.equal(await page.locator('#source').textContent(), 'Hello world. This paragraph should be translated.')
  const cdp = await context.newCDPSession(page)
  async function shadowText() {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
    const collect = node => [node.nodeValue, ...(node.children ?? []).flatMap(collect), ...(node.shadowRoots ?? []).flatMap(collect)]
    return collect(root).join(' ')
  }
  async function lookupSelection() {
    await page.locator('#source').click({ clickCount: 3, position: { x: 50, y: 8 } })
    const trigger = page.locator('html > div[style*="2147483647"]')
    await trigger.waitFor({ state: 'visible' })
    assert.match(await shadowText(), /译栈翻译/)
    await trigger.click()
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const text = await shadowText()
      if (text.includes('你好，世界。')) return
      await page.waitForTimeout(100)
    }
    throw new Error('Selection translation did not render')
  }
  const beforeSelection = translationRequests
  await lookupSelection()
  assert.equal(translationRequests, beforeSelection + 1)
  await page.screenshot({ path: 'test-results/selection.png' })
  await page.keyboard.press('Escape')
  await lookupSelection()
  assert.equal(translationRequests, beforeSelection + 1, 'Repeated selection should use the local cache')
  await page.keyboard.press('Escape')
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await popup.locator('#status').filter({hasText:'模型'}).waitFor()
  await popup.screenshot({path:'test-results/popup.png',fullPage:true})
  console.log('Settings: test success/error/validation/pending, model selection/manual input/empty/error/stale responses, page translation, dynamic content and restore: PASS')
  assert.deepEqual(errors, [])
} finally { await context?.close(); server.close(); await fs.rm(profile,{recursive:true,force:true}) }
