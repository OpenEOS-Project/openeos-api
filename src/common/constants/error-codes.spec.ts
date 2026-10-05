import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { ErrorCodes, ErrorReasons } from './error-codes';

/*
 * Clients translate errors by `code` and `reason`. A thrown exception with
 * only a German text (or only a general code like NOT_FOUND) would show up
 * untranslated in the English UI, so every HTTP exception in src/ has to
 * name a code, and the general codes need a reason on top.
 */
const GENERAL_CODES = new Set<string>([
  ErrorCodes.VALIDATION_ERROR,
  ErrorCodes.NOT_FOUND,
  ErrorCodes.FORBIDDEN,
  ErrorCodes.UNAUTHORIZED,
  ErrorCodes.CONFLICT,
]);

/* Exceptions whose general code is the whole story. */
const ALLOWED_WITHOUT_REASON = [
  // generic body of the validation pipe; the fields are in `details`
  'common/pipes/validation.pipe.ts',
];

const SRC = path.resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
      ? [full]
      : [];
  });
}

function codeValue(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node)) return node.text;
  if (
    ts.isPropertyAccessExpression(node) &&
    node.expression.getText() === 'ErrorCodes'
  ) {
    return ErrorCodes[node.name.text as keyof typeof ErrorCodes];
  }
  return undefined;
}

describe('error codes', () => {
  it('reason values equal their keys', () => {
    for (const [key, value] of Object.entries(ErrorReasons)) {
      expect(value).toBe(key);
    }
  });

  it('every HTTP exception in src has a code (and a reason for general codes)', () => {
    const problems: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const relative = path.relative(SRC, file);
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );

      const visit = (node: ts.Node) => {
        if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          /Exception$/.test(node.expression.text) &&
          node.arguments?.length
        ) {
          const where = `${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
          const arg = node.arguments[0];
          if (!ts.isObjectLiteralExpression(arg)) {
            problems.push(`${where} has no code`);
          } else {
            const props = new Map<string, ts.Expression>();
            for (const prop of arg.properties) {
              if (ts.isPropertyAssignment(prop)) {
                props.set(prop.name.getText(), prop.initializer);
              }
            }
            const code = props.get('code');
            const value = code ? codeValue(code) : undefined;
            if (!value) {
              problems.push(`${where} has no code`);
            } else if (
              GENERAL_CODES.has(value) &&
              !props.has('reason') &&
              !ALLOWED_WITHOUT_REASON.includes(relative)
            ) {
              problems.push(`${where} uses ${value} without a reason`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(problems).toEqual([]);
  });
});
