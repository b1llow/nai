/**
 * Structured JSON logs for Workers Observability.
 * @see https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
 */
export function logError(fields: {
  message: string;
  error: string;
  path?: string;
  status?: number;
}): void {
  console.error(JSON.stringify(fields));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "non-error thrown";
}

export function requestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "";
  }
}
