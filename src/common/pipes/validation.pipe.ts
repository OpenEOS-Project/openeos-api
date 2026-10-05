import {
  PipeTransform,
  Injectable,
  ArgumentMetadata,
  BadRequestException,
} from '@nestjs/common';
import { validate, type ValidationError } from 'class-validator';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { ErrorCodes, ErrorMessages } from '../constants/error-codes';

/** class-validator constraint -> stable detail code. */
const CONSTRAINT_CODES: Record<string, string> = {
  isEmail: 'INVALID_EMAIL',
  isNotEmpty: 'REQUIRED',
  isDefined: 'REQUIRED',
  minLength: 'TOO_SHORT',
  maxLength: 'TOO_LONG',
  isUuid: 'INVALID_UUID',
  isUUID: 'INVALID_UUID',
  isNumber: 'INVALID_NUMBER',
  isInt: 'INVALID_INTEGER',
  isString: 'INVALID_STRING',
  isBoolean: 'INVALID_BOOLEAN',
  isArray: 'INVALID_ARRAY',
  isEnum: 'INVALID_ENUM',
  min: 'TOO_SMALL',
  max: 'TOO_LARGE',
  isDate: 'INVALID_DATE',
  isDateString: 'INVALID_DATE_STRING',
  whitelistValidation: 'NOT_ALLOWED',
};

export interface ValidationErrorDetail {
  field: string;
  code: string;
  message: string;
}

/**
 * One detail per failed constraint, nested properties as dotted path
 * (`items.0.quantity`). `code` is stable; `message` is the text from the
 * DTO (German where the DTO sets one, class-validator's English default
 * otherwise).
 */
export function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): ValidationErrorDetail[] {
  const details: ValidationErrorDetail[] = [];
  for (const error of errors) {
    const field = parentPath
      ? `${parentPath}.${error.property}`
      : error.property;
    for (const [constraint, message] of Object.entries(
      error.constraints ?? {},
    )) {
      details.push({
        field,
        code: CONSTRAINT_CODES[constraint] ?? constraint.toUpperCase(),
        message,
      });
    }
    if (error.children?.length) {
      details.push(...flattenValidationErrors(error.children, field));
    }
  }
  return details;
}

/** The exception the global ValidationPipe throws (see main.ts). */
export function validationException(
  errors: ValidationError[],
): BadRequestException {
  return new BadRequestException({
    code: ErrorCodes.VALIDATION_ERROR,
    message: ErrorMessages[ErrorCodes.VALIDATION_ERROR],
    details: flattenValidationErrors(errors),
  });
}

@Injectable()
export class CustomValidationPipe implements PipeTransform {
  async transform(value: unknown, { metatype }: ArgumentMetadata) {
    if (!metatype || !this.toValidate(metatype)) {
      return value;
    }

    // Nest reicht den Parametertyp als `Type<any>` durch; validiert wird
    // ohnehin nur ein Objekt.
    const object = plainToInstance(metatype as ClassConstructor<object>, value);
    const errors = await validate(object, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    if (errors.length > 0) {
      throw validationException(errors);
    }

    return object;
  }

  private toValidate(metatype: new (...args: unknown[]) => unknown): boolean {
    const types: (new (...args: unknown[]) => unknown)[] = [
      String,
      Boolean,
      Number,
      Array,
      Object,
    ];
    return !types.includes(metatype);
  }
}
