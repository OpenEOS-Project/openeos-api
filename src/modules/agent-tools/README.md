# Agent tools

One tool layer, many entry points (ki-plan.md, section 0 and 2.5): everything an
AI agent may do in OpenEOS is described once here — name, input schema, scope,
whether it writes — and served by the MCP server (`src/modules/mcp`), later also
by the in-app assistant.

## Shape of a tool

```ts
defineTool({
  name: 'list_pfand_types',            // snake_case, stable (clients save it)
  description: 'Deposit (Pfand) types of the organization with amounts in EUR.',
  inputSchema: z.object({}).strict(),  // zod; becomes the JSON schema clients see
  scope: TokenScope.READ,              // the API-token scope that unlocks it
  mutating: false,                     // true = writes; input must carry `confirm`
  handler: async (ctx, input) => { … } // calls the module services directly
});
```

- `ctx` = `{ user, organizationId, apiToken, client }`. The organization always
  comes from the token, never from the input. Every `eventId` in an input is
  checked against the token's organization (`assertEvent` in `tools/common.ts`).
- Handlers call the existing services (`EventsService`, `ProductsService`, …),
  so the role and module-permission checks of the services apply. Where a
  service checks nothing (shifts), the handler checks via `OrganizationsService`.
- Descriptions are English (models work best with them); strings meant for
  people (`summary`) are German.
- Results are compact plain objects: only what a planner needs, money as EUR
  numbers, dates ISO. Lists return `{ items, total, nextOffset }` and take
  `limit` (max 100) and `offset`.

## Mutating tools

Every writing tool takes `confirm: boolean` (default `false`):

- `confirm: false` → `{ preview: true, summary, wouldCreate | wouldUpdate | changes … }`
  and **nothing changes**. Previews also run the permission check so a member
  without rights fails early.
- `confirm: true` → the change is applied and `{ ok: true, summary, … }` returned.

After a confirmed, non-preview result the registry writes an
`admin_audit_logs` row (`action = agent_tool_call`, `details = { via: 'agent',
tool, tokenId, tokenName, inputHash, summary }`). Inputs themselves are never
stored, only their SHA-256.

The registry refuses to register a mutating tool whose schema has no `confirm`.

## Adding a tool

1. Pick the group in `tools/` (or add one: an `@Injectable()` class with a
   `tools(): AgentTool[]` method, listed in `agent-tools.module.ts` providers and
   `onModuleInit`).
2. Write the zod schema with `.strict()`, `.describe()` on non-obvious fields,
   and `...confirmInput` for mutations (`tool-helpers.ts` has `uuid`, `dateInput`,
   `listInput`, `hexColor`).
3. Choose the scope from `api-scopes.ts`. The tool must not do more than the
   REST endpoints allow for that scope (see the allowlist snapshot in
   `api-token-allowlist.spec.ts` and ki-plan.md section 8.6). Never: cashier
   functions, refunds, members, deletion, event activation, billing.
4. Return compact objects; strip anything personal (guest names, phone numbers,
   notes, device tokens, pairing codes, password hashes).
5. Add a unit test in `agent-tools.spec.ts` (mocked services): preview vs.
   confirm, scope, validation.
6. Append the tool to ki-plan.md section 9 (name, input schema, example output).

## Errors

`AgentToolError(code)` with `TOOL_NOT_FOUND`, `SCOPE_MISSING`, `INVALID_INPUT`,
`NOT_FOUND`, `CONFLICT`; service exceptions (`HttpException` with
`{ code, reason, message }`) pass through. The MCP layer turns both into a tool
result with `isError: true` and `{ error, message, details? }` as JSON.

Each call logs one line: `tool=… token=… org=… ms=… ok|ok (applied)|error <reason>`
— never the input.
