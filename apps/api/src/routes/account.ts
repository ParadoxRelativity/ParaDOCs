import type { FastifyPluginAsync } from 'fastify';
import { accountMemberNoteSchema, requestAccountDeletionSchema, type AccountRequestStatus } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { badRequest, forbidden, parse } from '../lib/http.js';
import { notifyServerAdmins } from '../lib/serverAdmins.js';
import { CLEAR_ACCOUNT_REQUEST, requesterSql } from '../lib/accountRequests.js';
import { confirmPassword } from './auth.js';

/**
 * Asking for your own account to be deleted, which both app stores require an
 * app to offer.
 *
 * Nothing is deleted here. Deleting an account also deletes the workspaces it
 * created, and one other people still use has to be handed over first, which
 * is the server administrators' call. So the request is recorded, every
 * administrator is told through their notifications, and they act on it from
 * the admin page, where the account is flagged until they do.
 *
 * A team lead can also ask for someone's account to be disabled or deleted
 * (routes/teamAccounts.ts). The person is told, can add a note for the
 * administrators, and cannot withdraw it: only an administrator can set a
 * lead's request aside.
 */
export const accountRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  async function status(userId: string): Promise<AccountRequestStatus> {
    const { rows } = await query<AccountRequestStatus>(
      `SELECT u.account_request AS kind, u.account_requested_at AS "requestedAt", u.account_request_note AS note,
              u.password_hash IS NOT NULL AS "hasPassword",
              ${requesterSql('u')} AS "requestedBy",
              u.account_member_note AS "memberNote"
         FROM users u WHERE u.id = $1`,
      [userId],
    );
    return rows[0];
  }

  /** What a team lead has asked about this account, if anything. */
  async function leadRequest(userId: string): Promise<'delete' | 'disable' | null> {
    const { rows } = await query<{ kind: 'delete' | 'disable' | null }>(
      'SELECT CASE WHEN account_requested_by_lead THEN account_request END AS kind FROM users WHERE id = $1',
      [userId],
    );
    return rows[0]?.kind ?? null;
  }

  app.get('/account/deletion-request', async (req): Promise<AccountRequestStatus> => status(req.user!.id));

  app.post('/account/deletion-request', async (req): Promise<AccountRequestStatus> => {
    const user = req.user!;
    const input = parse(requestAccountDeletionSchema, req.body ?? {});
    // As with a password change: a session left open on someone else's screen
    // is not enough to ask for an account to go.
    await confirmPassword(user.id, input.password);

    const lead = await leadRequest(user.id);
    if (lead === 'delete') {
      // A team lead already asked for the same. Agreeing adds to it rather than
      // replacing it, so who asked first stays on the record.
      await query('UPDATE users SET account_member_note = COALESCE($2, account_member_note) WHERE id = $1', [
        user.id,
        input.note || null,
      ]);
    } else if (lead === 'disable') {
      // Asking for more than the lead did: it becomes the person's own request.
      await query(
        `UPDATE users
            SET account_request = 'delete', account_requested_at = now(), account_request_note = $2,
                account_requested_by_lead = false, account_requested_by = NULL, account_requested_by_name = NULL,
                account_requested_workspace_name = NULL, account_member_note = NULL
          WHERE id = $1`,
        [user.id, input.note || null],
      );
    } else {
      // Asking again keeps the original date, so the request does not seem
      // newer than it is, but takes the latest note.
      await query(
        `UPDATE users
            SET account_request = 'delete',
                account_requested_at = COALESCE(account_requested_at, now()),
                account_request_note = $2
          WHERE id = $1`,
        [user.id, input.note || null],
      );
    }
    req.log.info({ userId: user.id }, 'account deletion requested');
    await notifyServerAdmins();
    return status(user.id);
  });

  /** Your side of a team lead's request: what you want the administrators to know. */
  app.put('/account/deletion-request/note', async (req): Promise<AccountRequestStatus> => {
    const user = req.user!;
    const input = parse(accountMemberNoteSchema, req.body ?? {});
    if (!(await leadRequest(user.id))) throw badRequest('Nobody has asked the administrators about your account');
    await query('UPDATE users SET account_member_note = $2 WHERE id = $1', [user.id, input.note || null]);
    req.log.info({ userId: user.id }, 'note added to a team lead’s account request');
    await notifyServerAdmins();
    return status(user.id);
  });

  app.delete('/account/deletion-request', async (req): Promise<AccountRequestStatus> => {
    const user = req.user!;
    if (await leadRequest(user.id)) {
      throw forbidden(
        'A team lead made this request, so only a server administrator can set it aside. Add a note for them instead.',
      );
    }
    const { rowCount } = await query(
      `UPDATE users SET ${CLEAR_ACCOUNT_REQUEST} WHERE id = $1 AND account_requested_at IS NOT NULL`,
      [user.id],
    );
    if (rowCount) {
      req.log.info({ userId: user.id }, 'account deletion request cancelled');
      await notifyServerAdmins();
    }
    return status(user.id);
  });
};
