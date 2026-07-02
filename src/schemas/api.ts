import { z } from 'zod';
import { CATEGORIES, STATUSES, ROLES, BULK_ACTIONS, OWNERSHIPS } from './enums';
import { nameSchema, emailSchema, passwordSchema, repoUrlSchema, LIMITS } from './limits';
import { parametersSchema, metadataSchema, sourceRefSchema, confidenceSchema } from './entities';

export const setupInput = z.object({
  organization_name: nameSchema,
  admin_email: emailSchema,
  admin_password: passwordSchema,
  admin_display_name: nameSchema,
});
export const loginInput = z.object({ email: emailSchema, password: z.string().min(1).max(LIMITS.passwordMax) });
export const changePasswordInput = z.object({ current_password: z.string().min(1), new_password: passwordSchema });
export const createUserInput = z.object({ email: emailSchema, password: passwordSchema, display_name: nameSchema, role: z.enum(ROLES) });
export const patchUserInput = z.object({ role: z.enum(ROLES).optional(), display_name: nameSchema.optional() });
export const resetPasswordInput = z.object({ new_password: passwordSchema });
export const createProjectInput = z.object({ name: nameSchema, repo_url: repoUrlSchema.optional() });
export const patchProjectInput = z.object({ name: nameSchema.optional(), repo_url: repoUrlSchema.nullable().optional() });
export const createTokenInput = z.object({ name: nameSchema });

export const createTestCaseInput = z.object({
  title: z.string().min(1).max(LIMITS.title),
  target: z.string().max(LIMITS.target).optional(),
  category: z.enum(CATEGORIES),
  given: z.string().min(1).max(LIMITS.gwt),
  when: z.string().min(1).max(LIMITS.gwt),
  then: z.string().min(1).max(LIMITS.gwt),
  parameters: parametersSchema.optional(),
  status: z.enum(STATUSES).default('draft'),
  confidence: confidenceSchema.optional(),
  source_ref: sourceRefSchema.optional(),
  metadata: metadataSchema.optional(),
});
// PATCH: キー未指定=不変 / null=クリア(api-reference.md「PATCH セマンティクス」)
export const patchTestCaseInput = z.object({
  title: z.string().min(1).max(LIMITS.title).optional(),
  target: z.string().max(LIMITS.target).nullable().optional(),
  category: z.enum(CATEGORIES).optional(),
  given: z.string().min(1).max(LIMITS.gwt).optional(),
  when: z.string().min(1).max(LIMITS.gwt).optional(),
  then: z.string().min(1).max(LIMITS.gwt).optional(),
  parameters: parametersSchema.nullable().optional(),
  status: z.enum(STATUSES).optional(),
  confidence: confidenceSchema.nullable().optional(),
  source_ref: sourceRefSchema.nullable().optional(),
  metadata: metadataSchema.nullable().optional(),
});
export const bulkInput = z.object({
  ids: z.array(z.string().min(1)).min(1).max(LIMITS.bulkMax),
  action: z.enum(BULK_ACTIONS),
});
const boolParam = z.enum(['true', 'false']).transform((v) => v === 'true');
export const listTestCasesQuery = z.object({
  status: z.enum(STATUSES).optional(),
  category: z.enum(CATEGORIES).optional(),
  ownership: z.enum(OWNERSHIPS).optional(),
  drift: boolParam.optional(),
  is_stale: boolParam.optional(),
  target: z.string().max(LIMITS.target).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const pageQuery = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
