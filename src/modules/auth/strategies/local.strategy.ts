import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import { AuthService } from '../auth.service';
import { User } from '../../../database/entities';
import { ErrorCodes } from '../../../common/constants/error-codes';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly authService: AuthService) {
    super({
      usernameField: 'email',
      passwordField: 'password',
    });
  }

  async validate(email: string, password: string): Promise<User> {
    const user = await this.authService.validateUser(email, password);
    /* validateUser() liefert null sowohl fuer eine unbekannte E-Mail als
       auch fuer ein falsches Passwort (dort zaehlt es vorher den
       Fehlversuch). Beides bekommt denselben Code und dieselbe Meldung,
       damit sich nicht ablesen laesst, ob es das Konto gibt. Der Code ist
       das, was die Oberflaeche uebersetzt — mit UNAUTHORIZED sah jeder die
       deutsche Meldung. */
    if (!user) {
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Falsche E-Mail oder Passwort',
      });
    }
    return user;
  }
}
