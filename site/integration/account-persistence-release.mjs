export const ACCOUNT_PERSISTENCE_MODES = Object.freeze({
  CLOSED: "closed",
  PRIVATE_ACCEPTANCE: "private_acceptance",
  RELEASED: "released",
});

export const ACCOUNT_PERSISTENCE_ENV_KEY = "MESHFUL_ACCOUNT_PERSISTENCE_MODE";
export const ACCOUNT_ACCEPTANCE_SUBJECTS_ENV_KEY = "MESHFUL_ACCOUNT_ACCEPTANCE_SUBJECTS";

export function resolveAccountPersistenceMode(value) {
  return value === ACCOUNT_PERSISTENCE_MODES.PRIVATE_ACCEPTANCE ||
    value === ACCOUNT_PERSISTENCE_MODES.RELEASED
    ? value : ACCOUNT_PERSISTENCE_MODES.CLOSED;
}

export function resolveAccountAcceptanceSubject(value) {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/.test(value)
    ? value : null;
}

export function resolveAccountAcceptanceSubjects(value) {
  if (typeof value !== "string" || value.length > 8_192) return Object.freeze([]);
  let parsed;
  try { parsed = JSON.parse(value); } catch { return Object.freeze([]); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8) return Object.freeze([]);
  const subjects = parsed.map(resolveAccountAcceptanceSubject);
  if (subjects.some((subject) => subject === null) || new Set(subjects).size !== subjects.length) {
    return Object.freeze([]);
  }
  return Object.freeze(subjects);
}

export function resolveAccountPersistencePolicy(modeValue, acceptanceSubjectsValue) {
  const mode = resolveAccountPersistenceMode(modeValue);
  const acceptanceSubjects = mode === ACCOUNT_PERSISTENCE_MODES.PRIVATE_ACCEPTANCE
    ? resolveAccountAcceptanceSubjects(acceptanceSubjectsValue) : Object.freeze([]);
  const enabled = mode === ACCOUNT_PERSISTENCE_MODES.RELEASED || acceptanceSubjects.length > 0;
  return Object.freeze({ mode, enabled, acceptanceSubjects, allowProvisioning: enabled });
}

export function isAccountPersistenceEnabled(modeValue, acceptanceSubjectsValue) {
  return resolveAccountPersistencePolicy(modeValue, acceptanceSubjectsValue).enabled;
}

export function accountPersistenceAllowsSubject(modeValue, acceptanceSubjectsValue, subject) {
  const policy = resolveAccountPersistencePolicy(modeValue, acceptanceSubjectsValue);
  const validSubject = resolveAccountAcceptanceSubject(subject);
  if (!policy.enabled || validSubject === null) return false;
  return policy.mode === ACCOUNT_PERSISTENCE_MODES.RELEASED ||
    policy.acceptanceSubjects.includes(validSubject);
}
