# dsh-comfyui

把本机 ComfyUI 接成 DeepSeek Harness 的模型工具：**一句话生图、一句话生视频（带音频）**，生成的图/视频自动下载进工作区，可以直接给用户看、可以接着改。

- 生图：Qwen-Image 2.1（`qwen_image_2.1_int8_convrot` + `qwen3vl_8b` + `qwen_image_2.1_vae_bf16`）
- 视频：MiniMax-H3（`minimax_h3_fl2va_pruned_int8_convrot` + `qwen3vl_32b_minimax_h3_nvfp4_awq` + 视频/音频 VAE + 8 步 turbo LoRA），图生视频或纯文本生视频，自带音频

服务端就是用户自己开着的 ComfyUI（默认 `http://127.0.0.1:8188`），不需要 API key。

## 工具

| 工具 | 作用 |
| --- | --- |
| `comfyui_status` | 服务是否在线、显卡/显存、队列、已装模型 |
| `comfyui_image` | Qwen-Image 2.1 文生图，等出图并下载到 `outputDir`，返回本地路径 + seed |
| `comfyui_video` | 提交 MiniMax-H3 视频任务（`image_path` 传首帧就是图生视频，不传就是文生视频），返回 `prompt_id` |
| `comfyui_wait` | 等某个 `prompt_id` 完成并下载产物，可反复调用继续等 |
| `comfyui_cancel` | 中断/删除任务 |
| `comfyui_recent` | 列出最近生成的文件 |

设计取舍：

- 视频动辄 5-10 分钟，`comfyui_video` 只提交、立刻返回 `prompt_id`，再用 `comfyui_wait` 等——这样不会把一整轮对话卡死在一个长请求里。
- 产物通过 ComfyUI 的 `/view` 接口下载到 `outputDir`，插件不需要知道服务端的输出目录在哪。
- 模型文件名、默认分辨率、步数全都写在 `cordis.patch.yml`，改配置不用碰代码。

## 安装（桌面版 profile）

`~/.dsh/profiles/desktop/package.json`：

```json
{
  "dependencies": {
    "dsh-comfyui": "link:C:/Users/kcx2008/Documents/deepseek-harness/default-workspace/dsh-comfyui"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-comfyui"]
    }
  }
}
```

然后重启 DeepSeek Harness（插件层只在启动时加载，刷新页面不够）。

## 配置

见 `cordis.patch.yml`：`baseUrl`、`outputDir`、`image.*`、`video.*`、`waitTimeoutSeconds`。

## 命令行兜底（不依赖插件加载器）

`cli.mjs` 用同一份 `index.js` 里的工具实现，绕开 DSH 的 bundle 装载：把对
`@deepseek-ai/dsh-tools` 的 import 换成本地 shim 后直接调用工具的 `execute`。
插件没被挂上时，agent 走这条路一样能出图/出视频：

```powershell
cd C:\Users\kcx2008\Documents\deepseek-harness\default-workspace\dsh-comfyui
node cli.mjs status
node cli.mjs image --prompt "a red apple" --width 1024 --height 1024 --steps 30
node cli.mjs video --prompt "slow push in" --image <首帧.png> --seconds 2
node cli.mjs recent
```

生成物落在 `..\comfyui-output\`。

## 装载状态（2026-10-20）

插件已装进 `~/.dsh/profiles/desktop`（依赖、bundle 列表、pnpm lockfile 都齐了），但
DSH 启动时没有把它挂进工具表，`_dsh-comfyui-load.log` 里连 `module imported` 都没有，
说明 bundle 在更早的解析阶段就被跳过了。已把 profile 里的 `node_modules/dsh-comfyui`
从 junction 换成实体目录（与能正常加载的 `dsh-find-plugins` 同形），待下次重启验证。

## 后端自动启动

`comfyui_image` / `comfyui_video` 开跑前会先探一下 `baseUrl`；如果 8188 没人应答，就用
同一个启动脚本把它拉起来再生成（配置在 `startup.*`）：

```yaml
startup:
  enabled: true
  bat: D:\kcx2008\ComfyUI\ComfyUI_windows_portable\run_nvidia_gpu.bat
  workdir: D:\kcx2008\ComfyUI\ComfyUI_windows_portable
  timeoutSeconds: 180
```

注意这里写的是 **`.bat`，不是桌面上那个 `.lnk`**：从非交互的 spawn 里 `start "" 某.lnk`
不会真的执行（快捷方式要靠 ShellExecute 展开），指向同一个 `.bat` 才有效。
桌面快捷方式 `run_nvidia_gpu.bat.lnk` 的 TargetPath 就是这个 bat，
WorkingDirectory 也一致，所以两边启的是同一个安装。

冷启动实测：8188 关掉 → 出图调用 → 12s 后端就绪 → 22s 出图，总计 35s。

## 已知限制

- 8GB 显存：1344x768 / 124 帧（5 秒）大约 5-10 分钟；先用 576x320 / 2 秒试跑验证。
- 首次调用要加载 10-20 GB 模型，第一次会比较慢。
- 同一时间只跑一个任务：8GB 上并发会 OOM。
