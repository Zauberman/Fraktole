export interface AuthContext {
  tokens: string[];
  deviceTokens?: string[];
}

export function checkAuth(header: string | undefined, auth: AuthContext): boolean {
  if (auth.tokens.length === 0 && (auth.deviceTokens ?? []).length === 0) return false;
  const match = /^Bearer\s+(.+)$/.exec(header ?? '');
  if (!match) return false;
  return auth.tokens.includes(match[1]!) || (auth.deviceTokens ?? []).includes(match[1]!);
}
