import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { synthesize } from '../src/background/tts-provider'
import { speechChunks, validateTts } from '../src/shared/tts-config'

export function scriptRows(text: unknown) {
  if (typeof text !== 'string' || !text.trim() || text.length > 600_000) throw Error('配音台词为空或过长。')
  return text.split('\n').filter(s => s.trim()).flatMap(line => {
    const match = line.match(/^\s*([AB])[:：]\s*(.+)$/)
    if (!match) throw Error('每行请使用 A: 台词 或 B: 台词。')
    return speechChunks(match[2]!).map(text => ({ role: match[1]!, text }))
  })
}
export async function buildAudio(job: any, input: any, directory: string, python: string, save: (job: any) => Promise<void>, signal: AbortSignal) {
  const config = validateTts(input.tts)
  if (config.provider === 'system') throw Error('MP3 导出请选择云端语音服务。')
  const rows = input.mode === 'multi' ? scriptRows(input.script) : speechChunks(job.translation.replace(/>>|^\s*(?:Nick|Jack|说话人\d+)[:：]|\[(?:笑声?|笑|音乐|掌声|\s*__\s*)\]/gm, '')).map(text => ({ role: 'A', text }))
  if (!rows.length) throw Error('没有可合成的译文。')
  const voices = { A: config.voice, B: input.voiceB || config.voice }
  for (const row of rows) validateTts({ ...config, voice: voices[row.role as 'A' | 'B'] })
  const { apiKey, ...publicConfig } = config
  const identity = createHash('sha256').update(JSON.stringify([rows, publicConfig, voices])).digest('hex')
  const folder = path.join(directory, job.id, identity)
  await fs.mkdir(folder, { recursive: true, mode: 0o700 })
  const run = promisify(execFile)
  const { stdout } = await run(python, ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'])
  const ffmpeg = stdout.trim()
  job.audio = { status: 'running', done: 0, total: rows.length, identity, config: publicConfig, voiceB: voices.B, script: input.mode === 'multi' ? input.script : '', mode: input.mode, error: '' }; await save(job)
  for (let i = 0; i < rows.length; i++) {
    signal.throwIfAborted()
    const output = path.join(folder, `${i}.wav`)
    if (!await fs.stat(output).then(() => true, () => false)) {
      const row = rows[i]!
      const audio = await synthesize({ ...config, voice: voices[row.role as 'A' | 'B'] }, row.text, 'zh-CN', AbortSignal.any([signal, AbortSignal.timeout(180_000)]))
      const raw = path.join(folder, 'input.audio')
      await fs.writeFile(raw, Buffer.from(audio.split(',')[1]!, 'base64'), { mode: 0o600 })
      // Normalize each segment before joining; never concatenate compressed byte streams.
      await run(ffmpeg, ['-v', 'error', '-y', '-i', raw, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', output + '.tmp.wav'], { signal })
      await fs.rename(output + '.tmp.wav', output); await fs.rm(raw)
    }
    job.audio.done = i + 1; await save(job)
  }
  await fs.writeFile(path.join(folder, 'list.txt'), rows.map((_, i) => `file '${i}.wav'`).join('\n'))
  await run(ffmpeg, ['-v', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', path.join(folder, 'list.txt'), '-c:a', 'libmp3lame', '-b:a', '96k', path.join(folder, 'final.tmp.mp3')], { signal, timeout: 300_000 })
  await fs.rename(path.join(folder, 'final.tmp.mp3'), path.join(folder, 'final.mp3'))
  job.audio.status = 'complete'; await save(job)
}
