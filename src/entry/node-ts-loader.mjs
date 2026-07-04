// src/entry/node-ts-loader.mjs
// なぜ存在するか(task-23「Node エントリ」): src/ 配下は tsconfig.json の "moduleResolution":"Bundler"
// を前提に、相対 import を拡張子なしで書く(例: `from '../http/config'`。wrangler/vite/vitest 等の
// バンドラ系ツールはこれを解決できる)。だが Node の素の ESM ローダは以下の2点を単独ではサポートしない:
//   1. 相対パスの拡張子省略解決(`--experimental-strip-types` を付けても不変。型除去とモジュール解決は
//      別問題)。
//   2. `.tsx`(JSX)ファイルの読み込みそのもの(`ERR_UNKNOWN_FILE_EXTENSION`。Node の型除去機能は
//      TypeScript の「型注釈の削除」のみを行い、JSX 構文の変換は行わない別問題のため)。
// src/http/ui/*.tsx(Hono JSX SSR)を経由する node エントリ(src/entry/node.ts)を素の Node で
// 直接実行するには、この2点を両方解決する必要がある。
//
// GC-7(依存追加禁止)を満たすため、新規パッケージは一切追加せず、既存の devDependency
// `typescript`(package.json に既存)の `ts.transpileModule`(型除去 + JSX 変換を1ファイル単位で行う。
// tsconfig.json の compilerOptions をそのまま読み込むため設定の二重管理をしない)を使う、
// Node 組み込みの module customization hooks API(node:module の registerHooks)のみで構成する
// 最小限のオンザフライ変換ローダ。
//
// 使用箇所: package.json の start:node / maintenance:node スクリプトが
// `node --import ./src/entry/node-ts-loader.mjs <entry>` として使う(`--experimental-strip-types` は
// 不要 — .ts/.tsx の変換は本ローダの load フックが tsc 経由で完結させるため)。
// 対象は明示的にリポジトリ内の相対 import・.ts/.tsx ファイルのみ(node_modules 配下のパッケージは
// 既にビルド済み .js/.mjs のため本ローダのどちらのフックにも一致せず無関係)。
// このファイル自体は素の JS(型を持たない)であるため、フック登録前に型除去/変換を必要としない。
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// tsconfig.json の compilerOptions を single source of truth として読み込む(jsx/jsxImportSource/
// target/module 等をここに再度ハードコードして二重管理・drift させないため)。
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const tsconfigPath = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
const configFile = ts.readConfigFile(tsconfigPath, (path) => readFileSync(path, 'utf8'));
const { options: compilerOptions } = ts.convertCompilerOptionsFromJson(configFile.config.compilerOptions, projectRoot);

// 相対 specifier(`./` または `../` で始まる)かつ、末尾に既存の拡張子(`.xxx`)を持たないものだけを対象にする。
const RELATIVE_NO_EXTENSION = /^\.\.?\//;
const HAS_EXTENSION = /\.[a-zA-Z0-9]+$/;
const TS_LIKE = /\.tsx?$/;
const EXTENSION_CANDIDATES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

registerHooks({
  // 拡張子省略の相対 import を .ts → .tsx → ディレクトリ index(.ts/.tsx)の順に試し、
  // 最初に解決できたものを採用する。すべて失敗すれば通常解決(nextResolve)にそのまま委ねるため、
  // 拡張子が既にある import や bare specifier(パッケージ名)の解決には一切影響しない。
  resolve(specifier, context, nextResolve) {
    if (RELATIVE_NO_EXTENSION.test(specifier) && !HAS_EXTENSION.test(specifier)) {
      for (const suffix of EXTENSION_CANDIDATES) {
        try {
          return nextResolve(`${specifier}${suffix}`, context);
        } catch {
          // 次の候補を試す
        }
      }
    }
    return nextResolve(specifier, context);
  },
  // .ts/.tsx を tsc の transpileModule(型除去 + JSX 変換。型チェックはしない = tsx/esbuild と同じ
  // 「transpile only」流儀。全体の型チェックは npm run typecheck の責務のまま)でロードする。
  load(url, context, nextLoad) {
    if (TS_LIKE.test(url)) {
      const path = fileURLToPath(url);
      const source = readFileSync(path, 'utf8');
      const { outputText, diagnostics } = ts.transpileModule(source, {
        // HANDOVER D2: inline sourcemap を埋め込み、`node --enable-source-maps`(package.json の
        // start:node / maintenance:node に設定済み)でスタックトレースを .ts の元行番号に写像する。
        // tsconfig は noEmit:true のため sourceMap 系はここでだけ上書きする(tsc --noEmit は
        // sourceMap オプションと併用不可)。
        compilerOptions: { ...compilerOptions, sourceMap: false, inlineSourceMap: true, inlineSources: true },
        fileName: path, reportDiagnostics: true,
      });
      // HANDOVER D1: transpile 段階の構文エラー(や isolatedModules 非互換)を、後段の不明瞭な
      // ランタイム SyntaxError にせず、ファイル名・行番号付きの診断メッセージで即座に落とす。
      if (diagnostics && diagnostics.length > 0) {
        const message = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
          getCurrentDirectory: () => projectRoot,
          getCanonicalFileName: (f) => f,
          getNewLine: () => '\n',
        });
        throw new Error(`node-ts-loader: TypeScript transpile diagnostics for ${path}\n${message}`);
      }
      return { format: 'module', shortCircuit: true, source: outputText };
    }
    return nextLoad(url, context);
  },
});
