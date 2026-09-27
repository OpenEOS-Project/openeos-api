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
      "prettier/prettier": ["error", { endOfLine: "auto" }],

      /* Die `no-unsafe-*`-Familie und die uebrigen typgestuetzten Regeln
         blockieren wieder (#17). Beim Einschalten der Pruefung standen sie
         auf Warnung — rund 380 Befunde, meist `any` aus Fremdbibliotheken
         und untypisierten Antworten. Die sind abgearbeitet; ab jetzt faellt
         ein umbenanntes Feld im Build auf statt als `undefined` in
         Produktion.

         Wo eine Bibliothek selbst keinen brauchbaren Typ liefert (das
         SumUp-SDK, `IoAdapter.createIOServer`), steht genau ein
         kommentierter Cast an der Grenze — nicht verstreut im Code. */

      /* Ein fuehrender Unterstrich markiert Absicht: Parameter, die eine
         Schnittstelle vorgibt (`down(_queryRunner)`), und Felder, die per
         Rest-Destrukturierung bewusst weggelassen werden. */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
);
