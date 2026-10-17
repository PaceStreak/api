/**
 * Outbound fetch for tests: nothing reaches the network. Every `fetch` from code under test must match a mock
 * registered with `mockFetch`, or it throws `unmocked outbound fetch`. Installed by test/setup.ts; mocks are
 * cleared after each test.
 */
export type FetchHandler = (req: Request) => Response | Promise<Response>;
export type FetchMatcher = string | RegExp | ((url: URL, req: Request) => boolean);

interface Mock {
  match: (url: URL, req: Request) => boolean;
  handler: FetchHandler;
  calls: Request[];
  times: number;
}

export interface MockHandle {
  /** Requests this mock answered, in order (bodies still readable via `clone()` before use). */
  readonly calls: readonly Request[];
}

const mocks: Mock[] = [];
let installed = false;

function toMatcher(m: FetchMatcher): (url: URL, req: Request) => boolean {
  if (typeof m === "string") return (url) => url.href.startsWith(m);
  if (m instanceof RegExp) return (url) => m.test(url.href);
  return m;
}

/**
 * Answers matching requests with `handler` (or a fixed Response, cloned per call). `times` limits how many calls it
 * answers (default unlimited). Later registrations win, so a test can override a default.
 */
export function mockFetch(
  match: FetchMatcher,
  handler: FetchHandler | Response,
  times = Number.POSITIVE_INFINITY,
): MockHandle {
  const fn: FetchHandler = handler instanceof Response ? () => handler.clone() : handler;
  const mock: Mock = { match: toMatcher(match), handler: fn, calls: [], times };
  mocks.unshift(mock);
  return mock;
}

/** `mockFetch` answering JSON. */
export function mockJson(match: FetchMatcher, body: unknown, status = 200): MockHandle {
  return mockFetch(match, () => Response.json(body, { status }));
}

export function resetFetchMocks(): void {
  mocks.length = 0;
}

export function installFetchGuard(): void {
  if (installed) return;
  installed = true;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const mock = mocks.find((m) => m.calls.length < m.times && m.match(url, req));
    if (mock === undefined) throw new Error(`unmocked outbound fetch: ${req.method} ${url.href}`);
    mock.calls.push(req.clone());
    return mock.handler(req);
  };
}
