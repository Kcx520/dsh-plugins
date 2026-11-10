# ask-always

给 [DeepSeek Harness][dsh] 的每条用户消息追加「有任何问题问我，越详细越好」的语义：
让 agent 遇到不确定的地方先问清楚，而不是自己假设完闷头做。

## 原理

不改用户的原始消息，也不污染聊天记录：插件给每个 agent 挂一条常驻的 `systemPrompt`
上下文，内容是这条叮嘱的详细解释版。所以分支、重放、历史记录都是干净的。

## 安装

```bash
# 1. profile 的 package.json 里加本地依赖（路径换成你放这个目录的位置）
#    "@local/dsh-ask-always": "link:C:/path/to/dsh-plugins/ask-always"

# 2. 生成 node_modules 链接（不做这步插件加载不到，表现为接口 404）
pnpm install --dir ~/.dsh/profiles/<profile>

# 3. 重启 DSH
```

## 配置

在 `cordis.patch.yml` 或 profile 配置里：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 关闭，不挂这条提示 |

## 许可

MIT License，见 [LICENSE](../LICENSE)。

[dsh]: https://github.com/deepseek-ai
