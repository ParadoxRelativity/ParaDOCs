import { z } from 'zod';

const uuid = z.string().uuid();
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb hex color');
/** YYYY-MM-DD, the wire format for journal dates and calendar filters. */
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

export const updateWorkspaceSchema = createWorkspaceSchema.partial();

export const createFolderSchema = z.object({
  name: z.string().min(1).max(120),
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

/** Roles that can be granted. 'owner' is only reachable by promotion from an owner. */
export const assignableRoleSchema = z.enum(['admin', 'editor', 'viewer']);
export const memberRoleSchema = z.enum(['owner', 'admin', 'editor', 'viewer']);

export const createInviteSchema = z.object({
  /** Omit for a shareable link that anyone with the token may redeem. */
  email: z.string().email().max(254).nullish(),
  role: assignableRoleSchema.default('editor'),
  expiresInDays: z.number().int().min(1).max(90).default(14),
});

export const updateMemberSchema = z.object({
  role: memberRoleSchema,
});

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
