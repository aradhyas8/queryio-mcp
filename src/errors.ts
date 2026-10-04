import pg from "pg";

/** A failed operation, in the structured form returned to agents. */
export class QueryError extends Error {
  constructor(
    readonly category: string,
    message: string,
    /** SQLSTATE for Postgres errors. */
    readonly code?: string,
    readonly hint?: string,
  ) {
    super(message);
  }

  toJSON() {
    return { category: this.category, code: this.code, message: this.message, hint: this.hint };
  }
}

// Conditions an agent should recognize at a glance; everything else is named by its SQLSTATE class.
const CONDITIONS: Record<string, string> = { "57014": "timeout", "55P03": "lock_timeout", "25006": "read_only" };

// PostgreSQL error classes (Appendix A of the PostgreSQL manual).
const CLASSES: Record<string, string> = {
  "01": "warning",
  "02": "no_data",
  "03": "sql_statement_not_yet_complete",
  "08": "connection_exception",
  "09": "triggered_action_exception",
  "0A": "feature_not_supported",
  "0B": "invalid_transaction_initiation",
  "0F": "locator_exception",
  "0L": "invalid_grantor",
  "0P": "invalid_role_specification",
  "0Z": "diagnostics_exception",
  "20": "case_not_found",
  "21": "cardinality_violation",
  "22": "data_exception",
  "23": "integrity_constraint_violation",
  "24": "invalid_cursor_state",
  "25": "invalid_transaction_state",
  "26": "invalid_sql_statement_name",
  "27": "triggered_data_change_violation",
  "28": "invalid_authorization_specification",
  "2B": "dependent_privilege_descriptors_still_exist",
  "2D": "invalid_transaction_termination",
  "2F": "sql_routine_exception",
  "34": "invalid_cursor_name",
  "38": "external_routine_exception",
  "39": "external_routine_invocation_exception",
  "3B": "savepoint_exception",
  "3D": "invalid_catalog_name",
  "3F": "invalid_schema_name",
  "40": "transaction_rollback",
  "42": "syntax_error_or_access_rule_violation",
  "44": "with_check_option_violation",
  "53": "insufficient_resources",
  "54": "program_limit_exceeded",
  "55": "object_not_in_prerequisite_state",
  "57": "operator_intervention",
  "58": "system_error",
  "72": "snapshot_failure",
  F0: "config_file_error",
  HV: "fdw_error",
  P0: "plpgsql_error",
  XX: "internal_error",
};

export function toQueryError(err: unknown): QueryError {
  if (err instanceof QueryError) return err;
  if (err instanceof pg.DatabaseError && err.code) {
    const category = CONDITIONS[err.code] ?? CLASSES[err.code.slice(0, 2)] ?? "postgres_error";
    return new QueryError(category, err.message, err.code, err.hint);
  }
  // Connection failures and other client-side errors carry no SQLSTATE.
  return new QueryError("client_error", err instanceof Error ? err.message : String(err));
}
