import type { ApiResponseOptions } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

/** Schema der `meta`-Angaben einer seitenweisen Antwort (PaginationMeta). */
export const PAGINATION_META_SCHEMA: SchemaObject = {
  type: 'object',
  description: 'Seitenangaben',
  properties: {
    page: { type: 'integer', example: 1 },
    limit: { type: 'integer', example: 20 },
    total: { type: 'integer', description: 'Treffer insgesamt', example: 2 },
    totalPages: { type: 'integer', example: 1 },
    hasNext: { type: 'boolean', example: false },
    hasPrev: { type: 'boolean', example: false },
  },
};

/**
 * Antwort einer Listen-Operation mit `data` und `meta` (siehe
 * createPaginatedResult), samt Beispiel fuer die Referenz.
 */
export function paginatedResponse(
  description: string,
  items: Record<string, unknown>[],
  limit = 20,
): ApiResponseOptions {
  return {
    status: 200,
    description,
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object' } },
        meta: PAGINATION_META_SCHEMA,
      },
    },
    example: {
      data: items,
      meta: {
        page: 1,
        limit,
        total: items.length,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    },
  };
}
