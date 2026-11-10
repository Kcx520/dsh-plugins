# pause-resume

一键暂停 / 断点续跑：[DeepSeek Harness][dsh] 里点一个按钮，agent 先把进度写进断点文件再停手；
下次（哪怕重启过）从断点接着做，不用从头再来。

## 它做了什么

- **点「暂停」**：给正在跑的 agent 注入一条 steering（下一步就生效），让它把进度写进
  工作区的 `.dsh-progress.md`，然后结束这一回合。
- **暂停期间**：systemPrompt 里一直挂着「别开工」的提示，agent 不会自己接着干。
- **点「继续」**（或直接发一句「继续」）：清掉暂停标记，把断点文件内容作为上下文送回去，
  从断点继续。
- **重启 DSH**：暂停状态记在 `.dsh-pause.json` 里（含 sessionId），同一个会话重新打开
  仍然显示「继续上次任务」。

## 安装

```bash
# 1. profile 的 package.json 里加本地依赖（路径换成你放这个目录的位置）
#    "@local/dsh-pause-resume": "link:C:/path/to/dsh-plugins/pause-resume"

# 2. 生成 node_modules 链接（不做这步插件加载不到，表现为接口 404）
pnpm install --dir ~/.dsh/profiles/<profile>

# 3. 重启 DSH
```

客户端按钮由 `client.js` 提供（`dsh.client.platform = web`），安装后界面右上角出现
暂停/继续按钮。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 关闭插件 |
| `progressFile` | `.dsh-progress.md` | 断点文件（相对工作区） |
| `stateFile` | `.dsh-pause.json` | 暂停状态文件（相对工作区） |

## 排查

加载过程会写进 `~/.dsh/pause-resume-boot.log`，插件没生效时先看这个文件。

## 许可

MIT License，见 [LICENSE](../LICENSE)。

[dsh]: https://github.com/deepseek-ai
