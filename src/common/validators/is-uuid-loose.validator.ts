import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * Loose UUID validation that accepts any 8-4-4-4-12 hex string.
 *
 * validator.js 13.15+ enforces strict RFC 4122 version/variant bits
 * for @IsUUID(), which rejects manually-created seed-data UUIDs
 * (e.g. b1000000-0000-0000-0000-000000000007).
 *
 * Use this instead of @IsUUID() when the value may come from seed data
 * or PostgreSQL gen_random_uuid() which always produces valid v4 UUIDs.
 */
const UUID_LOOSE_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function IsUUIDLoose(validationOptions?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol) {
    registerDecorator({
      name: 'isUUIDLoose',
      target: object.constructor,
      propertyName: propertyName as string,
      options: {
        message: `$property must be a UUID`,
        ...validationOptions,
      },
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && UUID_LOOSE_REGEX.test(value);
        },
      },
    });
  };
}
