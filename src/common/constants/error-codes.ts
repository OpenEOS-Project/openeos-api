export const ErrorCodes = {
  // General Errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  CONFLICT: 'CONFLICT',

  // Auth Errors
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_REVOKED: 'TOKEN_REVOKED',
  REFRESH_TOKEN_REVOKED: 'REFRESH_TOKEN_REVOKED',
  USER_EXISTS: 'USER_EXISTS',

  // 2FA Errors
  TWO_FACTOR_REQUIRED: 'TWO_FACTOR_REQUIRED',
  INVALID_2FA_CODE: 'INVALID_2FA_CODE',
  TWO_FACTOR_ALREADY_ENABLED: 'TWO_FACTOR_ALREADY_ENABLED',
  TWO_FACTOR_NOT_ENABLED: 'TWO_FACTOR_NOT_ENABLED',
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',

  // Business Logic Errors
  ORDER_ALREADY_PAID: 'ORDER_ALREADY_PAID',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PRINTER_OFFLINE: 'PRINTER_OFFLINE',
  EVENT_NOT_ACTIVE: 'EVENT_NOT_ACTIVE',
  INVITATION_EXPIRED: 'INVITATION_EXPIRED',
  MEMBER_ALREADY_EXISTS: 'MEMBER_ALREADY_EXISTS',
  INVENTORY_IN_PROGRESS: 'INVENTORY_IN_PROGRESS',
  INVENTORY_ALREADY_COMPLETED: 'INVENTORY_ALREADY_COMPLETED',

  // Credit & License Errors
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  CREDITS_REQUIRED: 'CREDITS_REQUIRED',
  EVENT_ACTIVATION_BLOCKED: 'EVENT_ACTIVATION_BLOCKED',
  PAYMENT_PENDING: 'PAYMENT_PENDING',
  PURCHASE_FAILED: 'PURCHASE_FAILED',
  INVALID_PACKAGE: 'INVALID_PACKAGE',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export const ErrorMessages: Record<ErrorCode, string> = {
  [ErrorCodes.INTERNAL_ERROR]: 'Interner Serverfehler',
  [ErrorCodes.NOT_FOUND]: 'Ressource nicht gefunden',
  [ErrorCodes.VALIDATION_ERROR]: 'Validierung fehlgeschlagen',
  [ErrorCodes.UNAUTHORIZED]: 'Nicht authentifiziert',
  [ErrorCodes.FORBIDDEN]: 'Keine Berechtigung',
  [ErrorCodes.RATE_LIMITED]: 'Rate Limit überschritten',
  [ErrorCodes.CONFLICT]: 'Konflikt',

  [ErrorCodes.INVALID_CREDENTIALS]: 'Falsche E-Mail oder Passwort',
  [ErrorCodes.ACCOUNT_LOCKED]: 'Account gesperrt',
  [ErrorCodes.ACCOUNT_INACTIVE]: 'Account deaktiviert',
  [ErrorCodes.EMAIL_NOT_VERIFIED]: 'E-Mail nicht verifiziert',
  [ErrorCodes.TOKEN_EXPIRED]: 'Token abgelaufen',
  [ErrorCodes.TOKEN_INVALID]: 'Token ungültig',
  [ErrorCodes.INVALID_TOKEN]: 'Ungültiger Token',
  [ErrorCodes.TOKEN_REVOKED]: 'Token widerrufen',
  [ErrorCodes.REFRESH_TOKEN_REVOKED]: 'Refresh Token widerrufen',
  [ErrorCodes.USER_EXISTS]: 'Benutzer existiert bereits',

  [ErrorCodes.TWO_FACTOR_REQUIRED]: 'Zwei-Faktor-Authentifizierung erforderlich',
  [ErrorCodes.INVALID_2FA_CODE]: 'Ungültiger Verifizierungscode',
  [ErrorCodes.TWO_FACTOR_ALREADY_ENABLED]: '2FA bereits aktiviert',
  [ErrorCodes.TWO_FACTOR_NOT_ENABLED]: '2FA nicht aktiviert',
  [ErrorCodes.TOO_MANY_ATTEMPTS]: 'Zu viele Versuche',

  [ErrorCodes.ORDER_ALREADY_PAID]: 'Bestellung bereits bezahlt',
  [ErrorCodes.ORDER_CANCELLED]: 'Bestellung storniert',
  [ErrorCodes.INSUFFICIENT_STOCK]: 'Nicht genug Bestand',
  [ErrorCodes.PAYMENT_FAILED]: 'Zahlung fehlgeschlagen',
  [ErrorCodes.PRINTER_OFFLINE]: 'Drucker nicht erreichbar',
  [ErrorCodes.EVENT_NOT_ACTIVE]: 'Event nicht aktiv',
  [ErrorCodes.INVITATION_EXPIRED]: 'Einladung abgelaufen',
  [ErrorCodes.MEMBER_ALREADY_EXISTS]: 'Bereits Mitglied',
  [ErrorCodes.INVENTORY_IN_PROGRESS]: 'Inventur läuft bereits',
  [ErrorCodes.INVENTORY_ALREADY_COMPLETED]: 'Inventur bereits abgeschlossen',

  [ErrorCodes.INSUFFICIENT_CREDITS]: 'Nicht genug Guthaben',
  [ErrorCodes.CREDITS_REQUIRED]: 'Guthaben erforderlich für diese Aktion',
  [ErrorCodes.EVENT_ACTIVATION_BLOCKED]: 'Event-Aktivierung blockiert',
  [ErrorCodes.PAYMENT_PENDING]: 'Zahlung noch nicht abgeschlossen',
  [ErrorCodes.PURCHASE_FAILED]: 'Guthabenkauf fehlgeschlagen',
  [ErrorCodes.INVALID_PACKAGE]: 'Ungültiges Paket',
};
