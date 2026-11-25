# 实测记录：Antigravity CLI（`agy`）的边界

以下数据全部来自 2026-11 在 Ubuntu 22.04 / 2 vCPU / 1.9GB 上的实测，CLI 版本 1.5.16 ~ 1.5.17。
它们构成了本项目设计的依据，也纠正了几个常见的想当然假设。

## 1. 单轮输入上限是 192,000 字节，而不是模型窗口

| 输入大小 | 结果 |
|---|---|
| 100 KB | ✅ 完整收到 |
| 180 KB | ✅ 完整收到（模型明确回答"未截断"） |
| 200 KB | ⏱ 不是上限，只是慢 |
| 400 KB | ❌ 在 **192,000 字节**处截断，尾注 `<truncated 218028 bytes>` |

中文 UTF-8 占 3 字节，所以：

```
192,000 B ÷ 3 ≈ 64,000 中文字
```

而模型本身的窗口是 1M token 量级（约 75 万中文字）。**瓶颈在 CLI 的入参，不在模型。**

## 2. 会话可以累积，且能跨模型

```
轮 1：埋入暗号「BLUE-WHALE-7391」+ 51KB 填充
轮 2：再灌 48KB 无关内容
轮 3：问"我第一条消息里的暗号是什么"
      → BLUE-WHALE-7391        ✅
轮 4：--model 换成另一个模型，再问同一问题
      → BLUE-WHALE-7391        ✅（换模型不丢记忆）
```

结论：`--conversation` 的历史由 CLI 持有，**每轮只发增量即可**。

## 3. 文件工具在默认权限下可用，shell 工具自动拒绝

| 模式 | 结果 |
|---|---|
| 默认权限 + `--add-dir <dir>` | ✅ `write_to_file` 成功写下文件 |
| `--mode accept-edits` | ❌ 模型改用 shell 命令 → 无头模式无法弹权限框 → 自动拒绝并报错 |

报错原文会提示：

> a tool required the "command" permission that headless mode cannot prompt for,
> so it was auto-denied. Add an allow-rule under permissions.allow in settings.json

**这刚好是我们想要的安全边界**：能给模型一个可写目录，但 shell 默认关闭。

## 4. 不存在的 conversation id 不会报错

```
$ agy --conversation 00000000-0000-0000-0000-000000000000 -p "ping"
warning: conversation "00000000-0000-0000-0000-000000000000" not found
Pong! How can I help you today?
```

它会**打印一条 warning，然后静默新建会话**并正常回答。

对桥接的含义：**不能靠退出码判断会话是否失效**，必须匹配这条 warning，并注意此时返回的 `conversation_id` 已经变了。

## 5. 会话存储位置

```
~/.gemini/antigravity-cli/brain/<convId>/
  └─ .system_generated/logs/chunks/
       ├─ transcript/00000000.jsonl
       └─ transcript_full/00000000.jsonl, 00000001.jsonl, ...
```

健康检查应看这个目录是否存在且非空；不要假设是单个 `transcript.jsonl`。

## 6. 资源占用

| 项目 | 实测 |
|---|---|
| 单轮 `agy` RSS 峰值 | **≈ 305 MB** |
| 1.9GB 内存下并发 2 轮 | 会逼近上限，不建议 |
| 渲染 457 中文字 | ≈ 14 秒（`gemini-4-argon-low`） |
| 渲染 5,295 中文字 | ≈ 220 秒（`claude-sonnet-5-5-high` + 深度执行预设） |

## 7. 额度：按模型分池

同一账号下，不同模型的额度互相独立。实测某次：

| 模型 | 状态 |
|---|---|
| `gemini-4-argon-high` / `medium` | ✅ 可用 |
| `gemini-pro-orchestrator-*` | ✅ 可用 |
| `gemini-4-hydrogen-*` | ❌ 133h 后重置 |
| `gemini-3.8-flash-*` | ❌ 133h 后重置 |
| `claude-*` / `gpt-oss-*` | ❌ 158h 后重置 |

查询方式（不需要额外额度）：

```bash
agy -p "/quota"
# Gemini Models  Weekly Limit Remaining  89%  2026-12-01T14:05:49Z
```

## 8. 服务端容量错误

偶发（不是额度问题）：

```
UNAVAILABLE (code 503): No capacity available for model <model> on the server
```

桥接据此做模型降级：`503 / 429 / capacity` 时按 fallback 列表换模型重试，且**只在还没吐出正文时**降级，避免半截回复拼接。

## 9. 其它

- `/context` 在 print 模式不可用（只在交互式 TUI 里有）。
- `-p` 的 prompt 走 **stdin** 更安全；走 argv 会撞 `E2BIG`（Linux 单参数上限 128KB）。
- CLI 1.5.15+ 支持 `AGY_CLI_AUTO_COMPACT_OVERRIDE=60%`；它控制的是 CLI 内部历史压缩阈值，与单轮 192KB 限制**互相独立**。
