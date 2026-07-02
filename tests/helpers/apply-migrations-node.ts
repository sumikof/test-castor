// 実体は src/storage/migrations-loader.ts。src/ が tests/ を import しない方針(逆方向は許容)を保つため、
// このファイルは既存の import パスを維持するための再エクスポートのみを行う。
export { migrationStatements } from '../../src/storage/migrations-loader';
