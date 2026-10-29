// Credential reuse must prove identity, not merely match an authentication family.
export interface CredentialIdentity {
  access: string;
  refresh?: string;
  profileArn?: string;
  region?: string;
  authMethod?: string;
}

export function sameCredentialIdentity(expected: CredentialIdentity, candidate: CredentialIdentity): boolean {
  if (expected.authMethod && candidate.authMethod && expected.authMethod !== candidate.authMethod) return false;
  if (expected.region && candidate.region && expected.region !== candidate.region) return false;
  if (expected.profileArn && candidate.profileArn && expected.profileArn !== candidate.profileArn) return false;
  if (expected.access && expected.access === candidate.access) return true;
  const refresh = expected.refresh?.split("|")[0];
  if (refresh && refresh === candidate.refresh?.split("|")[0]) return true;
  return !!expected.profileArn && expected.profileArn === candidate.profileArn;
}
