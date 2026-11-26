# agy-session-bridge

> 把 **Google Antigravity CLI（`agy`）** 变成一个 SillyTavern 可用的、**有长期记忆**的 OpenAI 兼容后端。

[English summary ↓](#english)

---

## 它解决什么问题

`agy` 的 `-p`（print）模式有一个硬限制：**单轮输入约 192,000 字节**（≈ 6.4 万中文字）。  
超过会被截断，并在内容里留下 `<truncated N bytes>`。

所以如果按"每轮把完整历史塞进 prompt"的做法，长对话必然丢记忆：

```
第 1 轮  ████████
第 20 轮 ████████ → 只装得下最近 N 层
第 60 轮 ████████ → 前面全被丢掉
```

但这个项目的核心发现是：**192KB 限制的是「单次输入」，不是「会话总量」**。

`agy --conversation <id>` 会把对话累积在 CLI 自己的存储里。实测：埋一个暗号 → 灌入约 100KB 无关内容 → 追问，模型仍能准确复述。  
也就是说：**只要每轮只发"新增的那一句"，记忆就可以远超 192KB。**

这个桥接就是围绕这一点搭的。

## 架构

```
SillyTavern (:80)
     │  OpenAI /v1/chat/completions (SSE)
     ▼
agy-session-bridge (:8787, 仅回环)
     │
     ├─ session.js   会话键 / 漂移三态 / 三明治 bootstrap
     ├─ archive.js   <ta_record> 流式剥离 + 按楼层归档
     ├─ queue.js     全局并发 1 + 同聊天抢占
     ├─ agy-runner.js spawn agy、解析 NDJSON、失效检测
     └─ server.js    HTTP / SSE 入口
             │
             ▼
     agy --conversation <id>
             │
             ▼
   works/chats/<chatKey>/timeline.md   ← 归档（可跨会话复用）
```

## 三种漂移状态

酒馆里你可以 edit / swipe / 删层 / 分支，CLI 的历史不会自动跟着变。桥接会比较「已同步的楼层哈希」和当前请求：

| 场景 | 判定 | 处理 |
|---|---|---|
| 正常推进（只多一层） | `advance` | 只发最新那条 user 消息 |
| 改动最近 ≤4 层，且连续 swipe <3 次 | `shallow` | 发 `[TIMELINE OVERRIDE]` + 分叉点起的真值 |
| 回滚 >4 层 / 切分支 / 会话失效 | `deep` | 三明治 bootstrap 重建会话 |

**三明治 bootstrap**（预算 170KB）：

```
[SYSTEM]   完整 system（角色卡 + 预设）   ~31KB
[OPENING]  开场前 2 层                     ~15KB
[TIMELINE] timeline.md 归档                ~30KB
[RECENT]   从尾部往前装到预算为止           ~90KB
```

## 归档：让记忆不依赖上下文窗口

桥接会在 prompt 末尾注入一段归档指令，要求模型每轮输出：

```xml
<ta_record>时间 / 地点 / 在场人物 / 事件 / 关系变化 / 承诺 / 伏笔</ta_record>
```

桥接做的事：
1. **流式剥离**：标签可能被拆在多个 delta 里，`recordFilter()` 用 24 字节 holdback 保证不泄漏给用户；
2. **按楼层幂等落盘**：`works/chats/<key>/timeline.md`，回滚到旧层会截断更高楼层；
3. **只在 bootstrap 注入**：常态轮次不重复注入，避免同一记录在 CLI 历史里出现 N 次导致复读。

## 快速开始

### 1. 安装并登录 Antigravity CLI

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
~/.local/bin/agy models      # 会提示登录，按它给的 URL 完成授权
```

### 2. 起桥接

```bash
git clone https://github.com/<you>/agy-session-bridge.git
cd agy-session-bridge

# 依赖：只有 Node 18+，零 npm 依赖
node src/server.js
# → agy-session-bridge v5 listening on http://127.0.0.1:8787 (mode=session)
```

### 3. 酒馆里配置

```
Chat Completion Source : Custom (OpenAI-compatible)
Custom Endpoint        : http://127.0.0.1:8787/v1
Custom Model           : gemini-4-argon-high
Streaming              : 开
```

### 4. systemd（可选）

```bash
sudo cp deploy/agy-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agy-bridge
```

## 配置

全部通过环境变量，默认值见 `src/config.js`。

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGY_BRIDGE_PORT` | `8787` | 监听端口（仅回环） |
| `AGY_BIN` | `$HOME/.local/bin/agy` | CLI 路径 |
| `AGY_WORKSPACES` | `$HOME/.agy-bridge/chats` | 归档根目录 |
| `AGY_STATE_FILE` | `$HOME/.agy-bridge/sessions.json` | 会话映射 |
| `AGY_PROMPT_BUDGET` | `180000` | 单轮 prompt 字节上限，**硬钳制在 190000**。金丝雀实测：250KB 可整段送达，3.4MB 只留开头、中后段全丢。要放开须显式设 `AGY_PROMPT_HARD_CAP` |
| `AGY_MAX_CONCURRENT` | `1` | 全局并发（1 轮 agy 峰值约 305MB） |
| `AGY_COMPACT_OVERRIDE` | `85%` | 传给 CLI 的历史压缩阈值（与单轮 192KB 限制无关） |
| `AGY_MAX_TURNS_PER_SESSION` | `60` | 超过后主动轮转新会话 |
| `AGY_DEFAULT_MODEL` | `gemini-4-argon-high` | 未指定模型时的默认值 |
| `AGY_SESSION_MODE` | `1` | 设为 `0` → 退回无状态模式（旧行为） |
| `AGY_BRIDGE_TOKEN_FILE` | `$HOME/.agy-bridge/token` | 非回环访问所需的 Bearer token |

## 实测数据（供参考）

在 2 vCPU / 1.9GB 的 Ubuntu 22.04 上测得：

| 项目 | 数值 |
|---|---|
| 单轮输入硬截断 | 192,000 字节（400KB 输入被截掉 218KB） |
| 会话回忆 | ~100KB 历史之后仍能准确复述首轮暗号 |
| 单轮 agy RSS 峰值 | ≈ 305MB |
| 渲染 457 字回复 | ≈ 14 秒（`gemini-4-argon-low`） |
| 失效信号 | `warning: conversation "<id>" not found` + 静默新建会话 |
| 换模型 | 同一 conversation 换 `--model` **不丢记忆** |

## 测试

```bash
node tests/test-core.js          # 16 用例：核心逻辑
node tests/test-fixes.js         #  4 用例：并发上限、抢占语义、UTF-8 跨块解码、env 透传
node tests/test-fixes2.js        #  8 用例：会话键顺序、重复请求漂移、状态原子写
node tests/test-fixes4.js        #  8 用例：未来记忆泄漏、SIGKILL 升级、代理对、TOCTOU、msg.name
node tests/test-audit-fixes.js   #  5 用例：审计回归
node tests/test-audit-fixes-v2.js#  8 用例：卷层并发、种子、分支交互
node tests/test-branch.js        #  4 用例：分支桶、LCP 选择、分叉继承
node tests/test-memory.js        #  7 用例：三层记忆、预算钳制、strict system
node tests/test-preset.js        #  4 用例：floor 切分、稳定 chatKey、override、bootstrap 提升
node tests/test-server.js        #  5 用例：stream:false、错误状态码、失败不提交、哈希 trim 对齐
```

共 **69 条**。覆盖：`recordFilter` 跨 delta 剥离、`upsertFloor` 幂等与回滚、`chatKey` 稳定性、`buildBootstrap` 预算、`driftOf` 三态、并发上限不被击穿、同角色卡双存档不串档、断连中止。

## 已知限制

- **非官方用法**：这是驱动官方 CLI，不是官方 API。请自行评估账号风险，别用于批量抓取或高并发。
- **额度按模型分池**：不同模型有独立的周额度/5 小时额度，某池耗尽就换池。
- **服务端容量**：偶发 `UNAVAILABLE (503) No capacity`，桥接会自动降级到 fallback 模型。
- **归档需要模型配合**：模型偶尔漏输出 `<ta_record>`，该轮就不会进归档。
- **编辑历史**：`shallow` 模式只能"局部纠正"，CLI 里作废的旧回复仍存在，连续改写超过 3 次会触发重建。

## 开发方式

这个项目的实现代码由 **Gemini 4 Argon High**（通过它自己要桥接的 `agy`）编写，人类负责：

- 写接口契约（`SPEC`）与验收测试
- 实测 CLI 行为，纠正模型对运行环境的错误假设
- 定位并回传 bug（例如 `chatKey` 在第 1/2 轮间不稳定导致会话每轮重建）

一次典型的协作循环：**规格 → 模型写码 → 单测/集成测试 → 反馈 bug → 模型修**。

## License

MIT

---

<a id="english"></a>
## English

A local OpenAI-compatible bridge that turns Google Antigravity CLI (`agy`) into a long-memory backend for SillyTavern.

**Key idea:** `agy -p` caps a single prompt at ~192KB, but `agy --conversation <id>` accumulates history in the CLI itself. Send only the new turn, and memory is no longer bounded by the per-prompt cap.

Features: session routing per chat, drift detection (advance / shallow / deep), sandwich bootstrap, `<ta_record>` streaming filter + per-floor archive, global concurrency 1 with same-chat preemption, 503 fallback across model pools.

No npm dependencies. Node 18+. Loopback only.
