import { apiGet } from './api';

export interface AuthProviders {
  password: boolean;
  sms: boolean;
  google: boolean;
  oneid: boolean;
}

/**
 * Which sign-in methods the API can actually perform.
 *
 * Read once per render of the sign-in and registration pages so they only
 * offer methods that will work. The alternative — letting each button find out
 * on click — meant a deployment without Google credentials showed a button
 * that answered 503 and then vanished, which reads as a fault rather than as a
 * method that was never configured.
 *
 * If the API is unreachable this falls back to password only. That is the one
 * method whose failure is legible: the form submits, and the user gets a real
 * error. Guessing that the others are available would put them one click away
 * from a dead end.
 */
export async function getAuthProviders(): Promise<AuthProviders> {
  const result = await apiGet<AuthProviders>('/auth/providers');

  if (!result.ok) {
    return { password: true, sms: false, google: false, oneid: false };
  }

  return result.data;
}
