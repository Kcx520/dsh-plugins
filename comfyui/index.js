/**
 * dsh-comfyui — Local ComfyUI bridge for DeepSeek Harness.
 *
 * Registers model-facing tools so a single sentence from the user becomes a
 * real generation job on the user's own ComfyUI server:
 *
 *   comfyui_status   — is the server up, which models are installed, what is queued
 *   comfyui_image    — Qwen-Image 2.1 text-to-image (and reference-image edit)
 *   comfyui_video    — MiniMax-H3 image/text-to-video (submits, returns prompt_id)
 *   comfyui_wait     — wait for a submitted job, fetch the files into the workspace
 *   comfyui_cancel   — interrupt a running job
 *   comfyui_recent   — list the most recent generated files
 *
 * Design boundaries:
 *   - no ComfyUI API key: it talks to a server the user already runs locally;
 *   - output is copied into the workspace through ComfyUI's /view endpoint, so
 *     the agent never needs to know where the server keeps its output folder;
 *   - every model filename and default is plain config, editable in
 *     cordis.patch.yml without touching this file.
 *
 * @module dsh-comfyui
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-comfyui'
export const inject = ['tools']

/** Seconds of video -> MiniMax-H3 frame count. The model's grid is 17k+5. */
export function framesForSeconds (seconds, fps = 24) {
  const target = Math.max(1, Number(seconds) || 5) * fps
  const k = Math.max(1, Math.round((target - 5) / 17))
  return Math.min(3600, 17 * k + 5)
}

const clamp = (value, min, max, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

const snap = (value, step, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(step, Math.round(n / step) * step)
}

const randomSeed = () => Math.floor(Math.random() * 2 ** 47)

/** fetch() with a wall clock, because an unresponsive ComfyUI must not hang a turn. */
async function request (url, init = {}, timeoutMs = 60_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function failure (what, detail) {
  const error = new Error(`${what}: ${detail}`)
  error.dshFriendly = true
  return error
}

/** ComfyUI speaks JSON on every endpoint we use; error bodies carry the reason. */
async function asJson (response, what) {
  const text = await response.text()
  if (!response.ok) {
    throw failure(what, `HTTP ${response.status} ${text.slice(0, 600)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw failure(what, `expected JSON, got: ${text.slice(0, 300)}`)
  }
}

function applyInner (ctx, config = {}) {
  const baseUrl = String(config.baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '')
  const outputDir = config.outputDir
  const pollMs = Number(config.pollMs) || 2000
  const defaultWait = Number(config.waitTimeoutSeconds) || 900

  // How to bring the backend up when it is not running. This is the batch file
  // the user's desktop shortcut points at — launching the .lnk itself does
  // nothing from a non-interactive spawn, the .bat does.
  const startup = {
    enabled: true,
    bat: 'D:\\kcx2008\\ComfyUI\\ComfyUI_windows_portable\\run_nvidia_gpu.bat',
    workdir: 'D:\\kcx2008\\ComfyUI\\ComfyUI_windows_portable',
    timeoutSeconds: 180,
    ...(config.startup || {}),
  }

  const image = {
    unet: 'qwen_image_2.1_int8_convrot.safetensors',
    clip: 'qwen3vl_8b_int8_convrot.safetensors',
    vae: 'qwen_image_2.1_vae_bf16.safetensors',
    width: 1024,
    height: 1024,
    steps: 25,
    cfg: 1,
    sampler: 'euler',
    scheduler: 'simple',
    resolution: 1024,
    ...(config.image || {}),
  }

  const video = {
    unet: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
    clip: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    videoVae: 'minimax_h3_video_vae_fp16.safetensors',
    audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
    lora: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
    turbo: true,
    turboSteps: 8,
    fullSteps: 20,
    sampler: 'res_multistep',
    scheduler: 'simple',
    width: 1344,
    height: 768,
    seconds: 5,
    fps: 24,
    ...(config.video || {}),
  }

  // ---------------------------------------------------------------- transport

  async function serverUp () {
    try {
      await asJson(await request(`${baseUrl}/system_stats`, {}, 5_000), 'probe')
      return true
    } catch {
      return false
    }
  }

  /**
   * Starting the backend used to be the user's job: a restart of the app (or a
   * closed console) silently left 8188 dead and every generation failed. Now a
   * dead port launches the same shortcut the user double-clicks and we wait for
   * it, so "make me a picture" works from a cold machine.
   */
  async function ensureServer () {
    if (await serverUp()) return
    if (!startup.enabled) {
      throw failure('ComfyUI 没在运行', `${baseUrl} 连不上，并且自动启动已关闭（startup.enabled=false）。请手动启动 ComfyUI。`)
    }
    const { spawn } = await import('node:child_process')
    const child = spawn('cmd.exe', ['/c', 'start', '', '/D', startup.workdir, startup.bat], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    const deadline = Date.now() + Math.max(30, startup.timeoutSeconds) * 1000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      if (await serverUp()) return
    }
    throw failure(
      'ComfyUI 启动超时',
      `已用 ${startup.bat} 启动，但 ${startup.timeoutSeconds}s 内 ${baseUrl} 仍未响应；首帧较大或显卡被占用时会更慢，可手动确认后重试。`
    )
  }

  async function getHistory (promptId) {
    const data = await asJson(
      await request(`${baseUrl}/history/${promptId}`, {}, 30_000),
      'read job history'
    )
    return data[promptId]
  }

  async function submit (graph) {
    const response = await request(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: 'dsh-comfyui' }),
    }, 120_000)
    const body = await response.text()
    if (!response.ok) {
      // ComfyUI returns the offending node here; surfacing it is the difference
      // between "it broke" and "node 7 has no such model".
      let detail = body.slice(0, 1200)
      try {
        const parsed = JSON.parse(body)
        if (parsed?.node_errors && Object.keys(parsed.node_errors).length) {
          detail = JSON.stringify(parsed.node_errors).slice(0, 1200)
        } else if (parsed?.error) {
          detail = JSON.stringify(parsed.error).slice(0, 1200)
        }
      } catch {}
      throw failure('ComfyUI rejected the workflow', detail)
    }
    const parsed = JSON.parse(body)
    if (parsed?.node_errors && Object.keys(parsed.node_errors).length) {
      throw failure('ComfyUI rejected the workflow', JSON.stringify(parsed.node_errors).slice(0, 1200))
    }
    return parsed.prompt_id
  }

  async function queueState (promptId) {
    const data = await asJson(await request(`${baseUrl}/queue`, {}, 30_000), 'read queue')
    const running = (data.queue_running || []).find(row => row?.[1] === promptId)
    if (running) return { state: 'running' }
    const index = (data.queue_pending || []).findIndex(row => row?.[1] === promptId)
    if (index >= 0) return { state: 'pending', position: index + 1 }
    return { state: 'unknown' }
  }

  async function waitFor (promptId, timeoutSeconds) {
    const deadline = Date.now() + Math.max(5, timeoutSeconds) * 1000
    for (;;) {
      const entry = await getHistory(promptId)
      if (entry) {
        const status = entry.status || {}
        if (status.status_str === 'error' || status.status_str === 'failed') {
          throw failure('ComfyUI job failed', JSON.stringify(status.messages || status).slice(0, 1200))
        }
        if (status.completed === true || status.status_str === 'success' || entry.outputs) {
          return entry
        }
      }
      if (Date.now() > deadline) {
        const state = await queueState(promptId).catch(() => ({ state: 'unknown' }))
        const where = state.state === 'pending' ? `队列第 ${state.position} 位` : '仍在推理中'
        throw failure(
          '等待超时',
          `job ${promptId} 还没有完成（${where}）。可以用 comfyui_wait 继续等待，或 comfyui_cancel 取消。`
        )
      }
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
  }

  /** Every generated artifact, downloaded through /view into the workspace. */
  async function collect (entry, promptId) {
    const files = []
    for (const [nodeId, output] of Object.entries(entry.outputs || {})) {
      const rows = [
        ...(output.images || []).map(row => ({ ...row, kind: row.filename.endsWith('.mp4') || row.filename.endsWith('.webm') ? 'video' : 'image' })),
        ...(output.gifs || []).map(row => ({ ...row, kind: 'video' })),
        ...(output.videos || []).map(row => ({ ...row, kind: 'video' })),
      ]
      for (const row of rows) {
        const query = new URLSearchParams({
          filename: row.filename,
          subfolder: row.subfolder || '',
          type: row.type || 'output',
        })
        const url = `${baseUrl}/view?${query}`
        const response = await request(url, {}, 120_000)
        if (!response.ok) continue
        const buffer = Buffer.from(await response.arrayBuffer())
        const stem = `${new Date().toISOString().replace(/[:.]/g, '-')}_${path.basename(row.filename)}`
        let saved = null
        if (outputDir) {
          await mkdir(outputDir, { recursive: true })
          saved = path.join(outputDir, stem)
          await writeFile(saved, buffer)
        }
        files.push({
          kind: row.kind,
          filename: row.filename,
          path: saved,
          url,
          node: nodeId,
          bytes: buffer.length,
        })
      }
    }
    if (!files.length) {
      throw failure('任务完成但没有输出文件', `job ${promptId} 的 outputs 为空，检查工作流末尾的保存节点。`)
    }
    return files
  }

  async function upload (filePath) {
    const abs = path.resolve(filePath)
    const info = await stat(abs).catch(() => null)
    if (!info?.isFile()) throw failure('找不到参考图', abs)
    const buffer = await readFile(abs)
    const form = new FormData()
    form.append('image', new Blob([buffer], { type: 'image/png' }), path.basename(abs))
    form.append('type', 'input')
    form.append('overwrite', 'true')
    const response = await request(`${baseUrl}/upload/image`, { method: 'POST', body: form }, 120_000)
    const data = await asJson(response, '上传参考图')
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name
  }

  // ------------------------------------------------------------------ graphs

  function imageGraph (args) {
    const width = snap(args.width ?? image.width, 8, image.width)
    const height = snap(args.height ?? image.height, 8, image.height)
    const graph = {
      1: { class_type: 'UNETLoader', inputs: { unet_name: image.unet, weight_dtype: 'default' } },
      2: { class_type: 'CLIPLoader', inputs: { clip_name: image.clip, type: 'qwen_image' } },
      3: { class_type: 'VAELoader', inputs: { vae_name: image.vae } },
      4: {
        class_type: 'TextEncodeQwenImage21',
        inputs: {
          clip: ['2', 0],
          prompt: String(args.prompt || ''),
          negative_prompt: String(args.negative_prompt || ''),
          resolution: clamp(args.resolution ?? image.resolution, 0, 4096, image.resolution),
        },
      },
      5: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
      6: {
        class_type: 'KSampler',
        inputs: {
          model: ['1', 0],
          seed: Number.isFinite(Number(args.seed)) ? Math.abs(Math.trunc(Number(args.seed))) : randomSeed(),
          steps: clamp(args.steps ?? image.steps, 1, 200, image.steps),
          cfg: Number(args.cfg ?? image.cfg),
          sampler_name: String(args.sampler || image.sampler),
          scheduler: String(args.scheduler || image.scheduler),
          positive: ['4', 0],
          negative: ['4', 1],
          latent_image: ['5', 0],
          denoise: 1,
        },
      },
      7: { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['3', 0] } },
      8: {
        class_type: 'SaveImage',
        inputs: { images: ['7', 0], filename_prefix: String(args.filename_prefix || 'dsh/image') },
      },
    }
    return { graph, width, height, seed: graph[6].inputs.seed }
  }

  function videoGraph (args, uploadedName) {
    const width = snap(args.width ?? video.width, 32, video.width)
    const height = snap(args.height ?? video.height, 32, video.height)
    const fps = clamp(args.fps ?? video.fps, 1, 60, video.fps)
    const length = args.frames
      ? Math.max(5, Math.trunc(Number(args.frames)))
      : framesForSeconds(args.seconds ?? video.seconds, fps)
    const turbo = args.turbo === undefined ? video.turbo : args.turbo === true
    const steps = clamp(
      args.steps ?? (turbo ? video.turboSteps : video.fullSteps),
      1,
      100,
      turbo ? video.turboSteps : video.fullSteps
    )
    const seed = Number.isFinite(Number(args.seed)) ? Math.abs(Math.trunc(Number(args.seed))) : randomSeed()

    const graph = {
      1: { class_type: 'UNETLoader', inputs: { unet_name: video.unet, weight_dtype: 'default' } },
      3: { class_type: 'CLIPLoader', inputs: { clip_name: video.clip, type: 'minimax' } },
      4: { class_type: 'VAELoader', inputs: { vae_name: video.videoVae } },
      5: { class_type: 'VAELoader', inputs: { vae_name: video.audioVae } },
      7: {
        class_type: 'MiniMaxH3ImageToVideo',
        inputs: {
          clip: ['3', 0],
          vae: ['4', 0],
          prompt: String(args.prompt || ''),
          width,
          height,
          length,
        },
      },
      8: { class_type: 'BasicScheduler', inputs: { model: ['2', 0], scheduler: video.scheduler, steps, denoise: 1 } },
      9: { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
      10: { class_type: 'KSamplerSelect', inputs: { sampler_name: String(args.sampler || video.sampler) } },
      11: { class_type: 'BasicGuider', inputs: { model: ['2', 0], conditioning: ['7', 0] } },
      12: {
        class_type: 'SamplerCustomAdvanced',
        inputs: { noise: ['9', 0], guider: ['11', 0], sampler: ['10', 0], sigmas: ['8', 0], latent_image: ['7', 1] },
      },
      13: { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['4', 0] } },
      14: { class_type: 'VAEDecodeAudio', inputs: { samples: ['12', 0], vae: ['5', 0] } },
      15: { class_type: 'CreateVideo', inputs: { images: ['13', 0], fps, audio: ['14', 0] } },
      16: {
        class_type: 'SaveVideo',
        inputs: { video: ['15', 0], filename_prefix: String(args.filename_prefix || 'video/dsh'), format: 'auto' },
      },
    }
    // The turbo LoRA is what makes 8 steps usable; without it the model needs ~20.
    graph[2] = turbo
      ? { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: video.lora, strength_model: Number(args.lora_strength ?? 1) } }
      : { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: video.lora, strength_model: 0 } }
    if (uploadedName) {
      graph[6] = { class_type: 'LoadImage', inputs: { image: uploadedName, upload: 'image' } }
      graph[7].inputs.first_frame = ['6', 0]
    }
    return { graph, width, height, length, fps, seed, steps, turbo }
  }

  // ------------------------------------------------------------------- tools

  const renderFiles = (files) => files.map(file =>
    file.path ? `- ${file.kind}：${file.path}` : `- ${file.kind}：${file.url}`
  ).join('\n')

  ctx.tools.register(defineTool({
    name: 'comfyui_status',
    description:
      '检查本地 ComfyUI 服务是否在线，列出已安装的模型，并查看当前队列。' +
      '在用户说"生图/生视频"之前先调用它确认服务在线，或者在生成失败后用它判断是服务没开、模型缺失还是队列卡住。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async () => {
      const stats = await asJson(await request(`${baseUrl}/system_stats`, {}, 15_000), '连接 ComfyUI')
      const queue = await asJson(await request(`${baseUrl}/queue`, {}, 15_000), '读取队列')
      const info = await asJson(await request(`${baseUrl}/object_info/UNETLoader`, {}, 30_000), '读取模型清单')
      const unets = info?.UNETLoader?.input?.required?.unet_name?.[0] || []
      // VRAM lives per device; /system_stats carries no top-level total.
      const device = (stats.devices || [])[0] || {}
      const gb = (value) => (Number.isFinite(Number(value)) ? `${(Number(value) / 1024 ** 3).toFixed(1)} GB` : '未知')
      const rows = [
        `服务：${baseUrl} 在线（ComfyUI ${stats.system?.comfyui_version || '?'}）`,
        `设备：${device.name || device.type || '未知'}`,
        `显存：${gb(device.vram_free)} 空闲 / ${gb(device.vram_total)} 总；内存：${gb(stats.system?.ram_free)} 空闲 / ${gb(stats.system?.ram_total)} 总`,
        `队列：运行 ${(queue.queue_running || []).length}，等待 ${(queue.queue_pending || []).length}`,
        `diffusion 模型：${unets.join('、') || '无'}`,
      ]
      return { text: rows.join('\n'), baseUrl, unets }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'comfyui_image',
    description:
      '用本地 ComfyUI 的 Qwen-Image 2.1 生成图片（文生图）。给一句中文画面描述即可，会自动等待出图并下载到工作区，' +
      '返回可直接给用户看的本地文件路径。默认 1024x1024、25 步，单张约 30-60 秒。' +
      '用户要"画一张/生成图片/出图"时用它；要改风格或构图就调整 prompt 再调用，要换比例就改 width/height。',
    parameters: {
      prompt: { type: 'string', required: true, description: '画面描述，中文或英文都可以，细节越多越好。' },
      negative_prompt: { type: 'string', description: '不想出现的元素，默认空。' },
      width: { type: 'number', description: '宽度（像素，8 的倍数），默认 1024。' },
      height: { type: 'number', description: '高度（像素，8 的倍数），默认 1024。' },
      steps: { type: 'number', description: '采样步数，默认 25，画质优先可到 40。' },
      cfg: { type: 'number', description: '提示词强度，默认 1（Qwen-Image 2.1 低 CFG 才正常）。' },
      seed: { type: 'number', description: '随机种子；想复现同一张图就传上次返回的 seed，不传自动随机。' },
      resolution: { type: 'number', description: '文本编码器看到的参考分辨率，默认 1024。' },
      filename_prefix: { type: 'string', description: 'ComfyUI 侧文件名前缀，默认 dsh/image。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 900_000,
    execute: async (args) => {
      if (!String(args.prompt || '').trim()) throw failure('缺少 prompt', '请给一句画面描述。')
      await ensureServer()
      const built = imageGraph(args)
      const started = Date.now()
      const promptId = await submit(built.graph)
      const entry = await waitFor(promptId, Number(args.wait_timeout_seconds) || defaultWait)
      const files = await collect(entry, promptId)
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      return {
        promptId,
        seconds: Number(seconds),
        seed: built.seed,
        width: built.width,
        height: built.height,
        files,
        text: [
          `出图完成（${seconds}s，${built.width}x${built.height}，seed ${built.seed}）`,
          renderFiles(files),
        ].join('\n'),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'comfyui_video',
    description:
      '用本地 ComfyUI 的 MiniMax-H3 生成带音频的视频：给一张首帧图（image_path）加一段运镜/动作描述即可做图生视频；' +
      '不传 image_path 就是纯文本生成视频。默认 1344x768、5 秒、turbo 8 步，8GB 显存下约 5-10 分钟。' +
      '本工具只负责提交并返回 prompt_id；wait_seconds 大于 0 时会同步等待（最多这么久）。' +
      '用户说"生成视频/让这张图动起来/来段某某视频"时用它。',
    parameters: {
      prompt: { type: 'string', required: true, description: '视频内容描述：主体动作、镜头运动、氛围、声音。' },
      image_path: { type: 'string', description: '首帧图片的本地绝对路径（也可以先用 comfyui_image 生成一张再传它的 path）。' },
      width: { type: 'number', description: '宽度（像素，32 的倍数），默认 1344。' },
      height: { type: 'number', description: '高度（像素，32 的倍数），默认 768。' },
      seconds: { type: 'number', description: '时长（秒），默认 5，会换算成模型的 17k+5 帧网格。' },
      frames: { type: 'number', description: '直接指定帧数（24fps），优先于 seconds。' },
      fps: { type: 'number', description: '帧率，默认 24。' },
      turbo: { type: 'boolean', description: '是否用 8 步 turbo LoRA，默认 true；false 走 20 步全质量（更慢）。' },
      steps: { type: 'number', description: '采样步数，默认 turbo 8 / 非 turbo 20。' },
      seed: { type: 'number', description: '随机种子，不传随机。' },
      lora_strength: { type: 'number', description: 'turbo LoRA 强度，默认 1。' },
      wait_seconds: { type: 'number', description: '提交后同步等待的秒数，默认 0（立即返回）；小分辨率试跑可以给 300。' },
      filename_prefix: { type: 'string', description: 'ComfyUI 侧文件名前缀，默认 video/dsh。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 1_800_000,
    execute: async (args) => {
      if (!String(args.prompt || '').trim()) throw failure('缺少 prompt', '请给一段视频描述（或一个首帧图加动作描述）。')
      await ensureServer()
      let uploaded = null
      if (args.image_path) uploaded = await upload(args.image_path)
      const built = videoGraph(args, uploaded)
      const promptId = await submit(built.graph)
      const head = [
        `已提交视频任务：${promptId}`,
        `${built.width}x${built.height}，${built.length} 帧 / ${built.fps}fps ≈ ${(built.length / built.fps).toFixed(1)} 秒，${built.steps} 步${built.turbo ? '（turbo）' : ''}，seed ${built.seed}`,
        uploaded ? `首帧：${uploaded}` : '纯文本生成（无首帧）',
      ].join('\n')

      const waitSeconds = Number(args.wait_seconds) || 0
      if (waitSeconds <= 0) {
        return {
          promptId, submitted: true, width: built.width, height: built.height,
          frames: built.length, seed: built.seed,
          text: `${head}\n下一步：用 comfyui_wait 传这个 prompt_id 等待完成（8GB 显存下 5 秒 768p 约 2 分钟，1344x768 约 5-10 分钟）。`,
        }
      }
      const started = Date.now()
      const entry = await waitFor(promptId, waitSeconds)
      const files = await collect(entry, promptId)
      return {
        promptId, submitted: true, files,
        seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
        text: `${head}\n完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s\n${renderFiles(files)}`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'comfyui_wait',
    description:
      '等待一个已提交的 ComfyUI 任务（comfyui_video 返回的 prompt_id）完成，完成后把视频/图片下载到工作区并返回本地路径。' +
      '单次最多等 timeout_seconds（默认 600 秒，最大 1800）；超时会告诉你任务还在不在队列里，可以再调用一次继续等。',
    parameters: {
      prompt_id: { type: 'string', required: true, description: 'comfyui_video 返回的 prompt_id。' },
      timeout_seconds: { type: 'number', description: '本次最多等多久，默认 600，最大 1800。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 1_900_000,
    execute: async (args) => {
      const promptId = String(args.prompt_id || '').trim()
      if (!promptId) throw failure('缺少 prompt_id', '传 comfyui_video 返回的 prompt_id。')
      const timeout = clamp(args.timeout_seconds ?? 600, 5, 1800, 600)
      const started = Date.now()
      const entry = await waitFor(promptId, timeout)
      const files = await collect(entry, promptId)
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      return {
        promptId, files, seconds: Number(seconds),
        text: `任务 ${promptId} 完成（本次等待 ${seconds}s）\n${renderFiles(files)}`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'comfyui_cancel',
    description:
      '中断本地 ComfyUI 当前正在跑的任务（或从队列里删掉一个等待中的任务）。用户说"停下/别生成了/取消"时用它。',
    parameters: {
      prompt_id: { type: 'string', description: '要取消的 prompt_id；省略则中断当前运行中的任务。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args) => {
      if (args.prompt_id) {
        await request(`${baseUrl}/queue`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ delete: [String(args.prompt_id)] }),
        }, 30_000)
        return { text: `已从队列删除 ${args.prompt_id}（如果它已经在跑，再调一次不带 prompt_id 来中断）。` }
      }
      await request(`${baseUrl}/interrupt`, { method: 'POST' }, 30_000)
      return { text: '已中断当前运行中的任务。' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'comfyui_recent',
    description: '列出最近生成并已下载到工作区的图片/视频文件，用于"把上一张再改改/给我看看刚才那个"这类追问。',
    parameters: {
      limit: { type: 'number', description: '列多少个，默认 10。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args) => {
      if (!outputDir) return { text: '未配置 outputDir，无法列出历史文件。', files: [] }
      const limit = clamp(args.limit ?? 10, 1, 50, 10)
      const names = await readdir(outputDir).catch(() => [])
      const rows = []
      for (const name of names) {
        const abs = path.join(outputDir, name)
        const info = await stat(abs).catch(() => null)
        if (info?.isFile()) rows.push({ name, path: abs, mtime: info.mtimeMs, bytes: info.size })
      }
      rows.sort((a, b) => b.mtime - a.mtime)
      const files = rows.slice(0, limit)
      return {
        files,
        text: files.length
          ? files.map(file => `- ${file.path}`).join('\n')
          : `目录 ${outputDir} 里还没有生成文件。`,
      }
    },
  }))
}

/**
 * Live diagnostics: the loader gives a plugin no friendlier failure channel than
 * "the tool silently is not there", so every apply() records one line — success
 * or the full stack — into `<outputDir>/_dsh-comfyui-load.log`. Cheap, and it
 * turns the next restart into an answer instead of a guess.
 */
function loadNote (config, line) {
  try {
    const dir = (config && config.outputDir) || path.join(os.tmpdir(), 'dsh-comfyui')
    mkdir(dir, { recursive: true }).then(() =>
      appendFile(path.join(dir, '_dsh-comfyui-load.log'), `${new Date().toISOString()} ${line}\n`),
    ).catch(() => {})
  } catch {}
}

export async function apply (ctx, config = {}) {
  loadNote(config, `apply start pid=${process.pid}`)
  try {
    const value = applyInner(ctx, config)
    if (value && typeof value.then === 'function') await value
    loadNote(config, `apply ok tools=${ctx.tools?.names?.()?.length ?? '?'}`)
    return value
  } catch (err) {
    loadNote(config, `apply FAILED ${err && err.stack ? err.stack : String(err)}`)
    throw err
  }
}

loadNote(null, 'module imported')
