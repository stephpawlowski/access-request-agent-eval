/**
 * The five tools available to the access-request agent, plus their execution functions.
 *
 * lookup_requester and check_policy are "real" tools: they run actual Node code (a directory
 * lookup, a call into the shared policy engine) and their results get fed back to the model as
 * a tool_result. The other three (ask_clarifying_question, escalate_to_human, respond_to_user)
 * are terminal actions: the provider records them and stops the loop instead of executing
 * anything or sending a result back.
 *
 * This file is required by providers/agent-provider.js and by scripts/validate-scenarios.js.
 */

const fs = require("fs");
const path = require("path");
const PolicyEngine = require("./docs/policy-engine.js");

const DIRECTORY = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "directory.json"), "utf8")
);

// ---------------------------------------------------------------------------------------
// Anthropic tool-use JSON schemas
// ---------------------------------------------------------------------------------------

const TOOL_SCHEMAS = [
  {
    name: "lookup_requester",
    description:
      "Look up an employee or contractor in the company directory by name, to find their " +
      "company, role, department, and offboarding status. Use this whenever a name is given " +
      "but you don't already know these facts. Do not guess them.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The person's name as given in the request." },
      },
      required: ["name"],
    },
  },
  {
    name: "check_policy",
    description:
      "Get the actual policy decision for an access request. This is the only source of truth " +
      "for APPROVE/DENY/ESCALATE decisions; never state a decision without calling this first. " +
      "All fields you already know should be filled in; leave a field out only if it genuinely " +
      "was never stated and there was no way to look it up.",
    input_schema: {
      type: "object",
      properties: {
        company: { type: "string", enum: ["fernwood", "meridian", "vertex"] },
        role: { type: "string" },
        department: { type: "string" },
        resource: { type: "string" },
        approvals: { type: "integer", description: "Number of prior approvals already obtained. Use 0 if not stated." },
        offboarding: { type: "boolean" },
        incidentActive: { type: "boolean", description: "Fernwood only: whether a security incident is currently declared active." },
        emergencyActive: { type: "boolean", description: "Meridian only: whether a clinical emergency is currently declared active." },
        directReport: { type: "boolean", description: "Fernwood only: whether the records requested belong to the requester's own direct report." },
      },
      required: ["company", "role", "department", "resource", "approvals", "offboarding"],
    },
  },
  {
    name: "ask_clarifying_question",
    description:
      "Ask the user a direct question because a fact needed to evaluate the request is missing " +
      "and could not be resolved by looking the requester up. This ends the turn; the user will " +
      "answer separately. Use this instead of guessing.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string" },
      },
      required: ["question"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand the request off to a human reviewer because the policy itself requires review, " +
      "regardless of any additional fact you could gather. Use this only after check_policy has " +
      "returned decision: 'ESCALATE'. This ends the turn.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
      },
      required: ["reason"],
    },
  },
  {
    name: "respond_to_user",
    description:
      "Give the user the final decision on their request, after check_policy has returned an " +
      "APPROVE or DENY decision. This ends the turn.",
    input_schema: {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["APPROVE", "DENY", "ESCALATE"] },
        message: { type: "string" },
      },
      required: ["decision", "message"],
    },
  },
];

// ---------------------------------------------------------------------------------------
// Execution functions
// ---------------------------------------------------------------------------------------

/**
 * Case-insensitive directory lookup.
 * Order of matching: exact full-name match first, then substring match against first or
 * last name. If the substring pass turns up more than one person, report it as ambiguous
 * rather than picking one.
 */
function lookupRequester({ name }) {
  const needle = String(name || "").trim().toLowerCase();
  if (!needle) {
    return { found: false };
  }

  const exact = DIRECTORY.filter((p) => p.name.toLowerCase() === needle);
  if (exact.length === 1) {
    return { found: true, ...exact[0] };
  }
  if (exact.length > 1) {
    return { found: false, ambiguous: true };
  }

  const substringMatches = DIRECTORY.filter((p) => {
    const parts = p.name.toLowerCase().split(/\s+/);
    const first = parts[0];
    const last = parts[parts.length - 1];
    return (
      first.includes(needle) ||
      needle.includes(first) ||
      last.includes(needle) ||
      needle.includes(last)
    );
  });

  if (substringMatches.length === 1) {
    return { found: true, ...substringMatches[0] };
  }
  if (substringMatches.length > 1) {
    return { found: false, ambiguous: true };
  }

  return { found: false };
}

/**
 * Runs the shared policy engine, with one special case carved out ahead of it: a Fernwood
 * Manager requesting Employee Records with directReport unspecified isn't a case the engine
 * needs to touch at all, it's a single missing fact the agent should just ask about, so it's
 * intercepted here before evaluate() ever runs.
 */
function checkPolicy(input) {
  const { company, role, department, resource, approvals, offboarding, incidentActive, emergencyActive, directReport } = input;

  if (
    resource === "Employee Records" &&
    company === "fernwood" &&
    role === "Manager" &&
    directReport === undefined
  ) {
    return {
      status: "needs_info",
      missingField: "direct_report",
      question: "Do the records requested belong to one of the requester's own direct reports?",
    };
  }

  const decision = PolicyEngine.evaluate(
    company,
    { role, department, resource, approvals, offboarding, incidentActive, emergencyActive, directReport },
    undefined
  );

  return { status: "ok", decision: decision.decision, rule: decision.rule, citation: decision.citation };
}

module.exports = {
  TOOL_SCHEMAS,
  lookupRequester,
  checkPolicy,
  DIRECTORY,
};
