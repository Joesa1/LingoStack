// @vitest-environment node
import { it, expect, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
vi.mock('../src/background/tts-provider', () => ({ synthesize: vi.fn() }))
import { synthesize } from '../src/background/tts-provider'
import { buildAudio, scriptRows } from '../web/audio'
const python = process.env.LINGO_AUDIO_PYTHON || path.resolve('release/译伴-视频预处理-0.3.0/.venv/bin/python3')
it('exports real MP3, preserves order and role voices, resumes without resynthesis, invalidates edited voices', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingo-audio-test-'))
  const run = promisify(execFile)
  const { stdout } = await run(python, ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'])
  const ffmpeg = stdout.trim()
  try {
    await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25', '-ar', '24000', path.join(dir, 'fixture.wav')])
    const audio = 'data:audio/wav;base64,' + (await fs.readFile(path.join(dir, 'fixture.wav'))).toString('base64')
    vi.mocked(synthesize).mockResolvedValue(audio)
    const job: any = { id: 'fixture', translation: '你好。' }
    const input = { mode: 'multi', script: 'A: 你好，欢迎。\nB: 谢谢，我们开始吧。', voiceB: 'Ethan', tts: { provider: 'dashscope', apiKey: 'fixture-secret', region: 'beijing', model: 'qwen3-tts-flash', voice: 'Cherry', style: '' } }
    const save = async () => { await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify(job)) }
    const signal = new AbortController().signal
    await buildAudio(job, input, dir, python, save, signal)
    expect(job.audio.status).toBe('complete'); expect(job.audio.done).toBe(2)
    expect(vi.mocked(synthesize).mock.calls.map(c => c[0].voice)).toEqual(['Cherry', 'Ethan'])
    const file = path.join(dir, job.id, job.audio.identity, 'final.mp3')
    expect((await fs.stat(file)).size).toBeGreaterThan(1000)
    await run(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'])
    await buildAudio(job, input, dir, python, save, signal)
    expect(synthesize).toHaveBeenCalledTimes(2)
    await buildAudio(job, { ...input, voiceB: 'Serena' }, dir, python, save, signal)
    expect(synthesize).toHaveBeenCalledTimes(4)
    expect(await fs.readFile(path.join(dir, 'job.json'), 'utf8')).not.toContain('fixture-secret')
    vi.mocked(synthesize).mockReset().mockResolvedValueOnce(audio).mockRejectedValueOnce(new Error('Interrupted'))
    const interrupted = { ...input, script: 'A: 第一段完成。\nB: 第二段中断。' }
    await expect(buildAudio(job, interrupted, dir, python, save, signal)).rejects.toThrow('Interrupted')
    expect(job.audio.done).toBe(1)
    vi.mocked(synthesize).mockResolvedValue(audio)
    await buildAudio(job, interrupted, dir, python, save, signal)
    expect(synthesize).toHaveBeenCalledTimes(3); expect(job.audio.status).toBe('complete')
    expect(() => scriptRows('C: text')).toThrow(); expect(() => scriptRows('unlabelled')).toThrow()
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}, 120000)
