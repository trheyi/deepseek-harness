# Yao 对 DSH 上游的补丁记录

本文档记录我们 fork 中对 DSH 上游代码所做的修改，包括原因、根因分析和修复方案。

---

## PATCH-001: 修复代理网关 tool_calls 流式响应中 null 字段导致工具名称丢失

- **文件**: `packages/llm/llm-deepseek/src/translate.ts` (第 159-160 行)
- **日期**: 2026-08-17
- **上游版本**: 0.1.0-rc.7 (commit `99f6f02`)
- **状态**: 上游未修复

### 现象

通过 OpenAI 兼容代理（如 OpenCode Go、LiteLLM 等）访问 DeepSeek API 时，
所有工具调用失败，报错 `Error: unknown tool ""`。工具名称和 callId 均为空字符串。
直连 DeepSeek 官方 API (`api.deepseek.com`) 则一切正常。

### 根因

问题出在 DSH 的 `translate.ts` 中处理流式 SSE tool_calls delta 的逻辑：

```typescript
// 原版代码
if (call.id !== undefined) block.callId = call.id
if (call.function?.name !== undefined) block.name = call.function.name
```

OpenAI 流式 tool_calls 的协议约定：
- **第 1 个 chunk**: 包含 `id` 和 `name`（真实值）
- **后续 chunk**: 只包含 `arguments` 的增量片段

**DeepSeek 官方 API** 在后续 chunk 中**省略** `id` 和 `name` 字段（字段不存在 → `undefined`）：

```json
{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{"}}]}}
```

**代理网关**（如 OpenCode Go）在反序列化后重新序列化时，会把空值字段**显式输出为 `null`**：

```json
{"delta":{"tool_calls":[{"index":0,"id":null,"type":"function","function":{"name":null,"arguments":"{"}}]}}
```

在 JavaScript 中 `null !== undefined` 为 `true`，因此 DSH 会将第 1 个 chunk 中已经
正确设置的 `block.callId = "call_xxx"` 和 `block.name = "write"` **覆盖为 `null`**。
最终 `closeBlock()` 生成 `id: ""` 和 `name: ""`，导致工具查找失败。

### 修复

将严格不等式 `!== undefined` 改为宽松不等式 `!= null`，同时拦截 `null` 和 `undefined`：

```typescript
// 修复后
if (call.id != null) block.callId = call.id
if (call.function?.name != null) block.name = call.function.name
```

### 影响范围

| 场景 | 原版行为 | 修复后行为 |
|------|---------|-----------|
| DeepSeek 官方 API（字段不存在 → `undefined`） | 跳过，不覆盖 | 跳过，不覆盖（无变化） |
| 代理网关（字段为 `null`） | **覆盖为 null → bug** | 跳过，不覆盖（修复） |
| 第 1 个 chunk（真实值如 `"call_xxx"`） | 正常赋值 | 正常赋值（无变化） |

此修复**完全向后兼容**，不影响直连 DeepSeek 官方 API 的任何行为。

### 验证

使用 OpenCode Go 代理端点 (`https://opencode.ai/zen/go/v1`) + DeepSeek V4 Flash 模型，
在 DSH Web UI 中测试工具调用：

- **原版代码**: 所有工具调用报错 `Error: unknown tool ""`（已复现）
- **修复后**: 工具调用正常执行（已验证）

### 代理网关产生 null 的原因

代理网关（通常用 Go、Java 等强类型语言编写）在反序列化上游 JSON 响应时，
会将缺失字段初始化为类型零值（Go 中指针类型为 `nil`，字符串为 `""`）。
重新序列化时，如果结构体字段未标记 `omitempty`，这些零值会被输出为显式 `null`。
这在 API 代理/网关场景中是常见问题，严格来说不违反 OpenAI spec，
但会破坏下游对"字段不存在即无更新"的隐式假设。
