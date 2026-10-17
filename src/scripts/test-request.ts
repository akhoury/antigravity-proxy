
async function performRequest(label: string, body: any) {
  console.log(`\n--- ${label} ---`);
  console.log("🚀 Sending request...");
  
  try {
    const response = await fetch("http://127.0.0.1:3333/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer sk-antigravity" 
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        console.error(`❌ Error: ${response.status} - ${text}`);
        return { ok: false, status: response.status, text };
    }

    console.log("✅ Connected! receiving stream:\n");
    
    const reader = response.body?.getReader();
    if (!reader) return { ok: false };
    
    const decoder = new TextDecoder();
    let fullContent = "";
    let reasoningContent = "";
    let hasToolCall = false;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");
        
        for (const line of lines) {
            if (line.startsWith("data: ") && line !== "data: [DONE]") {
                try {
                    const json = JSON.parse(line.slice(6));
                    const delta = json.choices[0]?.delta;
                    if (delta?.content) {
                        process.stdout.write(delta.content);
                        fullContent += delta.content;
                    }
                    if (delta?.reasoning_content) {
                        reasoningContent += delta.reasoning_content;
                    }
                    if (delta?.tool_calls) {
                        hasToolCall = true;
                    }
                } catch (e) {}
            }
        }
    }
    console.log("\n\n✨ Done.");
    return { ok: true, fullContent, reasoningContent, hasToolCall };
    
  } catch (e) {
      console.error("❌ Failed to connect.", e);
      return { ok: false, error: e };
  }
}

async function runTests() {
  console.log("🧪 STARTING PHASE 5 INTEGRATION TESTS");

  const thinkingResult = await performRequest("THINKING TEST", {
    model: "gemini-2.5-flash-thinking",
    messages: [{ role: "user", content: "Explain quantum entanglement in one sentence. Think deeply first." }],
    stream: true,
    thinking_budget: 2000
  });

  if (thinkingResult.ok && thinkingResult.reasoningContent) {
    console.log("✅ PASS: reasoning_content detected in stream.");
    console.log(`(Reasoning length: ${thinkingResult.reasoningContent.length} chars)`);
  } else {
    console.error("❌ FAIL: No reasoning_content detected.");
  }

  const toolResult = await performRequest("TOOL HARDENING TEST", {
    model: "gemini-2.5-flash",
    messages: [{ role: "user", content: "What time is it in Tokyo? Use the get_time tool." }],
    tools: [{
      type: "function",
      function: {
        name: "get_time",
        description: "Get current time",
        parameters: { type: "object", properties: {} }
      }
    }],
    stream: true
  });

  if (toolResult.ok) {
    console.log("✅ PASS: Request with empty tool parameters succeeded.");
  } else {
    console.error("❌ FAIL: Tool request failed.");
  }

  console.log("\n--- MULTI-TURN TEST ---");
  console.log("Step 1: Get thinking response...");
  const turn1 = await performRequest("Multi-turn Part 1", {
    model: "gemini-2.5-flash-thinking",
    messages: [{ role: "user", content: "Write a short poem about space. Think first." }],
    stream: true,
    thinking_budget: 2000
  });

  if (turn1.ok && turn1.reasoningContent) {
    console.log("Step 2: Sending follow-up with thinking context...");
    const turn2 = await performRequest("Multi-turn Part 2", {
      model: "gemini-2.5-flash-thinking",
      messages: [
        { role: "user", content: "Write a short poem about space. Think first." },
        { role: "assistant", reasoning_content: turn1.reasoningContent, content: turn1.fullContent },
        { role: "user", content: "Now make it about Mars." }
      ],
      stream: true,
      thinking_budget: 2000
    });

    if (turn2.ok) {
        console.log("✅ PASS: Multi-turn thinking request succeeded (signature re-injection worked).");
    } else {
        console.error("❌ FAIL: Multi-turn request failed.");
    }
  } else {
    console.error("❌ SKIP: Turn 1 failed or had no reasoning.");
  }

  console.log("\n🏁 ALL TESTS COMPLETED");
}

runTests();
