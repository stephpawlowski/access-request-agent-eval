/**
 * A promptfoo custom provider that runs a real multi-turn, tool-using agent loop against the
 * Anthropic Messages API, instead of grading a single prompt-in/answer-out response like the
 * other two projects in this series do.
 *
 * Contract: https://www.promptfoo.dev/docs/providers/custom-api/
 * A provider is a class exposing id() and an async callApi(prompt, context, options), where
 * callApi returns { output } (output can be any JSON-serializable value; here it is a
 * stringified transcript object so the grading assertions in promptfooconfig.yaml can
 * JSON.parse it back out). callApi may also return `cost` and `tokenUsage` alongside `output`;
 * promptfoo records those in its own results bookkeeping, and this provider additionally folds
 * the same numbers into the output object itself (see costUsd/promptTokens/completionTokens
 * below) so the dashboard can read them back out of the parsed transcript directly. promptfoo
 * measures wall-clock latency (result.latencyMs) automatically for any provider; nothing here
 * needs to compute or return that.
 */

const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { TOOL_SCHEMAS, lookupRequester, checkPolicy } = require("../tools.js");

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "..", "system-prompt.txt"), "utf8");

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1024;
const MAX_NON_TERMINAL_TOOL_CALLS = 6;

// Claude Sonnet 5 pricing, per Anthropic's own pricing page, confirmed current as of August
// 2026: $2.00 per million input tokens, $10.00 per million output tokens. This is the standard
// rate, not a promotional or introductory one.
const INPUT_COST_PER_TOKEN = 2.0 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 10.0 / 1_000_000;

const TERMINAL_TOOLS = new Set(["ask_clarifying_question", "escalate_to_human", "respond_to_user"]);

// Real tools actually execute; terminal tools are handled by the loop itself, see below.
const EXECUTORS = {
  lookup_requester: (input) => lookupRequester(input),
  check_policy: (input) => checkPolicy(input),
};

class AgentProvider {
  id() {
    return "access-request-agent";
  }

  async callApi(prompt, context, options) {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const messages = [{ role: "user", content: prompt }];
    const toolCalls = []; // ordered list of non-terminal {name, input, result}
    const transcript = [{ role: "user", content: prompt }];

    let nonTerminalCallCount = 0;
    let finalAction = null;
    let finalActionInput = null;

    // Summed across every API call in this scenario's loop: a scenario can involve several
    // turns (lookup, then check_policy, then a terminal action), and the cost of the whole
    // trajectory is what matters, not just the last call.
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    while (true) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: TOOL_SCHEMAS,
        messages,
      });

      if (response.usage) {
        totalInputTokens += response.usage.input_tokens || 0;
        totalOutputTokens += response.usage.output_tokens || 0;
      }

      transcript.push({ role: "assistant", content: response.content });

      const toolUseBlocks = response.content.filter((block) => block.type === "tool_use");

      if (toolUseBlocks.length === 0) {
        // The model responded with plain text and no tool call at all. There is nothing
        // further to execute; stop the loop without a terminal action.
        finalAction = "max_turns_exceeded";
        break;
      }

      // Handle the first tool_use block found. In practice the system prompt asks for a
      // single action per turn, so this is the common case; if the model issues more than
      // one tool call in a single turn, only the first is acted on and the loop moves on.
      const block = toolUseBlocks[0];

      if (TERMINAL_TOOLS.has(block.name)) {
        finalAction = block.name;
        finalActionInput = block.input;
        break;
      }

      if (!EXECUTORS[block.name]) {
        // Unknown tool name; nothing sensible to execute, stop rather than loop forever.
        finalAction = "max_turns_exceeded";
        break;
      }

      if (nonTerminalCallCount >= MAX_NON_TERMINAL_TOOL_CALLS) {
        finalAction = "max_turns_exceeded";
        break;
      }

      const result = EXECUTORS[block.name](block.input);
      toolCalls.push({ name: block.name, input: block.input, result });
      nonTerminalCallCount += 1;

      messages.push({ role: "assistant", content: response.content });

      // Every tool_use block in this turn needs a matching tool_result before the next API
      // call, even ones we did not act on: only `block` (the first) is actually executed, but
      // if the model returned more than one tool_use block in this turn, the others still need
      // a tool_result or the API rejects the next request with "tool_use ids were found without
      // tool_result blocks immediately after". Unexecuted ones get a placeholder explaining why.
      const toolResultBlocks = toolUseBlocks.map((tb) =>
        tb.id === block.id
          ? { type: "tool_result", tool_use_id: tb.id, content: JSON.stringify(result) }
          : {
              type: "tool_result",
              tool_use_id: tb.id,
              content: JSON.stringify({
                skipped: true,
                reason: "Only one tool call is processed per turn; this call was not executed.",
              }),
            }
      );
      const toolResultMessage = { role: "user", content: toolResultBlocks };
      messages.push(toolResultMessage);
      transcript.push(toolResultMessage);
    }

    const totalTokens = totalInputTokens + totalOutputTokens;
    const costUsd = totalInputTokens * INPUT_COST_PER_TOKEN + totalOutputTokens * OUTPUT_COST_PER_TOKEN;

    // costUsd, promptTokens, and completionTokens are duplicated inside the output object
    // itself (not just returned via promptfoo's own `cost`/`tokenUsage` fields below), because
    // the dashboard's data-loading step reads back the parsed `output` JSON, not promptfoo's
    // internal bookkeeping.
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

module.exports = AgentProvider;
