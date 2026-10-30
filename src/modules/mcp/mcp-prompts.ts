import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Gefuehrte Ablaeufe als MCP-Prompts. Der Text geht an das Modell und
 * ist deshalb Englisch; was es dem Menschen sagt, soll Deutsch sein.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'setup_event',
    {
      title: 'Veranstaltung einrichten',
      description:
        'Guided setup of a new event: event, categories, products, stations, tables, helper schedule — each step previewed before it is applied.',
      argsSchema: {
        eventName: z
          .string()
          .describe('Name of the event, e.g. "Sommerfest 2026"'),
        date: z
          .string()
          .optional()
          .describe('Start date YYYY-MM-DD (and optional end date)'),
        notes: z
          .string()
          .optional()
          .describe('Anything known about menu, stations, tables, helpers'),
      },
    },
    ({ eventName, date, notes }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Set up the event "${eventName}"${date ? ` starting ${date}` : ''} in OpenEOS. Talk to the user in German (du-form).`,
              notes ? `Known so far: ${notes}` : '',
              '',
              'Work step by step and ask before each write:',
              '1. Call get_organization and list_events. If an event with a similar name exists, ask whether to reuse it or copy from it (copy_event) instead of creating a new one.',
              '2. create_event — preview first (confirm=false), show the summary, then apply with confirm=true. Ask for ordering mode (immediate / tab) and table mode (none / free / predefined) if unknown. The event stays not activated; tell the user activation, test mode and billing happen in the web app.',
              '3. Categories and products: ask for the menu (or read docs resource openeos://docs/produkte). Build one upsert_products call with createMissingCategories=true, preview it, let the user correct names, prices, tax rates and Pfand, then confirm. Use suggest_icons for icons when the assistant is enabled.',
              '4. Production stations (kitchen, grill, bar): create_production_station; assign printers from list_printers if the user wants printing.',
              '5. Tables, if table mode is predefined: list_table_areas, create_table_area, create_tables (prefix + range), then update_event with tables.mode=predefined and areaIds.',
              '6. Helpers, if wanted: create_shift_plan linked to the event, create_shift_job per station, create_shifts, and only publish_shift_plan when the user says so.',
              '7. Finish with a short German checklist of what was created and what remains to do in the web app (activate, printers, devices).',
              'Never guess prices or tax rates; ask. Keep answers short.',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'daily_summary',
    {
      title: 'Tagesabschluss zusammenfassen',
      description:
        'Summarise the sales of an event or day: revenue, orders, best sellers, payment methods, peak hours, cancellations.',
      argsSchema: {
        eventId: z
          .string()
          .optional()
          .describe('Event id (from list_events); default: the active event'),
        date: z
          .string()
          .optional()
          .describe('Day YYYY-MM-DD; default: whole event'),
      },
    },
    ({ eventId, date }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Write a short German end-of-day summary for the organizer.',
              eventId
                ? `Event: ${eventId}.`
                : 'Find the event with list_events (status active, else the most recent).',
              date
                ? `Day: ${date} (use startDate=endDate=${date}).`
                : 'Cover the whole event.',
              '',
              'Call get_sales_report with sections ["summary","products","categories","payments","hourly"] (and "net" if refunds matter). Optionally list_orders with status=cancelled for cancellations.',
              'Report: total revenue and order count, average receipt, top 5 products with quantity and revenue, revenue by category, payment method split, the busiest hours, Pfand balance, cancellations. Amounts in EUR with two decimals, German number format.',
              'Point out anything unusual (many cancellations, a product selling far below others, refunds). Keep it under 200 words; use a few bullet points.',
            ].join('\n'),
          },
        },
      ],
    }),
  );
}
