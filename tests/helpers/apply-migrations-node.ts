import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
export function migrationStatements(dir = path.join(process.cwd(), 'migrations')): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(path.join(dir, f), 'utf8'))
    .flatMap((text) => text.split('--> statement-breakpoint'));
}
