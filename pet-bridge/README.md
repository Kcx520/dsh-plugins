# pet-bridge

桌宠 → [DeepSeek Harness][dsh] 的桥接层：把 DSH 的 agent 生命周期事件写成**本地 jsonl 文件**，
桌宠端按字节偏移 tail 读取，从而显示「正在跑命令…」「已回复」之类的状态。

## 特点

- **纯本地写盘**：不联网、不订阅 mux、不读写控制队列。
- **零外部依赖**：这是硬性红线。profile 通过 `link:` 链接本目录，pnpm 不会安装被链接包
  自己的依赖；一旦声明运行时依赖，依赖解析失败会让 Cordis 插件树初始化抛错、DSH 起不来。
- **不落明文内容**：用户消息、模型回复、工具参数/结果一律不写盘，只写事件名、状态、
  工具名、错误码、会话/调用身份等元数据。

## 文件位置

桥目录（与桌宠端约定一致）：

| 系统 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\dsh-pet-bridge` |
| macOS | `~/Library/Application Support/dsh-pet-bridge` |
| 其他 | `~/.config/dsh-pet-bridge` |

每个 DSH 实例写自己的 `dsh-{pid}.jsonl`（多实例分区），消费端 glob `dsh*.jsonl` 即可。
单文件超过 1 MB 自动轮转，保留 `.1` 备份。

## 安装

```bash
# 1. profile 的 package.json 里加本地依赖
#    "@dsh-pet/bridge": "link:C:/path/to/dsh-plugins/pet-bridge"

# 2. 生成 node_modules 链接
pnpm install --dir ~/.dsh/profiles/<profile>

# 3. 重启 DSH
```

## 说明

本插件只负责「DSH 这一侧」。桌宠程序本体不在这个仓库里；没有桌宠时插件照样能装，
只是写出来的 jsonl 没人读。

## 许可

MIT License，见 [LICENSE](../LICENSE)。

[dsh]: https://github.com/deepseek-ai
