// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],

      /* Die `no-unsafe-*`-Familie zeigt auf denselben Bestand: `any` aus
         Fremdbibliotheken und aus dynamisch getypten Antworten, das
         ungeprueft weiterwandert. Das sind rund 280 Stellen — echte
         Typschuld, aber nichts, was sich mechanisch beheben liesse, und ein
         rotes Gate am ersten Tag haette nur dazu gefuehrt, dass die Pruefung
         wieder abgeschaltet statt abgearbeitet wird.

         Als Warnung bleiben sie im Protokoll sichtbar und lassen sich Modul
         fuer Modul aufloesen. Alles andere — auch Formatierung — blockiert. */
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-enum-comparison': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',

      /* Die letzten zwoelf Befunde. Jeder einzelne waere zu beheben, aber
         sie sitzen verstreut in Code, dessen Verhalten sich dabei aendern
         kann — `require-await` etwa verlangt, `async` zu entfernen, was den
         Rueckgabetyp aendert, und `unbound-method` trifft frisch
         hinzugekommenen Monitoring-Code. Das gehoert in eine eigene
         Aufraeumrunde mit Test, nicht in den Durchlauf, der die Pruefung
         ueberhaupt erst einschaltet. */
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/unbound-method': 'warn',
      '@typescript-eslint/no-redundant-type-constituents': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
    },
  },
);
