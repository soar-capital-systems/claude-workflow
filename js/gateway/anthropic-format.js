import crypto from 'node:crypto';

import { GatewayError } from './model-routing.js';

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function parseJsonObject(jsonText, label) {
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new GatewayError(
      502,
      'api_error',
      `upstream returned invalid JSON for ${label}`
    );
  }
}

function joinTextParts(parts) {
  if (parts.length === 0) {
    return '';
  }
  return parts.join('\n\n');
}

function normalizedBlocks(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content;
  }
  throw new GatewayError(
    400,
    'invalid_request_error',
    'message content must be a string or an array of content blocks'
  );
}

function renderToolResultContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    throw new GatewayError(
      400,
      'invalid_request_error',
      'tool_result content must be a string or an array of text blocks'
    );
  }

  const textParts = [];
  for (const block of content) {
    if (block?.type !== 'text') {
      throw new GatewayError(
        400,
        'invalid_request_error',
        `unsupported tool_result content block type: ${String(block?.type)}`
      );
    }
    textParts.push(block.text || '');
  }
  return joinTextParts(textParts);
}

function translateImageSource(source) {
  if (source?.type === 'base64') {
    if (!source.media_type || !source.data) {
      throw new GatewayError(
        400,
        'invalid_request_error',
        'image source with type base64 must include media_type and data'
      );
    }

    return `data:${source.media_type};base64,${source.data}`;
  }

  if (source?.type === 'url' && typeof source.url === 'string' && source.url !== '') {
    return source.url;
  }

  throw new GatewayError(
    400,
    'invalid_request_error',
    `unsupported image source type: ${String(source?.type)}`
  );
}

function openAiUserContent(parts) {
  if (parts.length === 0) {
    return '';
  }

  if (parts.every(function isTextPart(part) { return part.type === 'text'; })) {
    return joinTextParts(parts.map(function textPart(part) { return part.text; }));
  }

  return parts;
}

function translateUserMessage(message) {
  const blocks = normalizedBlocks(message.content);
  const contentParts = [];
  const toolResults = [];

  for (const block of blocks) {
    if (block?.type === 'text') {
      contentParts.push({
        type: 'text',
        text: block.text || '',
      });
      continue;
    }

    if (block?.type === 'image') {
      contentParts.push({
        type: 'image_url',
        image_url: {
          url: translateImageSource(block.source),
        },
      });
      continue;
    }

    if (block?.type === 'tool_result') {
      toolResults.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: renderToolResultContent(block.content),
      });
      continue;
    }

    throw new GatewayError(
      400,
      'invalid_request_error',
      `unsupported user content block type: ${String(block?.type)}`
    );
  }

  const translated = [...toolResults];
  if (contentParts.length > 0) {
    translated.push({
      role: 'user',
      content: openAiUserContent(contentParts),
    });
  }

  if (translated.length === 0) {
    translated.push({ role: 'user', content: '' });
  }

  return translated;
}

function translateAssistantMessage(message) {
  const blocks = normalizedBlocks(message.content);
  const textParts = [];
  const toolCalls = [];

  for (const block of blocks) {
    if (block?.type === 'text') {
      textParts.push(block.text || '');
      continue;
    }

    if (block?.type === 'tool_use') {
      toolCalls.push({
        id: block.id || randomId('toolu'),
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      });
      continue;
    }

    throw new GatewayError(
      400,
      'invalid_request_error',
      `unsupported assistant content block type: ${String(block?.type)}`
    );
  }

  return [
    {
      role: 'assistant',
      content: textParts.length > 0 ? joinTextParts(textParts) : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
  ];
}

function translateSystemMessage(message) {
  const blocks = normalizedBlocks(message.content);
  const textParts = [];

  for (const block of blocks) {
    if (block?.type !== 'text') {
      throw new GatewayError(
        400,
        'invalid_request_error',
        `unsupported system content block type: ${String(block?.type)}`
      );
    }
    textParts.push(block.text || '');
  }

  return [
    {
      role: 'developer',
      content: joinTextParts(textParts),
    },
  ];
}

function translateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new GatewayError(
      400,
      'invalid_request_error',
      'messages must be a non-empty array'
    );
  }

  const translated = [];
  for (const message of messages) {
    if (message?.role === 'system') {
      translated.push(...translateSystemMessage(message));
      continue;
    }
    if (message?.role === 'user') {
      translated.push(...translateUserMessage(message));
      continue;
    }
    if (message?.role === 'assistant') {
      translated.push(...translateAssistantMessage(message));
      continue;
    }
    throw new GatewayError(
      400,
      'invalid_request_error',
      `unsupported message role: ${String(message?.role)}`
    );
  }
  return translated;
}

function translateSystemPrompt(system) {
  if (system === undefined || system === null) {
    return '';
  }

  if (typeof system === 'string') {
    return system;
  }

  if (!Array.isArray(system)) {
    throw new GatewayError(
      400,
      'invalid_request_error',
      'system must be a string or an array of text blocks'
    );
  }

  const parts = [];
  for (const block of system) {
    if (block?.type !== 'text') {
      throw new GatewayError(
        400,
        'invalid_request_error',
        `unsupported system content block type: ${String(block?.type)}`
      );
    }
    parts.push(block.text || '');
  }
  return joinTextParts(parts);
}

function translateTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }

  return tools.map(function mapTool(tool) {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || {
          type: 'object',
          properties: {},
        },
      },
    };
  });
}

function translateToolChoice(toolChoice) {
  if (toolChoice === undefined || toolChoice === null) {
    return undefined;
  }

  if (typeof toolChoice !== 'object') {
    throw new GatewayError(
      400,
      'invalid_request_error',
      'tool_choice must be an object when provided'
    );
  }

  if (toolChoice.type === 'auto') {
    return 'auto';
  }
  if (toolChoice.type === 'any') {
    return 'required';
  }
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return {
      type: 'function',
      function: {
        name: toolChoice.name,
      },
    };
  }
  if (toolChoice.type === 'none') {
    return 'none';
  }

  throw new GatewayError(
    400,
    'invalid_request_error',
    `unsupported tool_choice type: ${String(toolChoice.type)}`
  );
}

function parseToolArguments(toolCall) {
  const parsed = parseJsonObject(
    toolCall.function?.arguments || '{}',
    `tool call ${toolCall.id || toolCall.function?.name || 'unknown'}`
  );

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GatewayError(
      502,
      'api_error',
      'upstream returned tool arguments that were not a JSON object'
    );
  }

  return parsed;
}

function textBlocksFromMessageContent(content) {
  if (!content) {
    return [];
  }
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  if (!Array.isArray(content)) {
    throw new GatewayError(
      502,
      'api_error',
      'upstream returned unsupported assistant content'
    );
  }

  const blocks = [];
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
  }
  return blocks;
}

export function translateAnthropicMessagesRequest(requestBody, route) {
  const messages = [];
  const systemPrompt = translateSystemPrompt(requestBody.system);

  if (systemPrompt) {
    messages.push({
      role: 'developer',
      content: systemPrompt,
    });
  }

  messages.push(...translateMessages(requestBody.messages));

  const translated = {
    model: route.upstreamModel,
    messages,
    stream: requestBody.stream === true,
  };

  if (typeof requestBody.max_tokens === 'number') {
    translated.max_completion_tokens = requestBody.max_tokens;
  }
  if (typeof requestBody.temperature === 'number') {
    translated.temperature = requestBody.temperature;
  }
  if (typeof requestBody.top_p === 'number') {
    translated.top_p = requestBody.top_p;
  }
  if (Array.isArray(requestBody.stop_sequences) && requestBody.stop_sequences.length > 0) {
    translated.stop = requestBody.stop_sequences;
  }

  const tools = translateTools(requestBody.tools);
  if (tools) {
    translated.tools = tools;
  }

  const toolChoice = translateToolChoice(requestBody.tool_choice);
  if (toolChoice !== undefined) {
    translated.tool_choice = toolChoice;
  }
  if (requestBody.tool_choice?.disable_parallel_tool_use === true) {
    translated.parallel_tool_calls = false;
  }

  if (route.reasoningEffort) {
    translated.reasoning_effort = route.reasoningEffort;
  }
  if (route.verbosity) {
    translated.verbosity = route.verbosity;
  }
  if (translated.stream) {
    translated.stream_options = { include_usage: true };
  }

  return translated;
}

export function mapOpenAiFinishReason(finishReason) {
  if (finishReason === 'tool_calls') {
    return 'tool_use';
  }
  if (finishReason === 'length') {
    return 'max_tokens';
  }
  if (finishReason === 'stop' || finishReason === null || finishReason === undefined) {
    return finishReason === null || finishReason === undefined ? null : 'end_turn';
  }
  return 'end_turn';
}

export function translateOpenAiResponseToAnthropic(
  responseBody,
  requestedModel,
  requestId
) {
  const choice = responseBody.choices?.[0];
  if (!choice?.message) {
    throw new GatewayError(
      502,
      'api_error',
      'upstream returned no assistant message'
    );
  }

  const content = [
    ...textBlocksFromMessageContent(choice.message.content),
    ...(choice.message.tool_calls || []).map(function toToolUse(toolCall) {
      return {
        type: 'tool_use',
        id: toolCall.id || randomId('toolu'),
        name: toolCall.function?.name || 'unknown_tool',
        input: parseToolArguments(toolCall),
      };
    }),
  ];

  return {
    id: requestId || responseBody.id || randomId('msg'),
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: mapOpenAiFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: responseBody.usage?.prompt_tokens || 0,
      output_tokens: responseBody.usage?.completion_tokens || 0,
    },
  };
}

export function estimateAnthropicInputTokens(requestBody) {
  const serialized = JSON.stringify({
    model: requestBody.model,
    system: requestBody.system,
    messages: requestBody.messages,
    tools: requestBody.tools,
    tool_choice: requestBody.tool_choice,
  });
  return Math.max(1, Math.ceil(serialized.length / 4));
}

export function formatAnthropicError(error) {
  if (error instanceof GatewayError) {
    return {
      status: error.status,
      body: {
        type: 'error',
        error: {
          type: error.type,
          message: error.message,
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      type: 'error',
      error: {
        type: 'api_error',
        message:
          error instanceof Error ? error.message : 'unexpected gateway failure',
      },
    },
  };
}
