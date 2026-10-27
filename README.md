# DSH Plugins

一组为 [DeepSeek Harness][dsh] 写的本地插件（Cordis 插件形式，host + client 双端）。

| 插件 | 作用 |
| --- | --- |
| [ask-always](./ask-always) | 给用户的每条消息追加「有任何问题问我，越详细越好」的语义：agent 遇到不确定先问，不闷头猜。 |
| [pause-resume](./pause-resume) | 一键暂停/断点续跑：把断点写进 `.dsh-progress.md`，停掉后（哪怕重启）从断点继续。 |
| [peak-guard](./peak-guard) | DeepSeek API 峰谷电价守卫：高峰价开始前自动存档并暂停，支持一个词快速覆盖。 |
| [comfyui](./comfyui) | 本地 ComfyUI 桥接：把 Qwen-Image 2.1 文生图、MiniMax-H3 图生视频注册成模型工具。 |
| [project-manager](./project-manager) | 项目与文件管理器：一个项目一个文件夹，安全的文件操作、最近工作、会话入口。 |
| [pet-bridge](./pet-bridge) | 桌宠（Desktop Pet）与 DSH 的桥接层。 |

## 安装

每个子目录都是一个独立的 Cordis 插件包，安装方式相同：

```bash
# 1. 把插件目录放到任意位置，然后在 profile 里以本地路径依赖引入
#    编辑 ~/.dsh/profiles/<profile>/package.json，在 dependencies 里加：
#    "@local/dsh-pause-resume": "link:C:/path/to/pause-resume"

# 2. 生成 node_modules 链接（必须，否则插件加载不到，表现为接口 404）
pnpm install --dir ~/.dsh/profiles/<profile>

# 3. 重启 DSH
```

插件自带的 `cordis.patch.yml` 会被 DSH 读取用于注册 host/client 两端。

## 说明

- 这些插件是给本机 DSH 用的，不是 npm 公共包；`package.json` 里 `private: true`。
- 各插件依赖的 DSH 版本不同，装之前看一眼子目录里的 `README.md`。

[dsh]: https://github.com/deepseek-ai
