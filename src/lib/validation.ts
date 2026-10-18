/**
 * Request validation with FastAPI/pydantic v2's 422 shape (DESIGN.md §5 step 10, gate G-5):
 *   {"detail": [{"type", "loc": ["body", ...path], "msg", "input", "ctx"?}]}
 * The app reads `detail[0].loc` (minus "body") and `detail[0].msg` (minus "Value error, "), so `msg` reproduces
 * pydantic's text for every check a zod schema here can express. Objects are non-strict: unknown keys are ignored.
 *
 * Use `json(schema)`, `query(schema)` and `param(schema)` as route middleware, then `c.req.valid("json")`.
 */
import type { Env, MiddlewareHandler } from "hono";
import type * as z from "zod";
import { HttpError } from "./errors.ts";

export type Loc = (string | number)[];

export interface PydanticError {
  type: string;
  loc: Loc;
  msg: string;
  input: unknown;
  ctx?: Record<string, unknown>;
}

type Target = "body" | "query" | "path";

function plural(n: number | bigint, word: string): string {
  return `${n} ${word}${Number(n) === 1 ? "" : "s"}`;
}

function repr(v: unknown): string {
  return typeof v === "string" ? `'${v}'` : String(v);
}

/** `'a'`, `'a' or 'b'`, `'a', 'b' or 'c'`: pydantic's literal_error wording. */
function orList(values: readonly unknown[]): string {
  const r = values.map(repr);
  if (r.length <= 1) return r.join("");
  return `${r.slice(0, -1).join(", ")} or ${r[r.length - 1]}`;
}

function at(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[k];
  }
  return cur;
}

function emailReason(input: unknown): string {
  if (typeof input !== "string") return "The email address is not valid.";
  const at = input.lastIndexOf("@");
  if (at < 0) return "An email address must have an @-sign.";
  if (at === 0) return "There must be something before the @-sign.";
  const domain = input.slice(at + 1);
  if (domain === "") return "There must be something after the @-sign.";
  if (!domain.includes(".")) return "The part after the @-sign is not valid. It should have a period.";
  return "The email address is not valid.";
}

type Issue = z.core.$ZodIssue;
type AnySchema = z.core.$ZodType;

/** The sub-schema at `path`, looking through wrappers, objects and arrays; undefined when not resolvable. */
function schemaAt(schema: AnySchema | undefined, path: readonly PropertyKey[]): AnySchema | undefined {
  let s = schema;
  for (let i = 0; s !== undefined; ) {
    const def = s._zod.def as { type: string; innerType?: AnySchema; out?: AnySchema; in?: AnySchema };
    if (def.innerType !== undefined) {
      s = def.innerType;
      continue;
    }
    if (def.type === "pipe") {
      s = def.in;
      continue;
    }
    if (i === path.length) return s;
    const key = path[i++];
    if (def.type === "object")
      s = (def as unknown as { shape: Record<PropertyKey, AnySchema> }).shape[key ?? ""];
    else if (def.type === "array") s = (def as unknown as { element: AnySchema }).element;
    else return undefined;
  }
  return undefined;
}

/** zod reports `expected: "number"` for a non-number given to `z.int()`; pydantic says "integer". */
function isIntSchema(s: AnySchema | undefined): boolean {
  const format = (s?._zod.def as { format?: string } | undefined)?.format;
  return format !== undefined && /int/.test(format);
}

/** zod's `pattern` is the regex literal (`/^\d+$/`); pydantic quotes the source. */
function patternSource(p: string | undefined): string {
  if (p === undefined) return "";
  const m = /^\/(.*)\/[a-z]*$/s.exec(p);
  return m?.[1] ?? p;
}

/** One zod issue as pydantic would have reported it. `root` is the whole validated value. */
export function toPydantic(issue: Issue, target: Target, root: unknown, schema?: AnySchema): PydanticError {
  const path = issue.path.filter((p): p is string | number => typeof p !== "symbol");
  const loc: Loc = [target, ...path];
  const input = at(root, issue.path);
  const parent = at(root, issue.path.slice(0, -1));
  const base = (type: string, msg: string, ctx?: Record<string, unknown>): PydanticError =>
    ctx === undefined ? { type, loc, msg, input } : { type, loc, msg, input, ctx };

  switch (issue.code) {
    case "invalid_type": {
      if (input === undefined) return { type: "missing", loc, msg: "Field required", input: parent ?? null };
      const expected =
        issue.expected === "number" && isIntSchema(schemaAt(schema, issue.path)) ? "int" : issue.expected;
      switch (expected) {
        case "string":
          return base("string_type", "Input should be a valid string");
        case "int":
          if (typeof input === "number") {
            return base(
              "int_from_float",
              "Input should be a valid integer, got a number with a fractional part",
            );
          }
          return typeof input === "string"
            ? base("int_parsing", "Input should be a valid integer, unable to parse string as an integer")
            : base("int_type", "Input should be a valid integer");
        case "number":
          return typeof input === "string"
            ? base("float_parsing", "Input should be a valid number, unable to parse string as a number")
            : base("float_type", "Input should be a valid number");
        case "boolean":
          return typeof input === "string"
            ? base("bool_parsing", "Input should be a valid boolean, unable to interpret input")
            : base("bool_type", "Input should be a valid boolean");
        case "array":
          return base("list_type", "Input should be a valid list");
        case "object":
          return base(
            "model_attributes_type",
            "Input should be a valid dictionary or object to extract fields from",
          );
        default:
          return base(`${expected}_type`, `Input should be a valid ${expected}`);
      }
    }
    case "too_small": {
      const n = issue.minimum;
      if (issue.origin === "string") {
        return base("string_too_short", `String should have at least ${plural(n, "character")}`, {
          min_length: n,
        });
      }
      if (issue.origin === "array" || issue.origin === "set") {
        const len = Array.isArray(input) ? input.length : 0;
        return base(
          "too_short",
          `List should have at least ${plural(n, "item")} after validation, not ${len}`,
          {
            field_type: "List",
            min_length: n,
            actual_length: len,
          },
        );
      }
      return issue.inclusive === false
        ? base("greater_than", `Input should be greater than ${n}`, { gt: n })
        : base("greater_than_equal", `Input should be greater than or equal to ${n}`, { ge: n });
    }
    case "too_big": {
      const n = issue.maximum;
      if (issue.origin === "string") {
        return base("string_too_long", `String should have at most ${plural(n, "character")}`, {
          max_length: n,
        });
      }
      if (issue.origin === "array" || issue.origin === "set") {
        const len = Array.isArray(input) ? input.length : 0;
        return base(
          "too_long",
          `List should have at most ${plural(n, "item")} after validation, not ${len}`,
          {
            field_type: "List",
            max_length: n,
            actual_length: len,
          },
        );
      }
      return issue.inclusive === false
        ? base("less_than", `Input should be less than ${n}`, { lt: n })
        : base("less_than_equal", `Input should be less than or equal to ${n}`, { le: n });
    }
    case "invalid_value":
      return base("literal_error", `Input should be ${orList(issue.values)}`, {
        expected: orList(issue.values),
      });
    case "invalid_format":
      switch (issue.format) {
        case "email": {
          const reason = emailReason(input);
          return base("value_error", `value is not a valid email address: ${reason}`, { reason });
        }
        case "uuid":
        case "guid":
          return base("uuid_parsing", "Input should be a valid UUID, invalid character", {
            error: "invalid character",
          });
        case "date":
          return base(
            "date_from_datetime_parsing",
            "Input should be a valid date or datetime, invalid date format",
            {
              error: "invalid date format",
            },
          );
        case "datetime":
          return base(
            "datetime_from_date_parsing",
            "Input should be a valid datetime or date, invalid datetime format",
            { error: "invalid datetime format" },
          );
        case "regex":
          return base(
            "string_pattern_mismatch",
            `String should match pattern '${patternSource(issue.pattern)}'`,
            {
              pattern: patternSource(issue.pattern),
            },
          );
        default:
          return base("value_error", `Value error, Invalid ${issue.format}`);
      }
    case "not_multiple_of":
      return base("multiple_of", `Input should be a multiple of ${issue.divisor}`, {
        multiple_of: issue.divisor,
      });
    case "invalid_union": {
      const first = issue.errors[0]?.[0];
      return first === undefined
        ? base("union_type", "Input should match one of the allowed types")
        : toPydantic({ ...first, path: [...issue.path, ...first.path] } as Issue, target, root, schema);
    }
    case "custom":
      return base("value_error", `Value error, ${issue.message}`, { error: issue.message });
    default:
      return base("value_error", `Value error, ${issue.message}`);
  }
}

/** 422 with the pydantic envelope for a failed parse. */
export function validationError(
  issues: readonly Issue[],
  target: Target,
  root: unknown,
  schema?: AnySchema,
): HttpError {
  return new HttpError(
    422,
    issues.map((i) => toPydantic(i, target, root, schema)),
  );
}

function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, target: Target): z.output<S> {
  const res = schema.safeParse(value);
  if (!res.success) throw validationError(res.error.issues, target, value, schema);
  return res.data;
}

const JSON_TYPE = /^application\/([a-z.-]+\+)?json\s*(;|$)/i;

/**
 * Validates a JSON body. Like FastAPI: a missing Content-Type is parsed as JSON, an empty body is
 * `[{"type":"missing","loc":["body"]}]`, malformed JSON is `json_invalid`, and a non-JSON Content-Type is a
 * `model_attributes_type` error.
 */
export function json<S extends z.ZodType, E extends Env = Env>(
  schema: S,
): MiddlewareHandler<E, string, { in: { json: z.input<S> }; out: { json: z.output<S> } }> {
  return async (c, next) => {
    const contentType = c.req.header("Content-Type");
    const raw = await c.req.text();
    let value: unknown;
    if (contentType !== undefined && !JSON_TYPE.test(contentType)) {
      value = raw;
    } else if (raw.trim() === "") {
      throw new HttpError(422, [{ type: "missing", loc: ["body"], msg: "Field required", input: null }]);
    } else {
      try {
        value = JSON.parse(raw);
      } catch (e) {
        throw new HttpError(422, [
          {
            type: "json_invalid",
            loc: ["body", 0],
            msg: "JSON decode error",
            input: {},
            ctx: { error: e instanceof Error ? e.message : "Expecting value" },
          },
        ]);
      }
    }
    c.req.addValidatedData("json", parseOrThrow(schema, value, "body") as object);
    await next();
  };
}

/** Validates the query string. Repeated keys arrive as arrays; use `z.coerce` for numbers and booleans. */
export function query<S extends z.ZodType, E extends Env = Env>(
  schema: S,
): MiddlewareHandler<E, string, { in: { query: z.input<S> }; out: { query: z.output<S> } }> {
  return async (c, next) => {
    const value = Object.fromEntries(
      Object.entries(c.req.queries()).map(([k, v]) => [k, v.length === 1 ? v[0] : v] as const),
    );
    c.req.addValidatedData("query", parseOrThrow(schema, value, "query") as object);
    await next();
  };
}

/** Validates path parameters (loc `["path", name]`). */
export function param<S extends z.ZodType, E extends Env = Env>(
  schema: S,
): MiddlewareHandler<E, string, { in: { param: z.input<S> }; out: { param: z.output<S> } }> {
  return async (c, next) => {
    c.req.addValidatedData("param", parseOrThrow(schema, c.req.param(), "path") as object);
    await next();
  };
}
