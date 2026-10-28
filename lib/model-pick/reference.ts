/**
 * Pure, in-memory model reference resolution. No I/O, clock, configuration, or
 * registry access. Unknown properties (including channel/secrets) never leave
 * these functions; only the five explicitly supported model fields are copied.
 */
export type ModelFields = {
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  [key: string]: unknown;
};

export type Scope = {
  provider: string;
  modelId: string;
  endpoint: string;
  api: string;
  credentialVersion: string;
};

export type TestRecord = {
  id: string;
  scope: Scope;
  testedAt: number;
  expiresAt: number;
  fields: ModelFields;
  verifiedFields: string[];
  status: 'passed' | 'failed' | 'inconclusive';
  [key: string]: unknown;
};

/**
 * Optional TestRecord.evidence[field] convention for callers with richer proof.
 * Without evidence metadata, verifiedFields is the trusted executor's exact
 * field attestation, NOT an AI-generated claim. A pure resolver cannot verify
 * that attestation independently. In particular, successful N-token acceptance
 * must NOT put contextWindow/maxTokens in verifiedFields as an exact maximum.
 * With metadata, observations cannot certify numeric maxima; bounds, inference,
 * self-report, malformed metadata and missing per-field proof are rejected.
 */
export type TestFieldEvidence = {
  kind: 'observed' | 'exact-limit' | 'lower-bound' | 'self-report' | 'inferred';
};

export type FieldSource = 'tested' | 'manual' | 'provider' | 'generic' | 'default';
export type FieldProvenance = {
  source: FieldSource;
  /** Fixed reason codes and input test indices only; no raw values or scope. */
  history: { source: string; reason: string }[];
};

const FIELD_NAMES = ['name', 'contextWindow', 'maxTokens', 'reasoning', 'input'] as const;
type Field = (typeof FIELD_NAMES)[number];
const SCOPE_KEYS = ['provider', 'modelId', 'endpoint', 'api', 'credentialVersion'] as const;
const MISSING = Symbol('missing');
const ACCESSOR = Symbol('accessor');

// Own data properties only: do not invoke getters or consult object prototypes.
function own(object: unknown, key: string): unknown {
  if (typeof object !== 'object' || object === null) return MISSING;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return MISSING;
  return 'value' in descriptor ? descriptor.value : ACCESSOR;
}

function isMissing(value: unknown): boolean {
  return value === MISSING || value === undefined;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function dataArray(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = own(value, String(i));
    if (item === MISSING || item === ACCESSOR) return undefined;
    result.push(item);
  }
  return result;
}

function valid(field: Field, value: unknown): boolean {
  switch (field) {
    case 'name': return typeof value === 'string' && value.trim().length > 0;
    case 'contextWindow':
    case 'maxTokens': return positiveInteger(value);
    case 'reasoning': return typeof value === 'boolean';
    case 'input': {
      const items = dataArray(value);
      return items !== undefined && items.length > 0
        && items.every((item) => item === 'text' || item === 'image');
    }
  }
}

function copyValue(field: Field, value: unknown): unknown {
  if (field !== 'input') return value;
  // Input modalities form a set. Canonical ordering also makes consensus stable.
  const modalities = dataArray(value)!;
  return (['text', 'image'] as const).filter((item) => modalities.includes(item));
}

function sameScope(left: unknown, right: unknown): boolean {
  return SCOPE_KEYS.every((key) => {
    const value = own(left, key);
    return typeof value === 'string' && value === own(right, key);
  });
}

type PreparedTest = { record: unknown; index: number; testedAt: number; rejected?: string };

function prepareTests(tests: TestRecord[] | undefined, scope: Scope, now: number): PreparedTest[] {
  if (!Array.isArray(tests)) return [];
  return Array.from({ length: tests.length }, (_, index) => {
    const record = own(tests, String(index));
    const testedAt = own(record, 'testedAt');
    const expiresAt = own(record, 'expiresAt');
    let rejected: string | undefined;
    if (!sameScope(own(record, 'scope'), scope)) rejected = 'scope-mismatch';
    else if (own(record, 'status') !== 'passed') rejected = 'status-not-passed';
    else if (!timestamp(now)) rejected = 'invalid-now';
    else if (!timestamp(testedAt) || !timestamp(expiresAt) || expiresAt <= testedAt) {
      rejected = 'invalid-time';
    } else if (testedAt > now) rejected = 'future';
    else if (expiresAt <= now) rejected = 'expired';
    return { record, index, testedAt: timestamp(testedAt) ? testedAt : -1, rejected };
  }).sort((a, b) => b.testedAt - a.testedAt || a.index - b.index);
}

function evidenceRejection(record: unknown, field: Field): string | undefined {
  const evidence = own(record, 'evidence');
  if (isMissing(evidence)) return undefined;
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) {
    return 'invalid-evidence';
  }
  const proof = own(evidence, field);
  if (isMissing(proof)) return 'missing-evidence';
  const kind = own(proof, 'kind');
  if (kind === 'self-report' || kind === 'inferred') return 'not-observed-evidence';
  if (kind === 'lower-bound') return 'lower-bound-not-exact';
  if (kind === 'observed') {
    return field === 'contextWindow' || field === 'maxTokens' ? 'observation-not-maximum' : undefined;
  }
  return kind === 'exact-limit' ? undefined : 'invalid-evidence';
}

/**
 * manual/providerModel/generic are already-targeted field bags; the caller owns
 * their identity selection (findModelTemplate can do exact catalog lookup).
 * now/test timestamps use the same nonnegative safe-integer time unit, normally
 * Unix milliseconds. Expiration is exclusive. needsReview contains field names
 * for unconfirmed defaults, invalid values/relationships or rejected proof.
 */
export function resolveModelFields({ scope, now, tests, manual, providerModel, generic }: {
  scope: Scope;
  now: number;
  tests?: TestRecord[];
  manual?: ModelFields;
  providerModel?: ModelFields;
  generic?: ModelFields;
}): { fields: ModelFields; provenance: Record<string, FieldProvenance>; needsReview: string[] } {
  const fields: ModelFields = {};
  const provenance: Record<string, FieldProvenance> = {};
  const review = new Set<Field>();
  const prepared = prepareTests(tests, scope, now);

  // Resolve context before output. Never enlarge a selected context just to fit
  // a conflicting output claim. Instead try lower-priority output candidates.
  for (const field of FIELD_NAMES) {
    const history: FieldProvenance['history'] = [];
    let chosen: FieldSource | undefined;
    const consider = (source: FieldSource, value: unknown, prefix = '') => {
      let reason: string;
      if (isMissing(value)) reason = 'missing';
      else if (!valid(field, value)) {
        reason = 'invalid-value';
        review.add(field);
      } else if (field === 'maxTokens' && (value as number) > fields.contextWindow!) {
        reason = 'exceeds-context';
        review.add(field);
      } else if (chosen) reason = 'lower-priority';
      else {
        fields[field] = copyValue(field, value) as never;
        chosen = source;
        reason = 'selected';
      }
      history.push({ source, reason: `${prefix}${reason}` });
    };

    if (!prepared.length) history.push({ source: 'tested', reason: 'missing' });
    for (const candidate of prepared) {
      const prefix = `test[${candidate.index}]:`;
      if (candidate.rejected) {
        history.push({ source: 'tested', reason: `${prefix}${candidate.rejected}` });
        continue;
      }
      const verified = dataArray(own(candidate.record, 'verifiedFields'));
      // Only explicitly attested fields may override manual values. Never infer
      // verified fields from fields present, AI prose, or token lower bounds.
      if (!verified || !verified.every((item) => typeof item === 'string')) {
        history.push({ source: 'tested', reason: `${prefix}invalid-verified-fields` });
        continue;
      }
      if (!verified.includes(field)) {
        history.push({ source: 'tested', reason: `${prefix}not-verified` });
        continue;
      }
      const rejected = evidenceRejection(candidate.record, field);
      if (rejected) {
        history.push({ source: 'tested', reason: `${prefix}${rejected}` });
        review.add(field);
        continue;
      }
      consider('tested', own(own(candidate.record, 'fields'), field), prefix);
    }
    consider('manual', own(manual, field));
    consider('provider', own(providerModel, field));
    consider('generic', own(generic, field));

    if (chosen) history.push({ source: 'default', reason: 'lower-priority' });
    else {
      let value: unknown;
      switch (field) {
        case 'name': {
          const modelId = own(scope, 'modelId');
          value = valid('name', modelId) ? modelId : 'Unnamed model';
          if (!valid('name', modelId)) review.add(field);
          break;
        }
        case 'contextWindow': value = 128000; break;
        case 'maxTokens': value = Math.min(8192, fields.contextWindow!); break;
        case 'reasoning': value = false; break;
        case 'input': value = ['text']; break;
      }
      fields[field] = value as never;
      chosen = 'default';
      if (field !== 'name') review.add(field);
      history.push({
        source: 'default',
        reason: field === 'name' ? 'model-id-label' : field === 'maxTokens' && fields.contextWindow! < 8192
          ? 'unconfirmed-default-clamped-to-context' : 'unconfirmed-conservative-default',
      });
    }
    provenance[field] = { source: chosen, history };
  }

  return { fields, provenance, needsReview: FIELD_NAMES.filter((field) => review.has(field)) };
}

function pickTemplate(row: unknown): ModelFields {
  const template: ModelFields = {};
  for (const field of FIELD_NAMES) {
    const value = own(row, field);
    if (valid(field, value)) template[field] = copyValue(field, value) as never;
  }
  if (template.contextWindow !== undefined && template.maxTokens !== undefined
    && template.maxTokens > template.contextWindow) delete template.maxTokens;
  return template;
}

function sameValue(field: Field, a: unknown, b: unknown): boolean {
  return field === 'input'
    ? (a as string[]).join(',') === (b as string[]).join(',') : a === b;
}

/**
 * Exact, case-sensitive IDs only. Supplying provider prohibits cross-provider
 * fallback. Across matching rows, contradictory allowed values make the whole
 * template ambiguous (undefined); missing values are not borrowed from one row.
 * Only consensus fields present in every row survive. No defaults are invented.
 */
export function findModelTemplate(
  modelId: string,
  catalog: Array<{ provider: string; id: string; [key: string]: unknown }>,
  provider?: string,
): ModelFields | undefined {
  if (typeof modelId !== 'string' || !modelId.trim() || !Array.isArray(catalog)) return undefined;
  const rows = Array.from({ length: catalog.length }, (_, i) => own(catalog, String(i)))
    .filter((row) => own(row, 'id') === modelId
      && typeof own(row, 'provider') === 'string'
      && (provider === undefined || own(row, 'provider') === provider));
  if (!rows.length) return undefined;
  const templates = rows.map(pickTemplate);
  const result: ModelFields = {};
  for (const field of FIELD_NAMES) {
    const values = templates.map((template) => own(template, field)).filter((value) => !isMissing(value));
    if (!values.length) continue;
    if (values.some((value) => !sameValue(field, values[0], value))) return undefined;
    if (values.length === templates.length) result[field] = copyValue(field, values[0]) as never;
  }
  return Object.keys(result).length ? result : undefined;
}
