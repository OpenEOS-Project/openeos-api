import { BadRequestException } from '@nestjs/common';
import type { FindOptionsWhere } from 'typeorm';
import type {
  Product,
  ProductOptions,
} from '../../database/entities/product.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';

/** Option as a client names it: group and option by name. */
export interface RequestedOption {
  group: string;
  option: string;
  /** Ignored: the price comes from the product's option definition. */
  priceModifier?: number;
  excluded?: boolean;
}

/** Option as stored on the order item (and in carts/checkouts). */
export interface PricedOption {
  group: string;
  option: string;
  priceModifier: number;
  excluded?: true;
}

export interface PricedOptions {
  selected: PricedOption[];
  /** Sum of the surcharges per unit (excluded ingredients count 0). */
  optionsPrice: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

function invalidOption(
  productName: string,
  option: string,
): BadRequestException {
  return new BadRequestException({
    code: ErrorCodes.VALIDATION_ERROR,
    reason: ErrorReasons.PRODUCT_OPTION_INVALID,
    message: `Ungültige Option „${option}“ für ${productName}`,
    params: { product: productName, option },
  });
}

/**
 * Prices the options a client picked from the product's own option
 * definitions. Group and option are matched by name; the price always comes
 * from the definition, never from the request. Unknown options, duplicates,
 * more than one choice in a single-choice group and „ohne“ outside an
 * ingredients group are rejected. Excluded ingredients cost nothing.
 */
export function priceSelectedOptions(
  product: { name: string; options?: ProductOptions | null },
  requested: RequestedOption[] | null | undefined,
): PricedOptions {
  const groups = product.options?.groups ?? [];
  const selected: PricedOption[] = [];
  const seen = new Set<string>();
  const chosenPerGroup = new Map<string, number>();
  let optionsPrice = 0;

  for (const entry of requested ?? []) {
    const groupName = typeof entry?.group === 'string' ? entry.group : '';
    const optionName = typeof entry?.option === 'string' ? entry.option : '';
    const group = groups.find((g) => g.name === groupName);
    const definition = group?.options.find((o) => o.name === optionName);
    if (!group || !definition) {
      throw invalidOption(product.name, optionName || groupName);
    }

    const key = JSON.stringify([groupName, optionName]);
    if (seen.has(key)) throw invalidOption(product.name, optionName);
    seen.add(key);

    const excluded = entry.excluded === true;
    if (excluded) {
      if (group.type !== 'ingredients') {
        throw invalidOption(product.name, optionName);
      }
      selected.push({
        group: groupName,
        option: optionName,
        priceModifier: 0,
        excluded: true,
      });
      continue;
    }

    const chosen = (chosenPerGroup.get(groupName) ?? 0) + 1;
    chosenPerGroup.set(groupName, chosen);
    if (group.type === 'single' && chosen > 1) {
      throw invalidOption(product.name, optionName);
    }

    const priceModifier = round2(Number(definition.priceModifier) || 0);
    optionsPrice += priceModifier;
    selected.push({ group: groupName, option: optionName, priceModifier });
  }

  return { selected, optionsPrice: round2(optionsPrice) };
}

/**
 * Lookup of a product for an order position: always within the order's
 * organization, and within its event when the order has one.
 */
export function orderProductWhere(
  order: { organizationId: string; eventId?: string | null },
  productId: string,
): FindOptionsWhere<Product> {
  return order.eventId
    ? {
        id: productId,
        eventId: order.eventId,
        event: { organizationId: order.organizationId },
      }
    : { id: productId, event: { organizationId: order.organizationId } };
}
