import { Body, Controller, Post } from '@nestjs/common';
import { AuthCredentials, AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  login(@Body() credentials: AuthCredentials) {
    return this.authService.login(credentials);
  }

  @Post('register')
  register(@Body() credentials: AuthCredentials) {
    return this.authService.register(credentials);
  }
}
