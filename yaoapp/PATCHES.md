# Yao 对 DSH 上游的补丁记录

本文档记录我们 fork 中对 DSH 上游代码所做的修改，包括原因、根因分析和修复方案。

---

## PATCH-001: ~~修复代理网关 tool_calls 流式响应中 null 字段导致工具名称丢失~~

- **状态**: ✅ 已废弃（上游 0.1.7-rc.2 已修复）
- **原因**: 上游将 LLM 协议从 OpenAI chat completions 改为 Anthropic Messages 格式，`content_block_start` 一次性给出完整 tool identity，后续 delta 不再重发 id/name，根本性消除了 null 覆盖问题。使用 `dsh-llm-pi-ai` 连接三方时走独立代码路径（pi-ai SDK 结构化事件），同样不受影响。

---

## 当前活跃补丁

### PATCH-002: SEA VFS 路径下 migration-verifier Worker 创建失败

- **文件**: `packages/session/session-persistence-jsonl/src/migration-verifier.ts` (+6 行 FIXME)
- **上游版本**: 0.1.7-rc.2
- **状态**: 待修复

`migration-verifier.ts` 使用 `new Worker(new URL(..., import.meta.url))` 创建 worker，
但在 SEA 环境下 `import.meta.url` 指向 VFS 路径（`/snapshot/...`），Node.js Worker
无法从 VFS 加载脚本。当前用 FIXME 注释标记，SEA 构建时需要将 worker 脚本提取到临时文件。
