const $ = id => document.getElementById(id)
const token = document.querySelector('meta[name=lingo-token]').content
let providers = {}, ttsProviders = {}, jobs = [], revision = 0, busy = false, view = ''
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
  refreshAudio();
  const snapshot = JSON.stringify(jobs); if (snapshot !== view) {
    const active = jobs.find(j => ['fetching', 'translating'].includes(j.status))
    if (active) message('status', active.status === 'fetching' ? '正在自动获取字幕。' : `字幕已获取，正在翻译第 ${active.translations.length + 1} / ${active.parts.length} 段。`)
    else if (jobs[0]?.status === 'failed') message('status', '处理失败，原因见下方任务。已完成分段已保留。', true)
    view = snapshot; render()
  }
}
async function poll() { try { await refresh() } catch (e) { message('status', '无法连接本地服务，请重新双击启动程序并刷新页面。', true) } finally { setTimeout(poll, 2000) } }
async function init() {
  const data = await api('config'); providers = data.providers; initAudio(data.tts)
  $('provider').replaceChildren(...Object.entries(providers).map(([id, p]) => new Option(p.name, id)))
  $('provider').value = 'deepseek'; $('provider').onchange()
  await refresh(); void poll()
}
void init().catch(e => message('status', '启动失败：' + e.message, true))

function tts(voice = $('voiceA').value) { return { provider: $('ttsProvider').value, apiKey: $('ttsKey').value, region: $('ttsRegion').value, model: $('ttsModel').value, voice, style: $('ttsStyle').value } }
let playerUrl = '', audioJobView = ''
function playAudio(url) { if (playerUrl) URL.revokeObjectURL(playerUrl); playerUrl = url; $('audioPlayer').src = url; $('audioPlayer').hidden = false; $('audioPlayer').play().catch(() => {}) }
function initAudio(data) {
  ttsProviders = data
  $('ttsProvider').replaceChildren(...Object.entries(data).map(([id, p]) => new Option(p.name, id)))
  $('ttsProvider').onchange = () => {
    const p = data[$('ttsProvider').value], c = p.defaults
    $('ttsKey').value = ''; $('ttsHelp').textContent = p.help
    const regions = c.provider === 'dashscope' ? [['beijing', '北京'], ['singapore', '新加坡']] : c.provider === 'minimax' ? [['cn', '国内'], ['global', '国际']] : [['eastus', '美国东部'], ['southeastasia', '东南亚'], ['westeurope', '西欧'], ['eastasia', '东亚']]
    $('regions').replaceChildren(...regions.map(([id, name]) => new Option(name, id))); $('ttsRegion').value = c.region
    $('ttsModel').replaceChildren(...(p.models.length ? p.models : ['']).map(id => new Option(id || 'Azure Neural', id)))
    $('ttsStyle').replaceChildren(...(c.provider === 'dashscope' ? ['', 'chat', 'calm', 'cheerful'] : ['']).map(id => new Option(({ chat: '自然对话', calm: '平静', cheerful: '愉快' })[id] || '默认', id)))
    $('ttsStyle').value = c.style
    setVoices(p.voices); $('voiceA').value = c.voice; $('voiceB').value = p.voices.find(v => v.id !== c.voice)?.id || c.voice
  }
  $('ttsProvider').onchange()
}
function setVoices(voices) { $('voices').replaceChildren(...voices.map(v => new Option(v.name, v.id))) }
async function audioAction(button, action) {
  button.disabled = true; message('audioMessage', '正在处理，请等待…')
  try { await action() } catch (e) { message('audioMessage', e.message, true) } finally { button.disabled = false }
}
$('voicesButton').onclick = () => audioAction($('voicesButton'), async () => { const r = await api('voices', { tts: tts() }); setVoices(r.voices); message('audioMessage', r.source) })
for (const role of ['A', 'B']) $('test' + role).onclick = () => audioAction($('test' + role), async () => { const r = await api('preview', { tts: tts($('voice' + role).value) }); playAudio(r.audio); message('audioMessage', '试听成功，请检查音色效果。') })
$('audioMode').onchange = () => { $('multiEditor').hidden = $('audioMode').value !== 'multi' }
function loadAudioJob() {
  const a = jobs.find(j => j.id === $('audioJob').value)?.audio
  $('audioScript').value = a?.script || ''; $('audioMode').value = a?.mode || 'single'; $('audioMode').onchange()
  if (a?.config && ttsProviders[a.config.provider]) {
    if ($('ttsProvider').value !== a.config.provider) { $('ttsProvider').value = a.config.provider; $('ttsProvider').onchange() }
    $('ttsRegion').value = a.config.region; $('ttsModel').value = a.config.model; $('ttsStyle').value = a.config.style; $('voiceA').value = a.config.voice; $('voiceB').value = a.voiceB || a.config.voice
  }
}
$('audioJob').onchange = () => { loadAudioJob(); refreshAudio() }
$('rolesButton').onclick = () => audioAction($('rolesButton'), async () => {
  const id = $('audioJob').value, before = $('audioScript').value
  const r = await api('roles', { id, config: config() })
  if (id !== $('audioJob').value || before !== $('audioScript').value) throw Error('台词或视频已变更，请重新整理。')
  $('audioScript').value = r.script; message('audioMessage', '草稿已生成，所有角色归属均需核对。修改后先试听。')
})
$('previewButton').onclick = () => audioAction($('previewButton'), async () => {
  const j = jobs.find(j => j.id === $('audioJob').value)
  if (!j) throw Error('请选择已翻译的视频。')
  const multi = $('audioMode').value === 'multi'
  const lines = multi ? $('audioScript').value.split('\n').filter(s => s.trim()).slice(0, 2) : [j.translation]
  if (!lines.length) throw Error('请先填写角色台词。')
  for (const line of lines) {
    const m = line.match(/^\s*([AB])[:：]\s*(.+)$/)
    if (multi && !m) throw Error('请使用 A: 台词 或 B: 台词。')
    const r = await api('preview', { tts: tts(m?.[1] === 'B' ? $('voiceB').value : $('voiceA').value), text: m ? m[2] : line })
    playAudio(r.audio)
    if (lines.length > 1) await new Promise(resolve => { const timer = setTimeout(resolve, 90000); const done = () => { clearTimeout(timer); resolve() }; $('audioPlayer').onended = done; $('audioPlayer').onerror = done; $('audioPlayer').onpause = done })
  }
  message('audioMessage', '片段试听已生成。')
})
$('audioStart').onclick = () => audioAction($('audioStart'), async () => { await api('audio-start', { id: $('audioJob').value, mode: $('audioMode').value, script: $('audioScript').value, voiceB: $('voiceB').value, tts: tts() }); message('audioMessage', '后台合成已启动。可关闭网页，请保留启动终端。'); await refresh() })
$('audioStop').onclick = () => audioAction($('audioStop'), async () => { await api('audio-stop', { id: $('audioJob').value }); message('audioMessage', '已请求停止。') })
$('audioDownload').onclick = () => audioAction($('audioDownload'), async () => {
  const r = await fetch('/api/audio?id=' + encodeURIComponent($('audioJob').value), { headers: { 'X-Lingo-Token': token } })
  if (!r.ok) throw Error('音频不可用，请刷新任务状态。')
  const url = URL.createObjectURL(await r.blob()); playAudio(url)
  const a = document.createElement('a'); a.href = url; a.download = '译伴-' + $('audioJob').value + '.mp3'; a.click(); message('audioMessage', '完整 MP3 已准备好。')
})
function refreshAudio() {
  const completed = jobs.filter(j => j.status === 'complete'), ids = completed.map(j => j.id).join(',')
  if (ids !== audioJobView) { const selected = $('audioJob').value; $('audioJob').replaceChildren(...completed.map(j => new Option(j.title, j.id))); if (completed.some(j => j.id === selected)) $('audioJob').value = selected; audioJobView = ids; if ($('audioJob').value !== selected) loadAudioJob() }
  const a = jobs.find(j => j.id === $('audioJob').value)?.audio
  $('audioProgress').textContent = a ? `${({ running: '合成中', failed: '合成未完成', complete: 'MP3 已完成' })[a.status]} · ${a.done || 0} / ${a.total || 0} 段。${a.error || ''}` : '请选择视频并配置语音，先试听再生成全文。'
  $('audioDownload').hidden = a?.status !== 'complete'
  $('audioStop').disabled = a?.status !== 'running'
}
