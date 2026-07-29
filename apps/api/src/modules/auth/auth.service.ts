import { Injectable, NotImplementedException } from '@nestjs/common';

export interface AuthCredentials {
  email: string;
  password: string;
}

@Injectable()
export class AuthService {
  async login(_credentials: AuthCredentials) {
    throw new NotImplementedException('Auth strategy not yet configured');
  }

  async register(_credentials: AuthCredentials) {
    throw new NotImplementedException('Auth strategy not yet configured');
  }
}
