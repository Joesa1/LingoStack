const $ = id => document.getElementById(id)
const token = document.querySelector('meta[name=lingo-token]').content
let providers = {}, jobs = [], revision = 0, busy = false, view = ''
async function api(route, body) {
  const res = await fetch('/api/' + route, { method: body ? 'POST' : 'GET', headers: { 'X-Lingo-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const data = await res.json(); if (!res.ok) throw Error(data.error || '请求失败'); return data
}
function config() { return { preset: $('provider').value, apiKey: $('key').value, model: $('model').value, baseUrl: $('base').value, protocol: $('protocol').value } }
function message(id, text, error = false) { $(id).textContent = text; $(id).className = error ? 'error' : 'success' }
function edited() { revision++; $('configStatus').textContent = '' }
for (const id of ['key', 'model', 'base', 'protocol']) $(id).addEventListener('input', edited)
$('provider').onchange = () => {
  edited(); const p = providers[$('provider').value]; $('base').value = p.baseUrl; $('protocol').value = p.protocol; $('key').value = ''; $('model').value = ''
  $('models').replaceChildren(new Option('请获取此服务的模型列表', '')); $('base').closest('details').open = $('provider').value === 'custom'
}
$('models').onchange = () => { if ($('models').value) { $('model').value = $('models').value; edited() } }
async function testOrModels(kind, button) {
  const expected = revision; button.disabled = true; message('configStatus', kind === 'test' ? '正在测试连接，最多等待 3 分钟…' : '正在获取模型列表…')
  try {
    const data = await api(kind, { config: config() }); if (expected !== revision) return
    if (kind === 'models') {
      if (!data.models.length) throw Error('服务商返回空列表，请手填模型 ID。')
      $('models').replaceChildren(new Option('请选择模型', ''), ...data.models.map(id => new Option(id, id)))
      const preferred = data.models.includes('deepseek-chat') ? 'deepseek-chat' : data.models[0]
      if (!$('model').value) { $('model').value = preferred; $('models').value = preferred }
      message('configStatus', `已获取 ${data.models.length} 个模型。`)
    } else message('configStatus', '测试通过：' + data.text)
  } catch (e) { if (expected === revision) message('configStatus', e.message, true) } finally { button.disabled = false }
}
$('test').onclick = () => testOrModels('test', $('test'))
$('modelsButton').onclick = () => testOrModels('models', $('modelsButton'))
$('start').onclick = async () => {
  $('start').disabled = true
  try { await api('jobs', { url: $('url').value, config: config() }); message('status', '任务已创建，正在自动获取字幕。'); view = ''; await refresh() }
  catch (e) { message('status', e.message, true) } finally { $('start').disabled = busy }
}
function element(tag, text, parent) { const el = document.createElement(tag); if (text) el.textContent = text; parent.append(el); return el }
function download(job) {
  const blob = new Blob([job.title + '\n' + job.url + '\n\n' + job.translation], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `译伴-${job.videoId}-中文.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function render() {
  $('jobs').replaceChildren(); $('count').textContent = `${jobs.length} 个`
  for (const job of jobs) {
    const article = element('article', '', $('jobs')); element('h3', job.title, article)
    const a = element('a', '打开原视频 ↗', article); a.href = job.url; a.target = '_blank'; a.rel = 'noopener noreferrer'
    const labels = { fetching: '获取字幕中', translating: '分段翻译中', complete: '已完成', failed: '处理失败' }
    element('p', `${labels[job.status]} · 已翻译 ${job.translations.length} / ${job.parts.length} 段`, article)
    if (job.status === 'translating') element('p', `正在等待第 ${job.translations.length + 1} 段译文，每段最多等待 3 分钟。已完成内容会自动保存。`, article)
    if (job.error) element('p', job.error, article).className = 'error'
    if (job.status === 'failed') {
      const button = element('button', '重试（使用当前模型配置）', article); button.disabled = busy
      button.onclick = async () => { button.disabled = true; try { await api('retry', { id: job.id, config: config() }); view = ''; await refresh() } catch (e) { message('status', e.message, true); button.disabled = false } }
    }
    if (job.source) {
      const details = element('details', '', article); element('summary', '查看原文与中文全文', details)
      for (const [label, text] of [['原文', job.source], ['中文', job.translation || '等待翻译…']]) { const l = element('label', label, details); const t = element('textarea', '', l); t.value = text; t.readOnly = true }
    }
    if (job.translation) element('button', job.status === 'complete' ? '下载中文 TXT' : '下载已完成部分', article).onclick = () => download(job)
  }
  if (!jobs.length) element('p', '还没有视频。填写链接开始第一项任务。', $('jobs'))
}
async function refresh() {
  jobs = await api('jobs'); busy = jobs.some(j => ['fetching', 'translating'].includes(j.status)); $('start').disabled = busy
  if (jobs[0]?.status === 'complete' && !busy) message('status', '处理完成，可查看全文或下载中文 TXT。')
  const snapshot = JSON.stringify(jobs); if (snapshot !== view) {
    const active = jobs.find(j => ['fetching', 'translating'].includes(j.status))
    if (active) message('status', active.status === 'fetching' ? '正在自动获取字幕。' : `字幕已获取，正在翻译第 ${active.translations.length + 1} / ${active.parts.length} 段。`)
    else if (jobs[0]?.status === 'failed') message('status', '处理失败，原因见下方任务。已完成分段已保留。', true)
    view = snapshot; render()
  }
}
async function poll() { try { await refresh() } catch (e) { message('status', '无法连接本地服务，请重新双击启动程序并刷新页面。', true) } finally { setTimeout(poll, 2000) } }
async function init() {
  const data = await api('config'); providers = data.providers
  $('provider').replaceChildren(...Object.entries(providers).map(([id, p]) => new Option(p.name, id)))
  $('provider').value = 'deepseek'; $('provider').onchange()
  await refresh(); void poll()
}
void init().catch(e => message('status', '启动失败：' + e.message, true))
