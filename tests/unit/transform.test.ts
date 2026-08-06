
import { beforeAll, describe, expect, test } from "bun:test";
import { loadProxyConfig } from "../../src/config/manager";
import { transformToGoogleBody, transformGoogleEventToOpenAI } from "../../src/utils/transform";

beforeAll(async () => {
  await loadProxyConfig();
});

describe("Unit Tests: transformToGoogleBody", () => {
  test("Basic message transformation", () => {
    const openaiBody = {
      model: "gpt-4o",
      messages: [
        { role: "user", content: "Hello Gemini" }
      ],
      temperature: 0.5
    };

    const result = transformToGoogleBody(openaiBody, "test-project", false, "us-central1");

    expect(result.project).toBe("test-project");
    expect(result.model).toBe("gpt-4o"); // It passes through if no antigravity prefix
    expect(result.request.contents).toHaveLength(1);
    expect(result.request.contents[0].role).toBe("user");
    expect(result.request.contents[0].parts[0].text).toBe("Hello Gemini");
    expect(result.request.generationConfig.temperature).toBe(0.5);
  });

  test("Antigravity model prefix removal", () => {
    const openaiBody = {
      model: "antigravity-gemini-2.0-flash",
      messages: [{ role: "user", content: "Hi" }]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    expect(result.model).toBe("gemini-2.0-flash");
  });

  test("Thinking level extraction for CLI", () => {
    const openaiBody = {
      model: "gemini-3-flash-thinking-medium",
      messages: [{ role: "user", content: "Hi" }]
    };

    const result = transformToGoogleBody(openaiBody, "p", true, "us-central1"); // isCli = true
    expect(result.model).toBe("gemini-3-flash-preview");
    expect(result.request.generationConfig.thinkingConfig.thinkingLevel).toBe("medium");
  });

  test("Gemini 3.6 Flash uses thinkingLevel without a conflicting budget", () => {
    const openaiBody = {
      model: "antigravity-gemini-3.6-flash-high",
      messages: [{ role: "user", content: "Hi" }]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");

    // Preserve the dynamically advertised base model while treating the suffix
    // as the thinking level instead of part of the upstream model ID.
    expect(result.model).toBe("gemini-3.6-flash");
    expect(result.request.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "high"
    });
    expect(result.request.generationConfig.thinkingConfig.thinkingBudget).toBeUndefined();
  });

  test("Multi-turn conversation", () => {
    const openaiBody = {
      model: "gemini-1.5-pro",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" }
      ]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    expect(result.request.contents).toHaveLength(3);
    expect(result.request.contents[0].role).toBe("user");
    expect(result.request.contents[1].role).toBe("model"); // OpenAI assistant -> Google model
    expect(result.request.contents[2].role).toBe("user");
  });

  test("Tool transformation", () => {
    const openaiBody = {
      model: "gemini-1.5-pro",
      messages: [{ role: "user", content: "Check weather" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string" }
              },
              required: ["location"]
            }
          }
        }
      ]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    expect(result.request.tools).toBeDefined();
    expect(result.request.tools[0].functionDeclarations).toHaveLength(1);
    expect(result.request.tools[0].functionDeclarations[0].name).toBe("get_weather");
    expect(result.request.tools[0].functionDeclarations[0].parameters.properties.location).toBeDefined();
  });

  test("Claude Opus 4.6 Thinking mapping and budget", () => {
    const openaiBody = {
      model: "antigravity-claude-opus-4-6-thinking-high",
      messages: [{ role: "user", content: "Hi" }]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    expect(result.model).toBe("claude-opus-4-6-thinking");
    expect(result.request.generationConfig.thinkingConfig.includeThoughts).toBe(true);
    expect(result.request.generationConfig.thinkingConfig.thinkingBudget).toBe(32768);
  });

  test("Claude Opus 4.6 Thinking Low budget", () => {
    const openaiBody = {
      model: "antigravity-claude-opus-4-6-thinking-low",
      messages: [{ role: "user", content: "Hi" }]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    expect(result.request.generationConfig.thinkingConfig.thinkingBudget).toBe(8192);
  });

  test("Claude tool call transformation with ID", () => {
    const openaiBody = {
      model: "antigravity-claude-opus-4-6-thinking-high",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_abc123",
              type: "function",
              function: { name: "test_tool", arguments: "{}" }
            }
          ]
        }
      ]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    const funcCallPart = result.request.contents[0].parts.find((p: any) => p.functionCall);
    expect(funcCallPart).toBeDefined();
    expect(funcCallPart.functionCall.id).toBe("call_abc123");
  });

  test("Claude tool response transformation with ID", () => {
    const openaiBody = {
      model: "antigravity-claude-opus-4-6-thinking-high",
      messages: [
        {
          role: "tool",
          tool_call_id: "call_abc123",
          name: "test_tool",
          content: '{"result": "ok"}'
        }
      ]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    const funcRespPart = result.request.contents[0].parts.find((p: any) => p.functionResponse);
    expect(funcRespPart).toBeDefined();
    expect(funcRespPart.functionResponse.id).toBe("call_abc123");
  });

  test("Tool responses neutralize ordinary JSON Schema refs", () => {
    const openaiBody = {
      model: "gemini-3.6-flash-high",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_validation",
            type: "function",
            function: { name: "validate_request", arguments: "{}" }
          }]
        },
        {
          role: "tool",
          tool_call_id: "call_validation",
          content: JSON.stringify({
            error: {
              schema: { "$ref": "#/components/schemas/ValidationError" },
              nested: [{ "$ref": "#/$defs/FieldError" }]
            }
          })
        }
      ]
    };

    const result = transformToGoogleBody(openaiBody, "p", true, "us-central1");
    const funcResp = result.request.contents[1].parts[0].functionResponse;

    expect(funcResp.name).toBe("validate_request");
    expect(funcResp.response.error.schema.schemaRef).toBe("#/components/schemas/ValidationError");
    expect(funcResp.response.error.nested[0].schemaRef).toBe("#/$defs/FieldError");
    expect(JSON.stringify(funcResp.response)).not.toContain('"$ref"');
  });
});

describe("Unit Tests: transformGoogleEventToOpenAI", () => {
  test("Basic text response", () => {
    const googleData = {
      candidates: [{
        content: {
          parts: [{ text: "Hello world" }]
        },
        finishReason: "STOP"
      }]
    };

    const result = transformGoogleEventToOpenAI(googleData, "gemini-1.5-pro", "req-123");
    expect(result).not.toBeNull();
    expect(result.choices[0].delta.content).toBe("Hello world");
    expect(result.choices[0].finish_reason).toBe("stop");
  });

  test("Tool call response", () => {
    const googleData = {
      candidates: [{
        content: {
          parts: [{
            functionCall: {
              name: "get_weather",
              args: { location: "London" }
            }
          }]
        }
      }]
    };

    const result = transformGoogleEventToOpenAI(googleData, "gemini-1.5-pro");
    expect(result.choices[0].delta.tool_calls).toHaveLength(1);
    expect(result.choices[0].delta.tool_calls[0].function.name).toBe("get_weather");
    expect(JSON.parse(result.choices[0].delta.tool_calls[0].function.arguments).location).toBe("London");
  });

  test("Empty/Invalid response", () => {
    const googleData = { candidates: [] };
    const result = transformGoogleEventToOpenAI(googleData, "model");
    expect(result).toBeNull();
  });
});
