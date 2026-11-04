import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { expect, test } from 'vitest';

// the names a public entry file re-exports, in source order
const readExportedNames = async (entry: URL): Promise<string[]> => {
  const source = ts.createSourceFile(
    entry.pathname,
    await readFile(entry, 'utf8'),
    ts.ScriptTarget.Latest,
  );
  return source.statements.flatMap((statement) =>
    ts.isExportDeclaration(statement) &&
    statement.exportClause &&
    ts.isNamedExports(statement.exportClause)
      ? statement.exportClause.elements.map((element) => element.name.text)
      : [],
  );
};

test('the API reference lists every export of both public entry points', async () => {
  const reference = await readFile(new URL('../api/README.md', import.meta.url), 'utf8');
  const exportsSection = reference.split('\n## Exports\n')[1]!.split('\n## ')[0]!;
  const names = [
    ...(await readExportedNames(new URL('./index.ts', import.meta.url))),
    ...(await readExportedNames(new URL('./contracts/index.ts', import.meta.url))),
  ];
  expect(names.length).toBeGreaterThan(0);
  expect(names.filter((name) => !exportsSection.includes(`\`${name}\``))).toStrictEqual([]);
});
