/**
 * A promptfoo custom provider that runs the exact same agent loop, tools, and system prompt as
 * providers/agent-provider.js, but calls OpenAI's Chat Completions API with gpt-4.1 instead of
 * Anthropic's Messages API with claude-sonnet-5. This exists so promptfoo can run every scenario
 * against both models and the results can be compared side by side, see README.md, "Why a
 * second provider" for the reasoning.
 *
 * Contract: https://www.promptfoo.dev/docs/providers/custom-api/
 * Output shape matches agent-provider.js exactly: { toolCalls, finalAction, finalActionInput,
 * transcript, costUsd, promptTokens, completionTokens } inside the JSON-stringified `output`,
 * plus the same `cost` and `tokenUsage` fields alongside it. That means the grading assertions
 * in promptfooconfig.yaml, written against agent-provider.js's shape, work against this
 * provider completely unchanged.
 */

const fs = require("fs");
const path = require("path");
const { TOOL_SCHEMAS, lookupRequester, checkPolicy } = require("../tools.js");

// Read straight from system-prompt.txt, the same way agent-provider.js does, rather than
// hand-copying the text a second time. This file is a Node-run promptfoo provider (unlike
// worker/agent-live-worker.js, a Cloudflare Worker with no filesystem access and no require()),
// so there is no reason to keep a second hand-maintained copy of the prompt here: reading the
// file directly means this provider can never drift out of sync with it.
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "..", "system-prompt.txt"), "utf8");

const MODEL = "gpt-4.1";
const TEMPERATURE = 0;
const MAX_NON_TERMINAL_TOOL_CALLS = 6;

// GPT-4.1 pricing, per OpenAI's own pricing page, confirmed current as of August 2026: $2.00
// per million input tokens, $8.00 per million output tokens. This is the standard rate, not a
// promotional or introductory one.
const INPUT_COST_PER_TOKEN = 2.0 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 8.0 / 1_000_000;

const TERMINAL_TOOLS = new Set(["ask_clarifying_question", "escalate_to_human", "respond_to_user"]);

// Real tools actually execute; terminal tools are handled by the loop itself, see below. Same
// executors as agent-provider.js, reused from tools.js.
const EXECUTORS = {
  lookup_requester: (input) => lookupRequester(input),
  check_policy: (input) => checkPolicy(input),
};

// Same TOOL_SCHEMAS as tools.js (and agent-provider.js), re-wrapped into OpenAI's Chat
// Completions function-calling shape. name/description/parameters are identical to Anthropic's
// name/description/input_schema; only the envelope differs.
const OPENAI_TOOLS = TOOL_SCHEMAS.map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  },
}));

class AgentProviderGpt41 {
  id() {
    return "access-request-agent-gpt41";
  }

  async callApi(prompt, context, options) {
    const apiKey = process.env.OPENAI_API_KEY;

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ];
    const toolCalls = []; // ordered list of non-terminal {name, input, result}
    const transcript = [{ role: "user", content: prompt }];

    let nonTerminalCallCount = 0;
    let finalAction = null;
    let finalActionInput = null;

    // Summed across every API call in this scenario's loop, same reasoning as
    // agent-provider.js: a scenario can involve several turns before a terminal action.
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    while (true) {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: TEMPERATURE,
          messages,
          tools: OPENAI_TOOLS,
          tool_choice: "auto",
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error("OpenAI API error (status " + response.status + "): " + JSON.stringify(data));
      }

      if (data.usage) {
        totalInputTokens += data.usage.prompt_tokens || 0;
        totalOutputTokens += data.usage.completion_tokens || 0;
      }

      const message = data.choices[0].message;
      transcript.push(message);

      const toolCallEntries = message.tool_calls || [];

      if (toolCallEntries.length === 0) {
        // The model responded with plain text and no tool call at all. There is nothing
        // further to execute; stop the loop without a terminal action, same treatment as
        // agent-provider.js.
        finalAction = "max_turns_exceeded";
        break;
      }

      // Handle only the first tool call found in the turn. In practice the system prompt asks
      // for a single action per turn, so this is the common case; if the model issues more than
      // one tool call in a single turn, only the first is acted on, same rule as
      // agent-provider.js.
      const call = toolCallEntries[0];
      const toolName = call.function.name;
      // Unlike Anthropic's tool_use.input (already a parsed object), OpenAI's function.arguments
      // comes back as a JSON-encoded string and has to be parsed explicitly.
      const toolInput = JSON.parse(call.function.arguments);

      if (TERMINAL_TOOLS.has(toolName)) {
        finalAction = toolName;
        finalActionInput = toolInput;
        break;
      }

      if (!EXECUTORS[toolName]) {
        // Unknown tool name; nothing sensible to execute, stop rather than loop forever.
        finalAction = "max_turns_exceeded";
        break;
      }

      if (nonTerminalCallCount >= MAX_NON_TERMINAL_TOOL_CALLS) {
        finalAction = "max_turns_exceeded";
        break;
      }

      const result = EXECUTORS[toolName](toolInput);
      toolCalls.push({ name: toolName, input: toolInput, result });
      nonTerminalCallCount += 1;

      // Push the assistant's message as-is (including its tool_calls array), then one "tool"
      // role message per tool call it contained, each carrying the same executed result. Every
      // tool_call_id in the assistant's message needs a matching tool response before the
      // conversation can continue, per OpenAI's contract; in practice there is only ever one,
      // since only the first is ever acted on and the system prompt asks for one action per turn.
      messages.push(message);
      for (const entry of toolCallEntries) {
        const toolResultMessage = {
          role: "tool",
          tool_call_id: entry.id,
          content: JSON.stringify(result),
        };
        messages.push(toolResultMessage);
        transcript.push(toolResultMessage);
      }
    }

    const totalTokens = totalInputTokens + totalOutputTokens;
    const costUsd = totalInputTokens * INPUT_COST_PER_TOKEN + totalOutputTokens * OUTPUT_COST_PER_TOKEN;

    // costUsd, promptTokens, and completionTokens are duplicated inside the output object
    // itself (not just returned via promptfoo's own `cost`/`tokenUsage` fields below), because
    // the dashboard's data-loading step reads them back out of the parsed `output` JSON, not
    // promptfoo's internal bookkeeping.
    const output = {
      toolCalls,
      finalAction,
      finalActionInput,
      transcript,
      costUsd,
      promptTokens: totalInputTokens,
      completionTokens: totalOutputTokens,
    };

    return {
      output: JSON.stringify(output),
      cost: costUsd,
      tokenUsage: {
        total: totalTokens,
        prompt: totalInputTokens,
        completion: totalOutputTokens,
      },
    };
  }
}

module.exports = AgentProviderGpt41;
