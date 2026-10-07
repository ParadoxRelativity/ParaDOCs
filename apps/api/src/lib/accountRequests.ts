/**
 * SQL for the request standing on an account (see migration 0040): who asked,
 * as an `AccountActor` (packages/shared/src/types.ts), and how to clear it.
 * Each takes the alias the users table goes by.
 */

/** The team lead behind a request, or NULL when the person asked themselves. */
export function requesterSql(u: string): string {
  return `CASE WHEN ${u}.account_requested_by_lead THEN json_build_object(
    'id', ${u}.account_requested_by,
    'name', COALESCE(${u}.account_requested_by_name, 'A team lead'),
    'workspaceName', ${u}.account_requested_workspace_name) END`;
}

/** SET clause that removes a request entirely. */
export const CLEAR_ACCOUNT_REQUEST = `account_request = NULL,
  account_requested_at = NULL,
  account_request_note = NULL,
  account_requested_by_lead = false,
  account_requested_by = NULL,
  account_requested_by_name = NULL,
  account_requested_workspace_name = NULL,
  account_member_note = NULL`;
