import { z } from 'zod';

export const LIMITS = {
  name: 100,            // 組織名・表示名・プロジェクト名・トークン名
  email: 254,
  title: 200,
  target: 512,
  gwt: 10_000,          // given / when / then 各
  parametersBytes: 100 * 1024,
  metadataBytes: 10 * 1024,
  observedBytes: 256 * 1024,
  repoUrl: 2_000,
  passwordMin: 8,
  passwordMax: 128,
  externalRef: 512,
  fingerprint: 512,
  origin: 128,
  bulkMax: 100,
} as const;

export const jsonByteMax = (max: number) => (v: unknown) =>
  new TextEncoder().encode(JSON.stringify(v)).length <= max;

export const nameSchema = z.string().min(1).max(LIMITS.name);
export const emailSchema = z.email().max(LIMITS.email);
export const passwordSchema = z.string().min(LIMITS.passwordMin).max(LIMITS.passwordMax);
export const originSchema = z.string().min(1).max(LIMITS.origin).regex(/^[a-z0-9\-_.]+$/);
export const printableAscii = (max: number) => z.string().min(1).max(max).regex(/^[\x20-\x7e]+$/);
export const repoUrlSchema = z.string().max(LIMITS.repoUrl).url().refine((u) => /^https?:\/\//.test(u), 'http/https のみ');
