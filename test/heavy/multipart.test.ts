import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  boundaryOf,
  collectMultipart,
  FILE_TOO_LARGE,
  MULTIPART_PARSE_ERROR,
  readMultipart,
} from "../../src/heavy/multipart.ts";
import { HttpError } from "../../src/lib/errors.ts";
import { enc, streamOf } from "./helpers.ts";

const B = "----pacestreakBoundary7MA4YWxk";
const CT = `multipart/form-data; boundary=${B}`;

function body(file: Uint8Array): Uint8Array {
  const head = enc(
    `preamble\r\n--${B}\r\nContent-Disposition: form-data; name="discipline"\r\n\r\nrun\r\n` +
      `--${B}\r\nContent-Disposition: form-data; name="file"; filename="a \\"b\\".csv"\r\nContent-Type: text/csv\r\n\r\n`,
  );
  const tail = enc(`\r\n--${B}--\r\nepilogue`);
  return new Uint8Array([...head, ...file, ...tail]);
}

// File content that nearly contains the delimiter, to exercise the boundary scan at chunk edges.
const FILE = enc(`date,km\r\n2026-09-01,5\r\n\r\n--${B.slice(0, -1)}x\r\n--\r\n`);

async function errorOf(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error("expected an HttpError");
}

describe("multipart reader", () => {
  it("reads fields and files whatever the chunking (property)", async () => {
    const bytes = body(FILE);
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: bytes.length }), { maxLength: 20 }),
        async (cuts) => {
          const form = await collectMultipart(await streamOf(bytes, cuts), CT, { maxFileBytes: 1024 });
          expect(form.fields.get("discipline")).toBe("run");
          const file = form.files.get("file");
          expect(file?.filename).toBe('a "b".csv');
          expect(file?.contentType).toBe("text/csv");
          expect(file?.bytes).toEqual(FILE);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("streams the file part as data events", async () => {
    const events = [];
    for await (const ev of readMultipart(await streamOf(body(FILE), [50, 120, 121]), CT, {
      maxFileBytes: 1024,
    })) {
      events.push(ev.type);
    }
    expect(events[0]).toBe("part");
    expect(events.at(-1)).toBe("partEnd");
    expect(events.filter((e) => e === "part")).toHaveLength(2);
  });

  it("enforces the cap while streaming: 413 'That file is too large'", async () => {
    const big = new Uint8Array(5000).fill(0x61);
    const err = await errorOf(
      collectMultipart(await streamOf(body(big), [100, 2000]), CT, { maxFileBytes: 4096 }),
    );
    expect(err.status).toBe(413);
    expect(err.body).toEqual({ detail: FILE_TOO_LARGE });
    // Exactly at the cap is fine.
    const ok = await collectMultipart(await streamOf(body(big.subarray(0, 4096))), CT, {
      maxFileBytes: 4096,
    });
    expect(ok.files.get("file")?.bytes.length).toBe(4096);
    // A caller-supplied error (workouts import: 422 "That file is larger than 15 MB.").
    const custom = await errorOf(
      collectMultipart(await streamOf(body(big)), CT, {
        maxFileBytes: 10,
        tooLarge: () => new HttpError(422, "That file is larger than 15 MB."),
      }),
    );
    expect(custom.status).toBe(422);
  });

  it("rejects malformed bodies with 400", async () => {
    for (const bad of [
      enc(`--${B}\r\nContent-Disposition: form-data; name="x"\r\n\r\nunterminated`),
      enc(`--${B}\r\nNo-Colon\r\n\r\nx\r\n--${B}--`),
      enc(`--${B}\r\nContent-Type: text/plain\r\n\r\nx\r\n--${B}--`),
      enc("no boundary at all"),
    ]) {
      const err = await errorOf(collectMultipart(await streamOf(bad), CT, { maxFileBytes: 100 }));
      expect(err.status).toBe(400);
      expect(err.body).toEqual({ detail: MULTIPART_PARSE_ERROR });
    }
    expect(() => boundaryOf("application/json")).toThrow(HttpError);
    expect(boundaryOf('multipart/form-data; charset=utf-8; boundary="quoted b"')).toBe("quoted b");
  });

  it("parses a body built by the platform's FormData", async () => {
    const fd = new FormData();
    fd.append("dry_run", "true");
    fd.append("file", new File([FILE], "Checkmarks.csv", { type: "text/csv" }));
    const req = new Request("http://x/", { method: "POST", body: fd });
    const form = await collectMultipart(req.body, req.headers.get("content-type"), { maxFileBytes: 1024 });
    expect(form.fields.get("dry_run")).toBe("true");
    expect(form.files.get("file")?.bytes).toEqual(FILE);
    expect(form.files.get("file")?.filename).toBe("Checkmarks.csv");
  });
});
