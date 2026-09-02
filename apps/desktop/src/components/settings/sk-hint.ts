/** Key-field placeholder when no provider is explicitly picked (shared by
 *  the settings Model section and any future key surface). */
export function skHint(key: string): string {
  if (key.trim().length === 0) return 'sk-… (provider detected from the key)';
  return 'paste the provider API key';
}
