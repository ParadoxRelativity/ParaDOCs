import { z } from 'zod';
import { WORKSPACE_PERMISSIONS } from './permissions.js';

/** The most of each kind a picker's search returns. */
export const MAX_LINK_TARGETS = 50;

/** A document a picker offers: enough to show it and point at it. */
export interface DocumentLinkTarget {
  id: string;
  title: string;
  icon: string | null;
  mode: 'page' | 'canvas';
}

/** A spreadsheet a picker offers. */
export interface SpreadsheetLinkTarget {
  id: string;
  title: string;
  icon: string | null;
}

export interface LinkTargets {
  documents: DocumentLinkTarget[];
  spreadsheets: SpreadsheetLinkTarget[];
}

const uuid = z.string().uuid();
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb hex color');
/** YYYY-MM-DD, the wire format for calendar filters and due dates. */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

export const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(10, 'password must be at least 10 characters').max(200),
  name: z.string().min(1).max(80),
});

export const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

export const updateProfileSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    email: z.string().email().max(254).optional(),
    /** Needed to change the email, by accounts that have a password. */
    currentPassword: z.string().max(200).optional(),
  })
  .refine((v) => v.name !== undefined || v.email !== undefined, {
    message: 'Nothing to update',
  });

export const changePasswordSchema = z.object({
  /** Omitted only by accounts that have no password yet. */
  currentPassword: z.string().max(200).optional(),
  newPassword: z.string().min(10, 'password must be at least 10 characters').max(200),
});

export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(80),
  icon: z.string().max(16).nullish(),
});

export const workspaceAppSchema = z.enum(['docs', 'sheets', 'chat', 'projects']);

export const updateWorkspaceSchema = createWorkspaceSchema.partial().extend({
  /** The apps to have on. Anything left out is turned off; Access always stays on. */
  apps: z
    .array(workspaceAppSchema)
    .min(1, 'Keep at least one app turned on')
    .max(4)
    .optional(),
});

export const folderAppSchema = z.enum(['docs', 'sheets']);

export const createFolderSchema = z.object({
  name: z.string().min(1).max(120),
  /** Which tree the folder goes in. Documents, unless it says otherwise. */
  app: folderAppSchema.default('docs'),
  icon: z.string().max(16).nullish(),
  parentId: uuid.nullish(),
  position: z.number().int().nullish(),
});

export const updateFolderSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  /** Pass null to clear the icon; omit to leave it unchanged. */
  icon: z.string().max(16).nullish(),
  parentId: uuid.nullish(),
  position: z.number().int().optional(),
});

export const documentModeSchema = z.enum(['page', 'canvas']);

export const createDocumentSchema = z.object({
  title: z.string().max(300).optional(),
  mode: documentModeSchema.optional(),
  folderId: uuid.nullish(),
  icon: z.string().max(16).nullish(),
  body: z.array(z.unknown()).optional(),
  tagIds: z.array(uuid).optional(),
});

export const updateDocumentSchema = z.object({
  title: z.string().max(300).optional(),
  mode: documentModeSchema.optional(),
  folderId: uuid.nullish(),
  icon: z.string().max(16).nullish(),
  body: z.array(z.unknown()).optional(),
  /** Markdown rendered by the client from `body`; the server trusts it only for search. */
  bodyMd: z.string().optional(),
  properties: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  archived: z.boolean().optional(),
  tagIds: z.array(uuid).optional(),
});

export const createInviteSchema = z.object({
  /** Omit for a shareable link that anyone with the token may redeem. */
  email: z.string().email().max(254).nullish(),
  /** A workspace role, but never Owner. Omit for the workspace's default role. */
  roleId: uuid.optional(),
  expiresInDays: z.number().int().min(1).max(90).default(14),
});

export const updateMemberSchema = z.object({
  roleId: uuid,
});

const workspacePermissionSchema = z.enum(WORKSPACE_PERMISSIONS);

export const createWorkspaceRoleSchema = z.object({
  name: z.string().trim().min(1, 'Name the role').max(40),
  description: z.string().trim().max(200).default(''),
  permissions: z.array(workspacePermissionSchema).max(WORKSPACE_PERMISSIONS.length).default([]),
  /** Another role to start from. Its permissions are used when none are given. */
  copyFrom: uuid.optional(),
});

export const updateWorkspaceRoleSchema = z.object({
  name: z.string().trim().min(1, 'Name the role').max(40).optional(),
  description: z.string().trim().max(200).optional(),
  permissions: z.array(workspacePermissionSchema).max(WORKSPACE_PERMISSIONS.length).optional(),
  /** True makes this the role new invites start with. */
  isDefault: z.literal(true).optional(),
  position: z.number().int().min(0).optional(),
});

/** The colours a tag can be given, cycled through for new ones. */
export const TAG_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6'];

export const createTagSchema = z.object({
  name: z.string().min(1).max(50),
  color: hexColor.optional(),
});

export const updateTagSchema = createTagSchema.partial();

export const searchQuerySchema = z.object({
  q: z.string().max(200).optional(),
  tags: z.array(uuid).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  folderId: uuid.optional(),
  includeArchived: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * What a picker asks for as someone types a name: documents and spreadsheets
 * whose titles match, those starting with it first, then the most recently
 * touched. With nothing typed, the most recently touched. Pickers ask the
 * server rather than filtering a list they hold, since a workspace can have
 * more of either than any list it would send.
 */
export const linkTargetsQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  /** Comma-separated: `documents`, `spreadsheets`, or both. */
  kinds: z.string().max(40).default('documents,spreadsheets'),
  limit: z.coerce.number().int().min(1).max(MAX_LINK_TARGETS).default(20),
});

export const createCommentSchema = z.object({
  body: z.string().min(1).max(10_000),
  blockId: z.string().max(120).nullish(),
  parentId: uuid.nullish(),
});

export const updateCommentSchema = z.object({
  body: z.string().min(1).max(10_000).optional(),
  resolved: z.boolean().optional(),
});

export const createEventSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).nullish(),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }).nullish(),
  allDay: z.boolean().optional(),
  color: hexColor.optional(),
  documentId: uuid.nullish(),
});

export const updateEventSchema = createEventSchema.partial();

export type RegisterInput = z.infer<typeof registerSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type CreateFolderInput = z.infer<typeof createFolderSchema>;
export type UpdateFolderInput = z.infer<typeof updateFolderSchema>;
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;
export type CreateTagInput = z.infer<typeof createTagSchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type CreateEventInput = z.infer<typeof createEventSchema>;

// --- access ------------------------------------------------------------------

export const accessModeSchema = z.enum(['inherit', 'open', 'allow', 'deny']);
export const permissionSchema = z.enum(['none', 'view', 'edit']);

const accessEntryInputSchema = z
  .object({ teamId: uuid.optional(), userId: uuid.optional(), permission: permissionSchema })
  .refine((entry) => Boolean(entry.teamId) !== Boolean(entry.userId), 'Each entry names one team or one person');

/**
 * A folder's, document's or channel's access. Entries only mean anything on an
 * allow or deny list, and are dropped otherwise, so switching a lock off and on
 * again in the dialog does not have to clear what was listed.
 */
export const updateAccessSchema = z
  .object({ access: accessModeSchema, entries: z.array(accessEntryInputSchema).max(500).default([]) })
  .superRefine((value, ctx) => {
    if (value.access !== 'allow' && value.access !== 'deny') return;
    const seen = new Set<string>();
    value.entries.forEach((entry, index) => {
      const subject = entry.teamId ?? entry.userId ?? '';
      const issue = (message: string) =>
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', index], message });
      if (seen.has(subject)) issue('The same team or person is listed twice');
      seen.add(subject);
      if (value.access === 'allow' && entry.permission === 'none') issue('An allow list gives view or edit access');
      if (value.access === 'deny' && entry.permission === 'edit') issue('A deny list can only take access away');
    });
  });

export const createTeamSchema = z.object({
  name: z.string().trim().min(1, 'Name the team').max(60),
  memberIds: z.array(uuid).max(1000).default([]),
});

export const updateTeamSchema = z.object({
  name: z.string().trim().min(1, 'Name the team').max(60).optional(),
  /** The whole membership, replacing what was there. */
  memberIds: z.array(uuid).max(1000).optional(),
});

/** Every team one member is on, replacing what was there. */
export const updateMemberTeamsSchema = z.object({
  teamIds: z.array(uuid).max(1000),
});

export type UpdateAccessInput = z.infer<typeof updateAccessSchema>;

// --- spreadsheets ------------------------------------------------------------

export const createSpreadsheetSchema = z.object({
  title: z.string().trim().max(200).optional(),
  icon: z.string().trim().max(8).nullish(),
  /** A spreadsheets folder to file it in. */
  folderId: uuid.nullish(),
});

export const updateSpreadsheetSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  icon: z.string().trim().max(8).nullish(),
  archived: z.boolean().optional(),
  /** Pass null to take it out of its folder; omit to leave it where it is. */
  folderId: uuid.nullish(),
});
