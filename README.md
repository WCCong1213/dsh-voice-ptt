# @wccong1213/dsh-voice-ptt

按住空格说话，松开自动转写并发送。DeepSeek Harness 输入框的本地语音输入插件。

## 它做什么

- **按住空格说话**：输入框聚焦时按住 `Space` 开始录音，松开后转写并直接发送。
- **点图标也行**：点一下开始录音，再点一下转写发送（触屏或无键盘时用）。
- **绿色表示在录音**：图标平时灰色；本插件或官方麦克风录音时变绿脉动；识别中变蓝。
- **Esc 取消**：录音中按 `Esc`，不插入、不发送。
- **口水词清理**：去掉「嗯 / 呃 / 就是说 / 对对对」这类语气词，并闭合 SenseVoice 分词留下的中文间空格。
- **全程本地识别**：音频不出本机，不需要任何 API Key。

## 触发规则（豆包式）

| 输入框内容 | 按住空格 |
| --- | --- |
| 空 | 开始录音 |
| 只有引用（`> …` 的 Markdown 引用块） | 开始录音 |
| 引用 + 你手打的字 | 普通空格，正常打字 |
| 只有你手打的字 | 普通空格，正常打字 |

判断依据：剥掉所有以 `>` 开头的引用行后，若仍剩下文字，就视为「手打的文字」，空格归还给输入框。引用和路径都算「不是手打的」，可以继续用语音。

## 前置条件

1. DSH ≥ 0.2.0-rc.2（桌面版 0.2.2-rc.5 已验证）。
2. 在「插件 → 实验性插件」里启用「语音输入」，首次按引导下载模型（约 239 MB，一次即可）。
3. 允许应用使用麦克风。

模型没准备好时，本插件的图标会自动恢复显示官方麦克风，那是下载模型的入口。

## 安装

### 桌面版（插件管理页）

「插件 → 添加插件」里填：

```
@wccong1213/dsh-voice-ptt
```

或从 GitHub：

```
github:WCCong1213/dsh-voice-ptt
```

### 命令行

```bash
dsh plugin --profile web add @wccong1213/dsh-voice-ptt
```

### 本地开发

```bash
dsh plugin --profile web add "F:/path/to/dsh-voice-ptt"
```

## 设置

存在浏览器 `localStorage`（键 `dsh-voice-ptt.settings.v1`）：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `autoSend` | `true` | 转写后自动发送；`false` 只插入文字 |
| `fillerCleanup` | `true` | 清理口水词与中文间空格 |
| `spaceEnabled` | `true` | 空格热键总开关 |

```js
localStorage.setItem('dsh-voice-ptt.settings.v1', JSON.stringify({ autoSend: false, fillerCleanup: true, spaceEnabled: true }));
window.dispatchEvent(new Event('dsh-voice-ptt:settings'));
```

## 实现要点

浏览器录音 → 16 kHz 单声道 PCM16 WAV → `POST /dsh-voice-ptt/transcribe` → 宿主用 `speechToText` 服务识别 → 清理 → `inputActions.insertText()` → 可选 `inputActions.submit()`。

**不经过客户端 Remote 命名空间**（`ctx.remote.speech`）。原因：该命名空间由官方语音 UI 挂载，其实现依赖 `ctx.remote.$stream()`，而 `$stream` 在桌面版（`interactions: 'none'`）会直接抛错，命名空间因此可能永远不出现——官方麦克风按钮在那种情况下也会一直显示「未就绪」。本插件改由宿主路由直连宿主自己的 `speechToText` 服务，绕开这一层。

宿主路由只接受回环地址，并校验 `Origin`（同源或桌面端的 `dsh-app://app`），跨站请求返回 403。

## 目录

```
lib/index.js       宿主：/transcribe /status /alive 三条路由，直连 speechToText
lib/client.js      浏览器：录音、WAV 编码、空格处理、图标、提示
cordis.patch.yml   bundle 挂载声明
icon.svg
test/client-harness.mjs   jsdom + 真 React 状态机测试（44 项）
test/make-wav.mjs         生成测试用 WAV
```

## 测试

```bash
node test/client-harness.mjs [client.js] [jsdom/react 所在 node_modules]
```

预期 `44/44 checks passed`。

端到端（需要宿主在跑）：

```bash
node test/make-wav.mjs probe.wav 1 0
# 把 probe.wav 的 base64 POST 到 /dsh-voice-ptt/transcribe，应返回 {"ok":true,"text":""}
```

## 已知限制

- 空格热键只在输入框聚焦时生效。
- 识别是整段转写，不是边说边出字。
- 口水词规则针对中文；英文 um/uh 未处理。
- 图标位置在模型选择器左侧：`conversation.input.right` 插槽不能跨到右侧的 `conversation.input.activity`，强行搬移 DOM 会破坏 React 渲染（曾导致输入框消失）。

## 许可

MIT
