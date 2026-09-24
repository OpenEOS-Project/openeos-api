import { Organization, User } from '../../database/entities';

/**
 * Was die Admin-Listen nach draußen geben dürfen.
 *
 * Bewusst als Positivliste. Die vorige Fassung entfernte einzeln, was
 * nicht hinaus sollte — und übersah dabei den 2FA-Schlüssel, den Hash der
 * Notfallcodes sowie die Token für Passwort-Zurücksetzung und
 * E-Mail-Bestätigung. Eine Negativliste vergisst zuverlässig das nächste
 * Feld, das jemand der Tabelle hinzufügt; eine Positivliste lässt es
 * schlimmstenfalls fehlen, was auffällt, statt es stillschweigend
 * preiszugeben.
 */
export type RedigierterAdminUser = Pick<
  User,
  | 'id'
  | 'email'
  | 'firstName'
  | 'lastName'
  | 'avatarUrl'
  | 'isActive'
  | 'isSuperAdmin'
  | 'emailVerifiedAt'
  | 'lastLoginAt'
  | 'lockedUntil'
  | 'failedLoginAttempts'
  | 'createdAt'
  | 'updatedAt'
> & { userOrganizations?: User['userOrganizations'] };

export function redigiereAdminUser(user: User): RedigierterAdminUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl,
    isActive: user.isActive,
    isSuperAdmin: user.isSuperAdmin,
    emailVerifiedAt: user.emailVerifiedAt,
    lastLoginAt: user.lastLoginAt,
    lockedUntil: user.lockedUntil,
    failedLoginAttempts: user.failedLoginAttempts,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    userOrganizations: user.userOrganizations,
  };
}

/**
 * Zugangsdaten aus einer Organisation entfernen.
 *
 * Hier keine Positivliste: Die Oberfläche arbeitet mit dem vollständigen
 * Organisationsobjekt, und eine Auswahl würde bei jedem neuen Feld etwas
 * verschwinden lassen. Gefährlich ist allein der Zahlungs-Teil der
 * Einstellungen, und der ist klein und benannt.
 *
 * Die letzten vier Zeichen bleiben stehen, damit sich im Support noch
 * abgleichen lässt, welcher Schlüssel hinterlegt ist — dafür genügen sie,
 * zum Bezahlen nicht.
 */
export function redigiereAdminOrganisation(organization: Organization): Organization {
  const maskieren = (wert?: string) => (wert ? `****${wert.slice(-4)}` : wert);

  const einstellungen = { ...(organization.settings ?? {}) };

  if (einstellungen.sumup) {
    einstellungen.sumup = {
      ...einstellungen.sumup,
      apiKey: maskieren(einstellungen.sumup.apiKey) as string,
      affiliateKey: maskieren(einstellungen.sumup.affiliateKey),
    };
  }

  if (einstellungen.paypal) {
    einstellungen.paypal = {
      ...einstellungen.paypal,
      clientSecret: maskieren(einstellungen.paypal.clientSecret) as string,
    };
  }

  return {
    ...organization,
    settings: einstellungen,
    /* Die PIN weist den Support gegenüber der Organisation aus. Sie in
       derselben Liste mitzuliefern, aus der sich der Support bedient,
       nimmt ihr genau diesen Zweck. */
    supportPin: undefined as unknown as string,
  };
}
