export type GmailErrorCategory =
  | 'reauthorization_required'
  | 'insufficient_scope'
  | 'domain_policy'
  | 'quota'
  | 'rate_limit'
  | 'transient'
  | 'network'
  | 'forbidden'
  | 'unknown';

export interface GmailErrorClassification {
  category: GmailErrorCategory;
  status?: number;
  reason?: string;
  retryable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseData(error: unknown): Record<string, unknown> | undefined {
  if (!isRecord(error) || !isRecord(error.response) || !isRecord(error.response.data)) {
    return undefined;
  }
  return error.response.data;
}

function numericStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.code === 'number') return error.code;
  if (isRecord(error.response) && typeof error.response.status === 'number') {
    return error.response.status;
  }
  const providerError = responseData(error)?.error;
  if (isRecord(providerError) && typeof providerError.code === 'number') {
    return providerError.code;
  }
  return undefined;
}

function providerReason(error: unknown): string | undefined {
  const data = responseData(error);
  const providerError = data?.error;
  if (typeof providerError === 'string') return providerError;

  const reasonSources: unknown[] = [];
  if (isRecord(providerError)) {
    reasonSources.push(providerError.reason);
    if (Array.isArray(providerError.errors)) {
      reasonSources.push(...providerError.errors.map(item => isRecord(item) ? item.reason : undefined));
    }
    reasonSources.push(providerError.status);
  }
  if (Array.isArray(data?.errors)) {
    reasonSources.push(...data.errors.map(item => isRecord(item) ? item.reason : undefined));
  }
  if (isRecord(error) && Array.isArray(error.errors)) {
    reasonSources.push(...error.errors.map(item => isRecord(item) ? item.reason : undefined));
  }
  return reasonSources.find((value): value is string => typeof value === 'string');
}

export function providerMessage(error: unknown): string {
  const dataError = responseData(error)?.error;
  if (isRecord(dataError) && typeof dataError.message === 'string') return dataError.message;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return 'The Gmail request failed.';
}

export function systemErrorCode(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== 'string') return undefined;
  return error.code;
}

/** Classify provider failures without assuming every 403 is revoked OAuth. */
export function classifyGmailError(error: unknown): GmailErrorClassification {
  const status = numericStatus(error);
  const reason = providerReason(error);
  const normalizedReason = reason?.toLowerCase();
  const message = providerMessage(error).toLowerCase();

  if (status === 401 || normalizedReason === 'invalid_grant' || message.includes('invalid_grant')) {
    return { category: 'reauthorization_required', status, reason, retryable: false };
  }
  if (normalizedReason === 'insufficientpermissions'
      || normalizedReason === 'insufficient_scope'
      || message.includes('insufficient authentication scopes')) {
    return { category: 'insufficient_scope', status, reason, retryable: false };
  }
  if (normalizedReason === 'domainpolicy') {
    return { category: 'domain_policy', status, reason, retryable: false };
  }
  if (status === 429
      || normalizedReason === 'ratelimitexceeded'
      || normalizedReason === 'userratelimitexceeded') {
    return { category: 'rate_limit', status, reason, retryable: true };
  }
  if (normalizedReason === 'quotaexceeded'
      || normalizedReason === 'dailylimitexceeded'
      || normalizedReason === 'dailylimitexceededunreg') {
    return { category: 'quota', status, reason, retryable: false };
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    return { category: 'transient', status, reason, retryable: false };
  }

  const code = systemErrorCode(error);
  if (code && [
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'ETIMEDOUT',
  ].includes(code)) {
    return { category: 'network', status, reason: code, retryable: false };
  }
  if (status === 403) {
    return { category: 'forbidden', status, reason, retryable: false };
  }
  return { category: 'unknown', status, reason, retryable: false };
}
