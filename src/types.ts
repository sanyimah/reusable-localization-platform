export interface KeyOccurrence {
  key: string;
  file: string;
  line: number;
  column: number;
  /** how it was found: "t", "i18n.t", "Trans", "declared" */
  via: string;
}

export interface DynamicUsage {
  file: string;
  line: number;
  column: number;
  snippet: string;
  reason: string;
}

export interface FileExtraction {
  file: string;
  keys: KeyOccurrence[];
  dynamic: DynamicUsage[];
}

export type BatchOutcome =
  | { status: "registered" }
  | { status: "duplicate" }
  | { status: "failed"; error: string; httpStatus?: number };

/**
 * The only thing the toolkit knows about your backend.
 * Implement this yourself, or use the built-in HTTP adapter via `api` config.
 */
export interface ApiAdapter {
  /** Return every key already registered for this app. */
  fetchExisting(appId: string): Promise<string[]>;
  /** Register one batch of keys. Return `failed` for normal failures instead of throwing. */
  register(keys: string[], appId: string): Promise<BatchOutcome>;
  /** Keys per register() call. Default 1. */
  batchSize?: number;
  /** Parallel register() calls. Default 3. */
  concurrency?: number;
  /** Used for the pre-send preview. */
  previewPayload?(keys: string[], appId: string): unknown;
}

export interface HttpResponseLike {
  status: number;
  body: unknown;
}

export interface HttpApiConfig {
  baseUrl: string;
  /** Static headers, or a function (can be async) if you need to fetch/refresh a token. */
  headers?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>);

  /** Default: `/api/GetTranslations/${appId}` */
  getUrl?: (appId: string) => string;
  /** REQUIRED. Turn the GET response body into a flat list of existing keys. */
  parseExisting: (body: unknown) => string[];

  /** Default: `/Generics/TranslationRequests` */
  postUrl?: string | ((appId: string) => string);
  /** REQUIRED. Build the POST body for a batch of keys. */
  buildPayload: (keys: string[], appId: string) => unknown;

  /** Keys per POST. Default 1 (safest while the contract is unverified). */
  batchSize?: number;
  concurrency?: number;
  /** Retries for transient failures. Default 2. */
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  /** Default: any 2xx */
  isSuccess?: (res: HttpResponseLike) => boolean;
  /** Treat as "already exists" instead of failure. Default: status 409 */
  isDuplicate?: (res: HttpResponseLike) => boolean;
}

export interface ToolkitConfig {
  appId: string;
  include?: string[];
  exclude?: string[];
  /** Extra function names that behave like t(). Default ["t"]. */
  functions?: string[];
  /** Hooks that return t. Default ["useTranslation"]. */
  hooks?: string[];
  /** Objects whose .t() is a translate call. Default ["i18n", "i18next"]. */
  i18nObjects?: string[];
  /** JSX components using i18nKey. Default ["Trans"]. */
  transComponents?: string[];
  dynamicKeys?: "warn" | "error" | "ignore";
    /** Regex sources. A dynamic usage is hidden if `${file} ${snippet}` matches any of them. */
  ignoreDynamic?: string[];
  maxKeyLength?: number;
  api?: HttpApiConfig;
  adapter?: ApiAdapter;
  /** Used with --mock. Default .i18n-keys-mock.json */
  mockFile?: string;
  /** Write a JSON report here after each run. */
  reportFile?: string;
}

export interface ResolvedConfig extends ToolkitConfig {
  cwd: string;
  include: string[];
  exclude: string[];
  functions: string[];
  hooks: string[];
  i18nObjects: string[];
  transComponents: string[];
  dynamicKeys: "warn" | "error" | "ignore";
  maxKeyLength: number;
  mockFile: string;
}

export interface KeyIssue {
  key: string;
  level: "error" | "warning";
  message: string;
  file: string;
  line: number;
}

export interface ScanResult {
  filesScanned: number;
  /** valid keys -> where they appear */
  keys: Map<string, KeyOccurrence[]>;
  dynamic: DynamicUsage[];
  issues: KeyIssue[];
  readErrors: { file: string; error: string }[];
}

export interface RegisterSummary {
  planned: string[];
  registered: string[];
  duplicates: string[];
  failed: { key: string; error: string }[];
  skippedByLimit: string[];
}