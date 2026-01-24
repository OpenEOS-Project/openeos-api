import {
  PipeTransform,
  Injectable,
  ArgumentMetadata,
  BadRequestException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ErrorCodes } from '../constants/error-codes';

@Injectable()
export class CustomValidationPipe implements PipeTransform {
  async transform(value: unknown, { metatype }: ArgumentMetadata) {
    if (!metatype || !this.toValidate(metatype)) {
      return value;
    }

    const object = plainToInstance(metatype, value);
    const errors = await validate(object, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    if (errors.length > 0) {
      const details = errors.map((error) => ({
        field: error.property,
        code: this.getValidationCode(error),
        message: Object.values(error.constraints || {}).join(', '),
      }));

      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Validierung fehlgeschlagen',
        details,
      });
    }

    return object;
  }

  private toValidate(metatype: new (...args: unknown[]) => unknown): boolean {
    const types: (new (...args: unknown[]) => unknown)[] = [String, Boolean, Number, Array, Object];
    return !types.includes(metatype);
  }

  private getValidationCode(error: { constraints?: Record<string, string> }): string {
    const constraints = error.constraints || {};
    const constraintKeys = Object.keys(constraints);

    if (constraintKeys.length === 0) {
      return 'INVALID';
    }

    // Map common validators to error codes
    const codeMap: Record<string, string> = {
      isEmail: 'INVALID_EMAIL',
      isNotEmpty: 'REQUIRED',
      minLength: 'TOO_SHORT',
      maxLength: 'TOO_LONG',
      isUuid: 'INVALID_UUID',
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
    };

    return codeMap[constraintKeys[0]] || constraintKeys[0].toUpperCase();
  }
}
