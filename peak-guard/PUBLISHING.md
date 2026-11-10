# 分享与上架

三种分享方式，从最傻瓜到最正式。产物都在 `share/` 里。

## 0. 先构建（改过代码后重新跑）

```powershell
node scripts/build-share.mjs
cd dist/dsh-peak-guard
npm pack --pack-destination ../../share
```

`dist/dsh-peak-guard/` 是公开包（名字 `dsh-peak-guard`），工作区里的 `@local/dsh-peak-guard` 只是本机安装用的私有名，两者内容一致。

## 1. 傻瓜式分享：发一个 tgz / zip

把 `share/dsh-peak-guard-1.0.0.tgz` 发给对方，对方执行：

```powershell
dsh plugin --profile desktop add .\dsh-peak-guard-1.0.0.tgz
```

或者把 `share/dsh-peak-guard-1.0.0.zip` 发过去，解压后运行 `install.ps1`（脚本会自己找 tgz）。
装完重启 DSH，插件出现在 设置 → 插件 里，并自动生效。

## 2. 上架 npm（插件市场主要靠这个发现）

```powershell
npm login
cd dist/dsh-peak-guard
npm publish
```

包名 `dsh-peak-guard` 在 npm 上仍可用（2026-10-20 查过）。发布后任何人：

```powershell
dsh plugin --profile desktop add dsh-peak-guard
```

npm 包里的 `keywords` 已经包含 `dsh`、`dsh-plugin`、`deepseek-harness`，DSH 市场和 `find_dsh_plugins` 会按这些关键词索引。

## 3. 上架 GitHub + 社区目录

```powershell
cd dsh-peak-guard
git init
git add -A
git commit -m "feat: dsh-peak-guard, pause before DeepSeek API peak hours"
# 先在 GitHub 建一个空仓库，再：
git remote add origin https://github.com/<你的账号>/dsh-peak-guard.git
git push -u origin main
```

- 仓库 **Topics 必须加 `dsh-plugin`**（`find_dsh_plugins` 的 GitHub 检索就是按这个 topic 走的）。
- 在仓库 About 里填 `description` 和 `homepage`。
- 社区目录都是 PR 形式收录，提交时附上：包名、仓库地址、一行说明、已验证的 DSH 版本。常见入口：
  - `awesome-dsh-plugin`（列表型）
  - `dsh-plugin-index` / `plugin-registry`（索引型）
  - dsh.works 需要提供可复现的安装路径和验证过的 dsh 版本
- 想发 Release 的话，把 `share/*.tgz` 传上去，别人可以直接下载安装。

## 发布前检查清单

- [ ] `node test/phase.test.mjs` 和 `node test/apply.test.mjs` 全绿
- [ ] `dist/dsh-peak-guard/package.json` 里 version 已递增
- [ ] `cordis.patch.yml` 的 `name` 是 `dsh-peak-guard`
- [ ] README 里的命令和实际一致
- [ ] 装到一个干净 profile 里试一遍 `/peak status`
