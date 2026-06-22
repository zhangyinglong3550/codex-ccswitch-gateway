import crypto from "node:crypto";

export function contentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (part.type === "input_text" || part.type === "output_text" || part.type === "text") return part.text || "";
      if (part.type === "reasoning_text" || part.type === "summary_text") return part.text || "";
      if (part.type === "image" || part.type === "input_image") return "[image omitted]";
      if ("content" in part) return contentToText(part.content);
      if ("output" in part) return contentToText(part.output);
      if ("text" in part) return String(part.text || "");
      return "";
    }).filter(Boolean).join("\n");
  }
  if (typeof content === "object") {
    if ("text" in content) return String(content.text || "");
    if ("content" in content) return contentToText(content.content);
    if ("output" in content) return contentToText(content.output);
    return JSON.stringify(content);
  }
  return String(content);
}

function responseReasoningToText(item) {
  return contentToText(item?.content || item?.summary || item?.text || "");
}

function normalizeRole(role) {
  if (role === "assistant") return "assistant";
  if (role === "system" || role === "developer") return "system";
  if (role === "tool") return "tool";
  return "user";
}

function sanitizeChatMessages(messages) {
  const out = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const current = { ...message, role: normalizeRole(message.role) };
    if (current.role !== "assistant") {
      current.content = typeof current.content === "string" ? current.content : contentToText(current.content);
    } else if (current.content !== null && current.content !== undefined && typeof current.content !== "string") {
      current.content = contentToText(current.content);
    }
    if (current.role === "assistant" && Array.isArray(current.tool_calls)) {
      current.content = current.content ?? null;
      current.tool_calls = current.tool_calls.map((call) => ({
        id: call.id || `call_${crypto.randomUUID()}`,
        type: "function",
        function: {
          name: call.function?.name || call.name || "unknown",
          arguments: typeof call.function?.arguments === "string"
            ? call.function.arguments
            : JSON.stringify(call.function?.arguments || call.arguments || {})
        }
      }));
    }
    if (current.role === "tool") {
      current.tool_call_id = current.tool_call_id || current.call_id || "";
    }
    out.push(current);
  }
  return mergeConsecutiveMessages(out);
}

function mergeConsecutiveMessages(messages) {
  const merged = [];
  for (const message of messages) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.role === message.role &&
      ["system", "user", "assistant"].includes(message.role) &&
      !prev.tool_calls &&
      !message.tool_calls
    ) {
      const prevContent = prev.content || "";
      const nextContent = message.content || "";
      prev.content = prevContent && nextContent ? `${prevContent}\n\n${nextContent}` : (nextContent || prevContent);
      if (message.reasoning_content && !prev.reasoning_content) prev.reasoning_content = message.reasoning_content;
      continue;
    }
    merged.push(message);
  }
  return merged;
}

function textifyToolHistory(messages, { onlyMissingReasoning = true } = {}) {
  const out = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (
      message?.role !== "assistant" ||
      !Array.isArray(message.tool_calls) ||
      message.tool_calls.length === 0 ||
      (onlyMissingReasoning && message.reasoning_content)
    ) {
      out.push(message);
      continue;
    }

    const callIds = new Set(message.tool_calls.map((call) => call.id).filter(Boolean));
    const lines = [];
    if (message.reasoning_content) {
      lines.push(`Previous reasoning:\n${message.reasoning_content}`);
    }
    lines.push(...message.tool_calls.map((call) => {
      const name = call.function?.name || call.name || "unknown";
      const args = call.function?.arguments || call.arguments || "{}";
      return `Previous tool call ${call.id || ""}: ${name}(${args})`;
    }));

    while (
      index + 1 < messages.length &&
      messages[index + 1]?.role === "tool" &&
      callIds.has(messages[index + 1].tool_call_id)
    ) {
      index += 1;
      lines.push(`Tool output for ${messages[index].tool_call_id}:\n${messages[index].content || ""}`);
    }

    out.push({ role: "user", content: lines.join("\n\n") });
  }
  return mergeConsecutiveMessages(out);
}

function hasAssistantToolCallsWithoutReasoning(messages) {
  return messages.some((message) => (
    message.role === "assistant" &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0 &&
    !message.reasoning_content
  ));
}

export function extractNamespaceMap(tools) {
  if (!Array.isArray(tools)) return {};
  const map = {};
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || tool.type !== "namespace") continue;
    const namespace = tool.name || "";
    const functions = tool.functions || tool.tools || [];
    for (const fn of functions) {
      if (fn && typeof fn === "object" && fn.name) {
        map[`${namespace}__${fn.name}`] = { namespace, name: fn.name };
      }
    }
  }
  return map;
}

function unflattenToolName(name, namespaceMap = {}) {
  if (namespaceMap[name]) return namespaceMap[name];
  if (name.includes("__")) {
    const parts = name.split("__");
    return { namespace: parts.slice(0, -1).join("__"), name: parts[parts.length - 1] };
  }
  return { namespace: null, name };
}

function responsesInputToMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [{ role: "user", content: contentToText(input) }];

  const outputCallIds = new Set(
    input
      .filter((item) => item && typeof item === "object" && item.type === "function_call_output")
      .map((item) => item.call_id || item.id || "")
      .filter(Boolean)
  );
  const messages = [];
  const pendingToolCalls = [];
  const pendingToolCallIds = new Set();
  let pendingReasoningContent = "";

  const flushPendingToolCalls = () => {
    if (!pendingToolCalls.length) return;
    const assistant = {
      role: "assistant",
      content: null,
      tool_calls: pendingToolCalls.splice(0, pendingToolCalls.length)
    };
    if (pendingReasoningContent) {
      assistant.reasoning_content = pendingReasoningContent;
      pendingReasoningContent = "";
    }
    messages.push(assistant);
  };

  const convertPendingToText = () => {
    while (pendingToolCalls.length) {
      const call = pendingToolCalls.shift();
      messages.push({
        role: "assistant",
        content: `Requested tool call ${call.id}: ${call.function.name}(${call.function.arguments || "{}"})`
      });
    }
    pendingToolCallIds.clear();
  };

  for (const item of input) {
    if (typeof item === "string") {
      convertPendingToText();
      messages.push({ role: "user", content: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;

    if (item.type === "reasoning") {
      pendingReasoningContent = responseReasoningToText(item);
      continue;
    }

    if (item.type === "function_call") {
      const callId = item.call_id || item.id || `call_${crypto.randomUUID()}`;
      const call = {
        id: callId,
        type: "function",
        function: {
          name: item.name || "unknown",
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})
        }
      };
      if (!outputCallIds.has(callId)) {
        messages.push({
          role: "assistant",
          content: `${pendingReasoningContent ? `Reasoning:\n${pendingReasoningContent}\n\n` : ""}Requested tool call ${callId}: ${call.function.name}(${call.function.arguments || "{}"})`
        });
        pendingReasoningContent = "";
        continue;
      }
      pendingToolCalls.push(call);
      pendingToolCallIds.add(callId);
      continue;
    }

    if (item.type === "function_call_output") {
      const callId = item.call_id || item.id || "";
      const output = contentToText(item.output);
      if (callId && pendingToolCallIds.has(callId)) {
        flushPendingToolCalls();
        pendingToolCallIds.delete(callId);
        messages.push({ role: "tool", tool_call_id: callId, content: output });
      } else {
        messages.push({ role: "user", content: `Tool output${callId ? ` for ${callId}` : ""}:\n${output}` });
      }
      continue;
    }

    if (item.type === "message" || item.role) {
      if (pendingToolCalls.length) convertPendingToText();
      const role = normalizeRole(item.role);
      const message = { role, content: contentToText(item.content || item.output || item.text || "") };
      if (role === "assistant" && pendingReasoningContent) {
        message.reasoning_content = pendingReasoningContent;
        pendingReasoningContent = "";
      }
      messages.push(message);
      continue;
    }

    if (item.type === "input_text" || item.type === "text") {
      if (pendingToolCalls.length) convertPendingToText();
      messages.push({ role: "user", content: contentToText(item) });
    }
  }

  if (pendingToolCalls.length) convertPendingToText();
  return sanitizeChatMessages(messages.length ? messages : [{ role: "user", content: "" }]);
}

function responsesToolsToChatTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "function" && (tool.name || tool.function?.name)) {
      out.push({
        type: "function",
        function: {
          name: tool.name || tool.function.name,
          description: tool.description || tool.function?.description || "",
          parameters: tool.parameters || tool.input_schema || tool.function?.parameters || { type: "object", properties: {} }
        }
      });
      continue;
    }
    if (tool.type === "namespace") {
      const namespace = tool.name || "";
      const functions = tool.functions || tool.tools || [];
      for (const fn of functions) {
        if (!fn || typeof fn !== "object" || !fn.name) continue;
        out.push({
          type: "function",
          function: {
            name: `${namespace}__${fn.name}`,
            description: fn.description || "",
            parameters: fn.parameters || fn.input_schema || { type: "object", properties: {} }
          }
        });
      }
    }
  }
  return out.length ? out : undefined;
}

export function responsesToChat(body, model, options = {}) {
  const messages = [];
  if (body.instructions) {
    messages.push({ role: "system", content: contentToText(body.instructions) });
  }
  messages.push(...responsesInputToMessages(body.input));
  const reasoning = options.reasoning || {};
  let chatMessages = sanitizeChatMessages(messages);
  const missingReasoningContent = hasAssistantToolCallsWithoutReasoning(chatMessages);
  if (reasoning.effortValueMode === "deepseek" && reasoning.outputFormat === "reasoning_content" && missingReasoningContent) {
    chatMessages = textifyToolHistory(chatMessages);
  } else if (options.textifyToolHistory) {
    chatMessages = textifyToolHistory(chatMessages, { onlyMissingReasoning: false });
  }

  const chat = {
    model,
    messages: chatMessages,
    stream: Boolean(body.stream)
  };
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) chat.max_tokens = body.max_output_tokens;
  if (body.max_tokens !== undefined) chat.max_tokens = body.max_tokens;
  if (body.parallel_tool_calls !== undefined) chat.parallel_tool_calls = body.parallel_tool_calls;

  const reasoningEffort = body.reasoning_effort || body.model_reasoning_effort || body.reasoning?.effort || "";
  const canEnableThinking = !(reasoning.outputFormat === "reasoning_content" && hasAssistantToolCallsWithoutReasoning(chatMessages));
  let thinkingEnabled = false;
  if (canEnableThinking && reasoningEffort && reasoning.supportsThinking && reasoning.thinkingParam && reasoning.thinkingParam !== "none") {
    if (reasoning.thinkingParam === "thinking") {
      chat.thinking = { type: "enabled" };
    } else {
      chat[reasoning.thinkingParam] = true;
    }
    thinkingEnabled = true;
  }
  const canSendEffort = !thinkingEnabled || !options.thinkingExcludesEffort;
  if (canEnableThinking && canSendEffort && reasoning.supportsEffort && reasoningEffort && reasoning.effortParam && reasoning.effortParam !== "none") {
    chat[reasoning.effortParam] = reasoningEffort;
  } else if (canEnableThinking && canSendEffort && !reasoning.effortParam && reasoningEffort) {
    chat.reasoning_effort = reasoningEffort;
  }

  const tools = responsesToolsToChatTools(body.tools);
  if (tools) chat.tools = tools;
  if (body.tool_choice !== undefined) chat.tool_choice = body.tool_choice;
  return chat;
}

function normalizeUsage(usage) {
  const inputTokens = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
  const outputTokens = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0);
  const totalTokens = Number(usage?.total_tokens ?? inputTokens + outputTokens);
  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: Number(usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0)
    },
    output_tokens: outputTokens,
    output_tokens_details: {
      reasoning_tokens: Number(usage?.output_tokens_details?.reasoning_tokens ?? usage?.completion_tokens_details?.reasoning_tokens ?? 0)
    },
    total_tokens: totalTokens
  };
}

function responseItemFromToolCall(call, namespaceMap = {}) {
  const rawName = call.function?.name || call.name || "unknown";
  const resolved = unflattenToolName(rawName, namespaceMap);
  const item = {
    type: "function_call",
    id: call.id || `fc_${crypto.randomUUID()}`,
    call_id: call.id || `call_${crypto.randomUUID()}`,
    name: resolved.name || rawName,
    arguments: call.function?.arguments || call.arguments || "{}",
    status: "completed"
  };
  if (resolved.namespace) item.namespace = resolved.namespace;
  return item;
}

export function chatToResponse(payload, requestedModel, options = {}) {
  const choice = payload.choices?.[0] || {};
  const message = choice.message || {};
  const id = payload.id || `resp_${crypto.randomUUID()}`;
  const output = [];
  const reasoningContent = message.reasoning_content || message.reasoning || "";

  if (reasoningContent) {
    output.push({
      type: "reasoning",
      id: `rs_${crypto.randomUUID()}`,
      status: "completed",
      content: [{ type: "reasoning_text", text: reasoningContent }],
      summary: [{ type: "summary_text", text: reasoningContent }]
    });
  }

  const text = contentToText(message.content || "");
  if (text) {
    output.push({
      type: "message",
      id: `msg_${crypto.randomUUID()}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }]
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      output.push(responseItemFromToolCall(call, options.namespaceMap));
    }
  }

  if (output.length === 0) {
    output.push({
      type: "message",
      id: `msg_${crypto.randomUUID()}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "", annotations: [] }]
    });
  }

  return {
    id,
    object: "response",
    created_at: payload.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel,
    output,
    usage: normalizeUsage(payload.usage)
  };
}

function sseWrite(res, event, data) {
  if (res.destroyed || res.writableEnded) return;
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function writeResponseSse(res, response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive"
  });
  sseWrite(res, "response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [] } });
  response.output.forEach((item, outputIndex) => {
    sseWrite(res, "response.output_item.added", { type: "response.output_item.added", output_index: outputIndex, item });
    if (item.type === "message") {
      const text = item.content?.[0]?.text || "";
      sseWrite(res, "response.content_part.added", {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] }
      });
      if (text) {
        sseWrite(res, "response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          delta: text
        });
      }
      sseWrite(res, "response.output_text.done", {
        type: "response.output_text.done",
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        text
      });
      sseWrite(res, "response.content_part.done", {
        type: "response.content_part.done",
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: item.content?.[0] || { type: "output_text", text: "", annotations: [] }
      });
    }
    if (item.type === "function_call") {
      sseWrite(res, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments || "{}"
      });
    }
    sseWrite(res, "response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item });
  });
  sseWrite(res, "response.completed", { type: "response.completed", response: { ...response, status: "completed" } });
  res.write("data: [DONE]\n\n");
  res.end();
}

class ResponsesStreamState {
  constructor(model, namespaceMap = {}) {
    this.responseId = `resp_${crypto.randomUUID()}`;
    this.messageId = `msg_${crypto.randomUUID()}`;
    this.model = model;
    this.namespaceMap = namespaceMap;
    this.nextOutputIndex = 0;
    this.messageIndex = null;
    this.messageText = "";
    this.messageOpened = false;
    this.messageClosed = false;
    this.reasoningIndex = null;
    this.reasoningId = `rs_${crypto.randomUUID()}`;
    this.reasoningText = "";
    this.reasoningOpened = false;
    this.reasoningClosed = false;
    this.toolCalls = new Map();
  }

  response(status, final = false) {
    const output = [];
    if (final) {
      if (this.reasoningOpened && this.reasoningText) {
        output.push(this.reasoningItem("completed"));
      }
      if (this.messageOpened && this.messageText) {
        output.push(this.messageItem("completed"));
      }
      for (const state of [...this.toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
        output.push(this.toolItem(state, "completed"));
      }
    }
    return {
      id: this.responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status,
      model: this.model,
      output
    };
  }

  async start(res) {
    sseWrite(res, "response.created", { type: "response.created", response: this.response("in_progress") });
  }

  async finish(res) {
    if (this.reasoningOpened && !this.reasoningClosed) this.closeReasoning(res);
    if (this.messageOpened && !this.messageClosed) this.closeMessage(res);
    for (const state of this.toolCalls.values()) {
      if (!state.opened) this.openTool(res, state);
      if (!state.closed) this.closeTool(res, state);
    }
    sseWrite(res, "response.completed", { type: "response.completed", response: this.response("completed", true) });
    res.write("data: [DONE]\n\n");
    res.end();
  }

  writeDelta(res, chunk) {
    const delta = chunk.choices?.[0]?.delta || {};
    const reasoning = delta.reasoning_content || delta.reasoning || "";
    if (reasoning) this.writeReasoning(res, reasoning);
    if (delta.content) this.writeText(res, delta.content);
    for (const call of delta.tool_calls || []) this.writeToolDelta(res, call);
  }

  openReasoning(res) {
    if (this.reasoningOpened) return;
    this.reasoningOpened = true;
    this.reasoningIndex = this.nextOutputIndex++;
    sseWrite(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: this.reasoningIndex,
      item: this.reasoningItem("in_progress")
    });
    sseWrite(res, "response.content_part.added", {
      type: "response.content_part.added",
      item_id: this.reasoningId,
      output_index: this.reasoningIndex,
      content_index: 0,
      part: { type: "reasoning_text", text: "" }
    });
  }

  writeReasoning(res, text) {
    if (!text) return;
    this.openReasoning(res);
    this.reasoningText += text;
    sseWrite(res, "response.reasoning_text.delta", {
      type: "response.reasoning_text.delta",
      item_id: this.reasoningId,
      output_index: this.reasoningIndex,
      content_index: 0,
      delta: text
    });
    sseWrite(res, "response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      item_id: this.reasoningId,
      output_index: this.reasoningIndex,
      summary_index: 0,
      delta: text
    });
  }

  closeReasoning(res) {
    this.reasoningClosed = true;
    sseWrite(res, "response.reasoning_text.done", {
      type: "response.reasoning_text.done",
      item_id: this.reasoningId,
      output_index: this.reasoningIndex,
      content_index: 0,
      text: this.reasoningText
    });
    sseWrite(res, "response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: this.reasoningId,
      output_index: this.reasoningIndex,
      summary_index: 0,
      text: this.reasoningText
    });
    sseWrite(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: this.reasoningIndex,
      item: this.reasoningItem("completed")
    });
  }

  openMessage(res) {
    if (this.messageOpened) return;
    if (this.reasoningOpened && !this.reasoningClosed) this.closeReasoning(res);
    this.messageOpened = true;
    this.messageIndex = this.nextOutputIndex++;
    sseWrite(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: this.messageIndex,
      item: this.messageItem("in_progress")
    });
    sseWrite(res, "response.content_part.added", {
      type: "response.content_part.added",
      item_id: this.messageId,
      output_index: this.messageIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] }
    });
  }

  writeText(res, text) {
    if (!text) return;
    this.openMessage(res);
    this.messageText += text;
    sseWrite(res, "response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: this.messageId,
      output_index: this.messageIndex,
      content_index: 0,
      delta: text
    });
  }

  closeMessage(res) {
    this.messageClosed = true;
    sseWrite(res, "response.output_text.done", {
      type: "response.output_text.done",
      item_id: this.messageId,
      output_index: this.messageIndex,
      content_index: 0,
      text: this.messageText
    });
    sseWrite(res, "response.content_part.done", {
      type: "response.content_part.done",
      item_id: this.messageId,
      output_index: this.messageIndex,
      content_index: 0,
      part: { type: "output_text", text: this.messageText, annotations: [] }
    });
    sseWrite(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: this.messageIndex,
      item: this.messageItem("completed")
    });
  }

  writeToolDelta(res, call) {
    const index = Number(call.index || 0);
    let state = this.toolCalls.get(index);
    const fn = call.function || {};
    if (!state) {
      state = {
        id: call.id || `call_${crypto.randomUUID()}`,
        name: fn.name || "",
        arguments: "",
        outputIndex: null,
        opened: false,
        closed: false
      };
      this.toolCalls.set(index, state);
    }
    if (fn.name && !state.name) state.name = fn.name;
    if (state.name && !state.opened) this.openTool(res, state);
    if (fn.arguments) {
      state.arguments += fn.arguments;
      if (state.opened) {
        sseWrite(res, "response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          item_id: state.id,
          output_index: state.outputIndex,
          delta: fn.arguments
        });
      }
    }
  }

  openTool(res, state) {
    if (state.opened) return;
    if (this.messageOpened && !this.messageClosed) this.closeMessage(res);
    state.opened = true;
    state.outputIndex = this.nextOutputIndex++;
    sseWrite(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: state.outputIndex,
      item: this.toolItem(state, "in_progress")
    });
  }

  closeTool(res, state) {
    state.closed = true;
    sseWrite(res, "response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: state.id,
      output_index: state.outputIndex,
      arguments: state.arguments || "{}"
    });
    sseWrite(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: state.outputIndex,
      item: this.toolItem(state, "completed")
    });
  }

  reasoningItem(status) {
    return {
      id: this.reasoningId,
      type: "reasoning",
      status,
      summary: this.reasoningText ? [{ type: "summary_text", text: this.reasoningText }] : [],
      content: this.reasoningText ? [{ type: "reasoning_text", text: this.reasoningText }] : []
    };
  }

  messageItem(status) {
    return {
      id: this.messageId,
      type: "message",
      status,
      role: "assistant",
      content: this.messageText ? [{ type: "output_text", text: this.messageText, annotations: [] }] : []
    };
  }

  toolItem(state, status) {
    const resolved = unflattenToolName(state.name || "unknown", this.namespaceMap);
    const item = {
      id: state.id,
      type: "function_call",
      status,
      call_id: state.id,
      name: resolved.name || state.name || "unknown",
      arguments: state.arguments || "{}"
    };
    if (resolved.namespace) item.namespace = resolved.namespace;
    return item;
  }
}

export async function streamChatToResponses(upstream, res, requestedModel, options = {}) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  const state = new ResponsesStreamState(requestedModel, options.namespaceMap);
  await state.start(res);

  const reader = upstream.body?.getReader();
  if (!reader) {
    await state.finish(res);
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data:")) continue;
        try {
          const chunk = JSON.parse(trimmed.slice(5).trim());
          state.writeDelta(res, chunk);
        } catch {
          // Ignore malformed streaming fragments.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  await state.finish(res);
}
