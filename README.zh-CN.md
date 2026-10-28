# Hibiki · 模型工作台

[English](README.md)

一个基于 [Pi](https://pi.dev) 原生扩展 API 的第三方插件：选择模型、管理自定义供应商／模型，并调整当前会话的 Fast 请求策略。界面以中文为主。

## 安装

使用 Pi 安装：

```sh
pi install git:github.com/theseussss/pi-hibiki
```

本地试用可用 `pi install /absolute/path/to/pi-hibiki`。安装前先看源码；新开 Pi 后运行 `/hibiki` 或 `/models` 即可，**不需要构建、快照或源码还原**。

不要与旧的独立模型选择器／Fast 扩展叠装，也不要单独加载内部 `extensions/model-pick.ts`。包只声明一个入口：`extensions/hibiki-models.ts`。

已验证的宿主环境为 Node.js 24、Pi 1.4.0；不保证所有其他版本兼容。

## 使用

- 搜索及方向键浏览矩阵，Enter 切换模型，Tab 收藏。
- Alt+N 添加，Alt+X 经确认后移除，Alt+Z 撤销仍适用的移除，Alt+D 保存默认模型，Alt+T 配色。
- Alt+M 打开当前对象的操作；`/hibiki manage`、`/hibiki providers` 进入管理动作。
- `/hibiki fast` 打开会话策略；快捷命令为 `/fast [on|off|ultrafast|status|check]`。

Ctrl+L 与 Pi 原生选择器冲突。如需交给 Hibiki，将 `"app.model.select": []` 合并进现有 Pi `keybindings.json`，不要整份覆盖；不改快捷键也能使用命令。

Fast 仅影响已实现的 OpenAI 兼容供应商／API／模型路径，不保证加速或费用；`status`／`check` 不发送探针。Ultrafast 需在 `~/.pi/agent/pi-hibiki.json` 显式启用，默认关闭：

```json
{ "fast": { "enableUltrafast": false } }
```

## 重要限制

- **受保护的管理写入依赖 Windows DPAPI，已在 WSL 验证。** Linux／macOS 凭据后端尚未实现，保护不可用就拒绝相关操作，不明文降级；原生 Windows 路径未完成整套插件验收。
- 管理数据仍定位到 `HOME/.pi/agent`；换 agent directory／profile 不等于完全隔离管理写入。
- 新凭据填写环境变量名称／引用，不粘贴 API key；既有 Pi 配置与旧备份不会自动加密或迁移。
- 归档绑定 Windows 用户账户，仅复制密文不保证换机可恢复。管理配置前请做好备份。
- 上游清单／文本检查需明确确认，可能计费；小文本连通不证明完整模型规格。
- 扩展具有宿主权限，不隔离恶意同用户进程或其他扩展。

## 开发

直接修改 TypeScript 源码。先安装好 Pi 和 TypeScript，再执行：

```sh
export HIBIKI_PI_ROOT=/path/to/pi-coding-agent
export HIBIKI_TYPESCRIPT_ROOT=/path/to/typescript
npm run verify
```

全套测试使用临时合成 profile、禁止联网并保护全新合成 DPAPI 数据，目前需要 WSL＋Windows DPAPI；不使用真实凭据或调用真实供应商，不自动安装依赖，也不等于所有平台／物理输入法认证。

## 许可证

[MIT](LICENSE) · Copyright (c) 2026 Wang Jiacong (theseussss)。

感谢 Pi、pi-sakura-cyberdeck 及其 pi-zentui 上游。具体复用范围及原许可证见 [NOTICE](NOTICE.md)。
