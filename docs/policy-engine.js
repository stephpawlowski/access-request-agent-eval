/**
 * Multi-company access policy engine (v4).
 *
 * This is the single source of truth for the policy logic used in this project, across all
 * three fictional companies (Fernwood Systems, Meridian Health, Vertex Capital):
 *  - the test generator (scripts/generate-scenarios.js) uses this file to compute the expected
 *    decision and expected rule tag for every row in tests.csv
 *  - the live "try it yourself" simulator on the dashboard (docs/index.html) uses this exact
 *    same file, unmodified, to answer toggles instantly in the browser
 *
 * Keeping both on one file means the simulator and the eval's answer key can never drift out of
 * sync with each other, for any of the three companies.
 *
 * Every rule returns a company-prefixed rule tag (F1-F10 for Fernwood, M1-M8 for Meridian, V1-V8
 * for Vertex) instead of a bare number. That prefix is what lets the eval's grading tell apart
 * "the model reached the right decision" from "the model cited the right company's rule" from
 * "the model cited the exact right rule number", which are three different questions.
 *
 * Works in both Node (via require/module.exports) and the browser (via window.PolicyEngine).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PolicyEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  function result(decision, rule, citation) {
    return { decision, rule, citation };
  }

  // ---------------------------------------------------------------------------------------
  // Fernwood Systems (general corporate IAM, v2 policy carried forward from v3 unmodified)
  // ---------------------------------------------------------------------------------------

  const FERNWOOD_ROLES = ["Employee", "Contractor", "Intern", "Manager", "Admin"];
  const FERNWOOD_DEPARTMENTS = ["Engineering", "Finance", "Sales", "Support", "People", "Security"];
  const FERNWOOD_RESOURCES = [
    "Billing System", "Payroll System", "Financial Reports", "Customer PII", "Production Database",
    "Source Code Repository", "Employee Records", "Admin Console", "Vendor Contracts",
    "Incident Response Tools", "Other / Unlisted System",
  ];
  const FERNWOOD_FINANCE_SYSTEMS = ["Billing System", "Payroll System", "Financial Reports"];
  const FERNWOOD_DEFAULT_CONFIG = {
    r2ManagerApprovals: 2,
    r3IncidentApprovals: 1,
    r4OutsideApprovals: 1,
    r5EngineeringApprovals: 1,
    r6OutsideApprovals: 2,
    r7OutsideApprovals: 1,
    r8OutsideApprovals: 1,
    r10ApproveThreshold: 2,
  };

  function evaluateFernwood(input, config) {
    const cfg = Object.assign({}, FERNWOOD_DEFAULT_CONFIG, config || {});
    const { role, department, resource, approvals = 0, offboarding, incidentActive, directReport } = input;

    // Rule 1: offboarding override, checked first, overrides everything else.
    if (offboarding) {
      return result("DENY", "F1", "Rule F1 applies: accounts currently offboarding or already terminated are denied outright, regardless of role, department, or approvals.");
    }

    if (resource === "Admin Console") {
      if (role === "Admin") {
        return result("APPROVE", "F2", "Rule F2 applies: Admins have standing access to the Admin Console.");
      }
      if (role === "Manager" && approvals >= cfg.r2ManagerApprovals) {
        return result("ESCALATE", "F2", "Rule F2 applies: a Manager with two prior approvals is escalated for final review of the Admin Console, not auto-approved.");
      }
      return result("DENY", "F2", "Rule F2 applies: only Admins have standing Admin Console access, and this request has neither Admin standing nor a qualifying Manager approval count.");
    }

    if (resource === "Incident Response Tools") {
      if (department === "Security") {
        return result("APPROVE", "F3", "Rule F3 applies: Security team members have standing access to Incident Response Tools at all times.");
      }
      if (role === "Admin") {
        return result("APPROVE", "F3", "Rule F3 applies: Admins have standing access to Incident Response Tools at all times.");
      }
      if (incidentActive && approvals >= cfg.r3IncidentApprovals) {
        return result("APPROVE", "F3", "Rule F3 applies: during an active declared incident, non-Security staff with at least one prior approval are auto-approved for Incident Response Tools.");
      }
      if (incidentActive) {
        return result("ESCALATE", "F3", "Rule F3 applies: during an active declared incident, non-Security staff without a prior approval are escalated for expedited review.");
      }
      return result("DENY", "F3", "Rule F3 applies: outside an active incident, non-Security, non-Admin staff are denied Incident Response Tools access.");
    }

    if (FERNWOOD_FINANCE_SYSTEMS.indexOf(resource) !== -1) {
      if (department === "Finance" && role !== "Intern") {
        return result("APPROVE", "F4", "Rule F4 applies: Finance department staff have standing access to Finance-restricted systems.");
      }
      if (department === "Finance" && role === "Intern") {
        return result("ESCALATE", "F4", "Rule F4 applies: Finance interns need sign-off even within their own department, so this is escalated rather than auto-approved.");
      }
      if ((role === "Manager" || role === "Admin") && approvals >= cfg.r4OutsideApprovals) {
        return result("ESCALATE", "F4", "Rule F4 applies: outside Finance, a Manager or Admin with one prior approval is escalated pending further review.");
      }
      return result("DENY", "F4", "Rule F4 applies: outside Finance, without a qualifying Manager/Admin approval, access to Finance-restricted systems is denied.");
    }

    if (resource === "Customer PII") {
      if (department === "Support") {
        return result("APPROVE", "F5", "Rule F5 applies: Support has standing access to Customer PII for handling tickets.");
      }
      if (department === "Security") {
        return result("APPROVE", "F5", "Rule F5 applies: Security has standing access to Customer PII for investigations.");
      }
      if (department === "Engineering" && approvals >= cfg.r5EngineeringApprovals) {
        return result("ESCALATE", "F5", "Rule F5 applies: Engineering may access Customer PII for debugging with one prior approval, pending further review.");
      }
      return result("DENY", "F5", "Rule F5 applies: outside Support, Security, and approved Engineering debugging requests, Customer PII access is denied.");
    }

    if (resource === "Production Database") {
      if (department === "Engineering" && role === "Intern") {
        return result("DENY", "F6", "Rule F6 applies: Interns are denied Production Database access outright, a hard ceiling regardless of department.");
      }
      if (department === "Engineering" && role === "Contractor") {
        return result("ESCALATE", "F6", "Rule F6 applies: Contractors in Engineering require review before granting Production Database access.");
      }
      if (department === "Engineering") {
        return result("APPROVE", "F6", "Rule F6 applies: Employees, Managers, and Admins in Engineering have standing Production Database access.");
      }
      if (approvals >= cfg.r6OutsideApprovals) {
        return result("ESCALATE", "F6", "Rule F6 applies: outside Engineering, Production Database access may be escalated with two prior approvals.");
      }
      return result("DENY", "F6", "Rule F6 applies: outside Engineering without two prior approvals, Production Database access is denied.");
    }

    if (resource === "Source Code Repository") {
      if (department === "Engineering") {
        return result("APPROVE", "F7", "Rule F7 applies: Engineering has standing Source Code Repository access regardless of role, including Contractors and Interns on the team.");
      }
      if (role === "Contractor") {
        return result("DENY", "F7", "Rule F7 applies: Contractors outside Engineering are denied Source Code Repository access outright.");
      }
      if (approvals >= cfg.r7OutsideApprovals) {
        return result("ESCALATE", "F7", "Rule F7 applies: outside Engineering, Source Code Repository access may be escalated with one prior approval.");
      }
      return result("DENY", "F7", "Rule F7 applies: outside Engineering without a prior approval, Source Code Repository access is denied.");
    }

    if (resource === "Employee Records") {
      if (department === "People") {
        return result("APPROVE", "F8", "Rule F8 applies: People (HR) staff have standing access to Employee Records.");
      }
      if (role === "Manager" && directReport === true) {
        return result("APPROVE", "F8", "Rule F8 applies: a Manager has standing access to Employee Records for their own direct reports.");
      }
      if (role === "Manager" && directReport === undefined) {
        return result("ESCALATE", "F8", "Rule F8 applies: when it is not stated whether the records belong to the Manager's own direct report, this is escalated for clarification rather than assumed either way.");
      }
      if (role === "Admin") {
        return result("APPROVE", "F8", "Rule F8 applies: Admins have standing access to Employee Records.");
      }
      if (approvals >= cfg.r8OutsideApprovals) {
        return result("ESCALATE", "F8", "Rule F8 applies: without standing access, Employee Records requests may be escalated with one prior approval.");
      }
      return result("DENY", "F8", "Rule F8 applies: without standing access or a qualifying prior approval, Employee Records access is denied.");
    }

    if (resource === "Vendor Contracts") {
      if (department === "Finance") {
        return result("APPROVE", "F9", "Rule F9 applies: Finance has standing access to Vendor Contracts.");
      }
      if (department === "Sales" && (role === "Manager" || role === "Admin")) {
        return result("APPROVE", "F9", "Rule F9 applies: Managers and Admins within Sales have standing access to Vendor Contracts.");
      }
      if (department === "Sales") {
        return result("ESCALATE", "F9", "Rule F9 applies: other Sales staff may be escalated for Vendor Contracts access pending further review.");
      }
      return result("DENY", "F9", "Rule F9 applies: outside Finance and Sales, Vendor Contracts access is denied.");
    }

    // Rule 10: catch-all for anything not explicitly listed above.
    if (approvals >= cfg.r10ApproveThreshold) {
      return result("APPROVE", "F10", "Rule F10 applies: for an unlisted system, two or more prior approvals is approved under the catch-all.");
    }
    if (approvals === 1) {
      return result("ESCALATE", "F10", "Rule F10 applies: for an unlisted system, exactly one prior approval is escalated under the catch-all.");
    }
    return result("DENY", "F10", "Rule F10 applies: for an unlisted system with zero prior approvals, the catch-all denies the request.");
  }

  // ---------------------------------------------------------------------------------------
  // Meridian Health (fictional hospital system, HIPAA-flavored clinical-systems access)
  // ---------------------------------------------------------------------------------------

  const MERIDIAN_ROLES = ["Clinician", "Nurse", "Billing Coordinator", "IT Admin", "Compliance Officer"];
  const MERIDIAN_DEPARTMENTS = ["Clinical Care", "Billing", "IT", "Compliance", "Research"];
  const MERIDIAN_RESOURCES = [
    "Patient Records (EHR)", "Pharmacy System", "Billing/Claims System", "Lab Results",
    "Research Data Repository", "Audit Logs", "Other / Unlisted System",
  ];
  const MERIDIAN_DEFAULT_CONFIG = {
    m2EmergencyApprovals: 1,
    m3NurseApprovals: 1,
    m4OutsideApprovals: 2,
    m5ComplianceApprovals: 1,
    m6ClinicianApprovals: 2,
    m8ApproveThreshold: 999, // Meridian's catch-all deliberately has no auto-approve path at all.
  };

  function evaluateMeridian(input, config) {
    const cfg = Object.assign({}, MERIDIAN_DEFAULT_CONFIG, config || {});
    const { role, department, resource, approvals = 0, offboarding, emergencyActive } = input;

    // Rule 1: offboarding override, checked first, overrides everything else.
    if (offboarding) {
      return result("DENY", "M1", "Rule M1 applies: accounts currently offboarding or already terminated are denied outright, regardless of role, department, or approvals.");
    }

    if (resource === "Patient Records (EHR)") {
      if ((role === "Clinician" || role === "Nurse") && department === "Clinical Care") {
        return result("APPROVE", "M2", "Rule M2 applies: Clinicians and Nurses in Clinical Care have standing access to Patient Records for treatment purposes.");
      }
      if (role === "IT Admin") {
        return result("APPROVE", "M2", "Rule M2 applies: IT Admin has standing access to Patient Records for system maintenance.");
      }
      if (role === "Compliance Officer") {
        return result("APPROVE", "M2", "Rule M2 applies: the Compliance Officer has standing access to Patient Records for audits.");
      }
      if (role === "Clinician" && emergencyActive) {
        if (approvals >= cfg.m2EmergencyApprovals) {
          return result("APPROVE", "M2", "Rule M2 applies: under the break-glass emergency clause, a Clinician requesting Patient Records outside their normal assignment during an active clinical emergency is auto-approved with at least one prior approval.");
        }
        return result("ESCALATE", "M2", "Rule M2 applies: under the break-glass emergency clause, a Clinician requesting Patient Records outside their normal assignment during an active clinical emergency is escalated for expedited review without a prior approval.");
      }
      if (role === "Billing Coordinator" && approvals >= 1) {
        return result("ESCALATE", "M2", "Rule M2 applies: a Billing Coordinator may access Patient Records with one prior approval, escalated as scope-limited to billing purposes only.");
      }
      return result("DENY", "M2", "Rule M2 applies: without standing access, break-glass emergency grounds, or a qualifying Billing Coordinator approval, Patient Records access is denied.");
    }

    if (resource === "Pharmacy System") {
      if (role === "Clinician") {
        return result("APPROVE", "M3", "Rule M3 applies: Clinicians have standing access to the Pharmacy System.");
      }
      if (role === "Nurse" && approvals >= cfg.m3NurseApprovals) {
        return result("ESCALATE", "M3", "Rule M3 applies: a Nurse may access the Pharmacy System with one prior approval, escalated for review.");
      }
      if (role === "IT Admin") {
        return result("APPROVE", "M3", "Rule M3 applies: IT Admin has standing access to the Pharmacy System for maintenance.");
      }
      if (role === "Compliance Officer") {
        return result("APPROVE", "M3", "Rule M3 applies: the Compliance Officer has standing access to the Pharmacy System for audit purposes.");
      }
      return result("DENY", "M3", "Rule M3 applies: without standing access or a qualifying Nurse approval, Pharmacy System access is denied.");
    }

    if (resource === "Billing/Claims System") {
      if (role === "Billing Coordinator") {
        return result("APPROVE", "M4", "Rule M4 applies: Billing Coordinators have standing access to the Billing/Claims System.");
      }
      if (role === "Compliance Officer") {
        return result("APPROVE", "M4", "Rule M4 applies: the Compliance Officer has standing access to the Billing/Claims System for audit purposes.");
      }
      if (approvals >= cfg.m4OutsideApprovals) {
        return result("ESCALATE", "M4", "Rule M4 applies: without standing access, the Billing/Claims System may be escalated with two prior approvals.");
      }
      return result("DENY", "M4", "Rule M4 applies: without standing access or two prior approvals, Billing/Claims System access is denied.");
    }

    if (resource === "Lab Results") {
      if (role === "Clinician" || role === "Nurse") {
        return result("APPROVE", "M5", "Rule M5 applies: Clinicians and Nurses have standing access to Lab Results.");
      }
      if (role === "Billing Coordinator") {
        return result("DENY", "M5", "Rule M5 applies: Billing Coordinators are denied Lab Results access outright, a hard rule since it is never needed for billing.");
      }
      if (role === "Compliance Officer" && approvals >= cfg.m5ComplianceApprovals) {
        return result("ESCALATE", "M5", "Rule M5 applies: the Compliance Officer may access Lab Results with one prior approval, escalated for review.");
      }
      return result("DENY", "M5", "Rule M5 applies: without standing access or a qualifying Compliance Officer approval, Lab Results access is denied.");
    }

    if (resource === "Research Data Repository") {
      if (role === "Compliance Officer" || role === "IT Admin") {
        return result("APPROVE", "M6", "Rule M6 applies: the Compliance Officer and IT Admin have standing access to the Research Data Repository for data governance.");
      }
      if (role === "Clinician" && approvals >= cfg.m6ClinicianApprovals) {
        return result("ESCALATE", "M6", "Rule M6 applies: a Clinician may access the Research Data Repository with two prior approvals, representing IRB sign-off, escalated for review.");
      }
      return result("DENY", "M6", "Rule M6 applies: without standing access or a qualifying Clinician approval count, Research Data Repository access is denied.");
    }

    if (resource === "Audit Logs") {
      if (role === "Compliance Officer" || role === "IT Admin") {
        return result("APPROVE", "M7", "Rule M7 applies: the Compliance Officer and IT Admin have standing access to Audit Logs.");
      }
      return result("DENY", "M7", "Rule M7 applies: everyone else is denied Audit Logs access outright, with no escalate path, even with prior approvals.");
    }

    // Rule 8: catch-all. Deliberately no auto-approve path; healthcare policy is conservative by design.
    if (approvals >= 1) {
      return result("ESCALATE", "M8", "Rule M8 applies: for an unlisted system, one or more prior approvals is escalated under the catch-all.");
    }
    return result("DENY", "M8", "Rule M8 applies: for an unlisted system with zero prior approvals, the catch-all denies the request.");
  }

  // ---------------------------------------------------------------------------------------
  // Vertex Capital (fictional asset-management/trading firm, SOX/segregation-of-duties flavored)
  // ---------------------------------------------------------------------------------------

  const VERTEX_ROLES = ["Trader", "Portfolio Manager", "Compliance Officer", "Ops Analyst", "Admin"];
  const VERTEX_DEPARTMENTS = ["Trading Desk", "Portfolio Management", "Compliance", "Operations", "IT"];
  const VERTEX_RESOURCES = [
    "Trading System (Order Entry)", "Client Accounts", "Trade Blotter", "Model Risk Repository",
    "Regulatory Filings", "Audit Trail", "Other / Unlisted System",
  ];
  const VERTEX_DEFAULT_CONFIG = {
    v2OpsApprovals: 2,
    v3TraderApprovals: 1,
    v4OutsideApprovals: 1,
    v5PmApprovals: 1,
    v6PmApprovals: 2,
    v8ApproveThreshold: 2,
  };

  function evaluateVertex(input, config) {
    const cfg = Object.assign({}, VERTEX_DEFAULT_CONFIG, config || {});
    const { role, resource, approvals = 0, offboarding } = input;

    // Rule 1: offboarding override, checked first, overrides everything else.
    if (offboarding) {
      return result("DENY", "V1", "Rule V1 applies: accounts currently offboarding or already terminated are denied outright, regardless of role, department, or approvals.");
    }

    if (resource === "Trading System (Order Entry)") {
      if (role === "Trader" || role === "Portfolio Manager") {
        return result("APPROVE", "V2", "Rule V2 applies: Traders and Portfolio Managers have standing access to the Trading System.");
      }
      if (role === "Admin") {
        return result("APPROVE", "V2", "Rule V2 applies: Admin has standing access to the Trading System for system administration, not trading.");
      }
      if (role === "Compliance Officer") {
        return result("DENY", "V2", "Rule V2 applies: the Compliance Officer is denied Trading System access outright, a hard segregation-of-duties rule with no exceptions, since compliance staff can never place trades.");
      }
      if (role === "Ops Analyst" && approvals >= cfg.v2OpsApprovals) {
        return result("ESCALATE", "V2", "Rule V2 applies: an Ops Analyst may access the Trading System with two prior approvals, escalated for review.");
      }
      return result("DENY", "V2", "Rule V2 applies: without standing access or a qualifying Ops Analyst approval count, Trading System access is denied.");
    }

    if (resource === "Client Accounts") {
      if (role === "Portfolio Manager") {
        return result("APPROVE", "V3", "Rule V3 applies: Portfolio Managers have standing access to Client Accounts.");
      }
      if (role === "Ops Analyst") {
        return result("APPROVE", "V3", "Rule V3 applies: Ops Analyst has standing access to Client Accounts for servicing.");
      }
      if (role === "Compliance Officer") {
        return result("APPROVE", "V3", "Rule V3 applies: the Compliance Officer has standing access to Client Accounts for oversight.");
      }
      if (role === "Trader" && approvals >= cfg.v3TraderApprovals) {
        return result("ESCALATE", "V3", "Rule V3 applies: a Trader may access Client Accounts with one prior approval, escalated since Traders need visibility sometimes but not standing access.");
      }
      return result("DENY", "V3", "Rule V3 applies: without standing access or a qualifying Trader approval, Client Accounts access is denied.");
    }

    if (resource === "Trade Blotter") {
      if (role === "Compliance Officer" || role === "Ops Analyst" || role === "Trader" || role === "Portfolio Manager" || role === "Admin") {
        return result("APPROVE", "V4", "Rule V4 applies: Compliance Officer, Ops Analyst, Traders, Portfolio Managers, and Admin all have standing access to the Trade Blotter.");
      }
      if (approvals >= cfg.v4OutsideApprovals) {
        return result("ESCALATE", "V4", "Rule V4 applies: without standing access, the Trade Blotter may be escalated with one prior approval.");
      }
      return result("DENY", "V4", "Rule V4 applies: without standing access or a prior approval, Trade Blotter access is denied.");
    }

    if (resource === "Model Risk Repository") {
      if (role === "Compliance Officer") {
        return result("APPROVE", "V5", "Rule V5 applies: the Compliance Officer has standing access to the Model Risk Repository as part of their model validation duty.");
      }
      if (role === "Admin") {
        return result("APPROVE", "V5", "Rule V5 applies: Admin has standing access to the Model Risk Repository for hosting.");
      }
      if (role === "Trader") {
        return result("DENY", "V5", "Rule V5 applies: Traders are denied Model Risk Repository access outright, a hard segregation-of-duties rule, since Traders should not have direct access to the risk models governing their own limits.");
      }
      if (role === "Portfolio Manager" && approvals >= cfg.v5PmApprovals) {
        return result("ESCALATE", "V5", "Rule V5 applies: a Portfolio Manager may access the Model Risk Repository with one prior approval, escalated for review.");
      }
      return result("DENY", "V5", "Rule V5 applies: without standing access or a qualifying Portfolio Manager approval, Model Risk Repository access is denied.");
    }

    if (resource === "Regulatory Filings") {
      if (role === "Compliance Officer") {
        return result("APPROVE", "V6", "Rule V6 applies: the Compliance Officer has standing access to Regulatory Filings.");
      }
      if (role === "Admin") {
        return result("APPROVE", "V6", "Rule V6 applies: Admin has standing access to Regulatory Filings.");
      }
      if (role === "Portfolio Manager" && approvals >= cfg.v6PmApprovals) {
        return result("ESCALATE", "V6", "Rule V6 applies: a Portfolio Manager may access Regulatory Filings with two prior approvals, escalated for review.");
      }
      return result("DENY", "V6", "Rule V6 applies: everyone else is denied Regulatory Filings access, with no exceptions.");
    }

    if (resource === "Audit Trail") {
      if (role === "Compliance Officer" || role === "Admin") {
        return result("APPROVE", "V7", "Rule V7 applies: the Compliance Officer and Admin have standing access to the Audit Trail.");
      }
      return result("DENY", "V7", "Rule V7 applies: everyone else is denied Audit Trail access outright, with no escalate path.");
    }

    // Rule 8: catch-all.
    if (approvals >= cfg.v8ApproveThreshold) {
      return result("APPROVE", "V8", "Rule V8 applies: for an unlisted system, two or more prior approvals is approved under the catch-all.");
    }
    if (approvals === 1) {
      return result("ESCALATE", "V8", "Rule V8 applies: for an unlisted system, exactly one prior approval is escalated under the catch-all.");
    }
    return result("DENY", "V8", "Rule V8 applies: for an unlisted system with zero prior approvals, the catch-all denies the request.");
  }

  // ---------------------------------------------------------------------------------------
  // Dispatcher
  // ---------------------------------------------------------------------------------------

  const EVALUATORS = {
    fernwood: evaluateFernwood,
    meridian: evaluateMeridian,
    vertex: evaluateVertex,
  };

  function evaluate(company, input, config) {
    const fn = EVALUATORS[company];
    if (!fn) {
      throw new Error("Unknown company: " + company + " (expected fernwood, meridian, or vertex)");
    }
    return fn(input, config);
  }

  return {
    evaluate: evaluate,
    COMPANIES: ["fernwood", "meridian", "vertex"],
    COMPANY_LABELS: {
      fernwood: "Fernwood Systems",
      meridian: "Meridian Health",
      vertex: "Vertex Capital",
    },
    RULE_PREFIX: { fernwood: "F", meridian: "M", vertex: "V" },
    ROLES: { fernwood: FERNWOOD_ROLES, meridian: MERIDIAN_ROLES, vertex: VERTEX_ROLES },
    DEPARTMENTS: { fernwood: FERNWOOD_DEPARTMENTS, meridian: MERIDIAN_DEPARTMENTS, vertex: VERTEX_DEPARTMENTS },
    RESOURCES: { fernwood: FERNWOOD_RESOURCES, meridian: MERIDIAN_RESOURCES, vertex: VERTEX_RESOURCES },
    FINANCE_SYSTEMS: FERNWOOD_FINANCE_SYSTEMS,
    DEFAULT_CONFIG: {
      fernwood: FERNWOOD_DEFAULT_CONFIG,
      meridian: MERIDIAN_DEFAULT_CONFIG,
      vertex: VERTEX_DEFAULT_CONFIG,
    },
  };
});
