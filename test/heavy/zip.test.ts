import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { FormatError } from "../../src/heavy/bytes.ts";
import { listZip, readZipEntry, ZIP_UNREADABLE, ZipStream, zipFiles } from "../../src/heavy/zip.ts";
import { enc } from "./helpers.ts";

const tooLarge = () => new Error("too large");

describe("zip", () => {
  it("writes entries in order and reads them back", () => {
    const zip = zipFiles([
      { name: "workouts.csv", data: "id,date\r\n" },
      { name: "photos/a.jpg", data: new Uint8Array([1, 2, 3]) },
      { name: "README.txt", data: "hello" },
    ]);
    expect(listZip(zip).map((e) => e.name)).toEqual(["workouts.csv", "photos/a.jpg", "README.txt"]);
    expect(new TextDecoder().decode(readZipEntry(zip, "README.txt", 100, tooLarge))).toBe("hello");
  });

  it("refuses entries over the cap by declared size, and missing or damaged archives", () => {
    const zip = zipFiles([{ name: "Checkmarks.csv", data: "x".repeat(1000) }]);
    expect(() => readZipEntry(zip, "Checkmarks.csv", 999, tooLarge)).toThrow("too large");
    expect(() => readZipEntry(zip, "missing.csv", 9999, tooLarge)).toThrow(new FormatError(ZIP_UNREADABLE));
    expect(() => listZip(enc("not a zip"))).toThrow(new FormatError(ZIP_UNREADABLE));
    expect(() => listZip(zip.subarray(0, 30))).toThrow(new FormatError(ZIP_UNREADABLE));
  });

  it("checks the inflated size too, when the directory lies", () => {
    const zip = zipSync({ "a.csv": new Uint8Array(5000) });
    // Patch the declared uncompressed size (central directory and local header) down to 10 bytes.
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    view.setUint32(22, 10, true);
    for (let i = 0; i < zip.length - 4; i++) {
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 10, true);
    }
    expect(() => readZipEntry(zip, "a.csv", 100, tooLarge)).toThrow("too large");
  });

  it("streams a zip entry by entry", async () => {
    const z = new ZipStream();
    const done = new Response(z.readable).arrayBuffer();
    await z.add(
      "a.csv",
      (function* () {
        yield "id\r\n";
        yield enc("1\r\n");
      })(),
    );
    await z.add("README.txt", "hi");
    z.finish();
    const files = unzipSync(new Uint8Array(await done));
    expect(Object.keys(files)).toEqual(["a.csv", "README.txt"]);
    expect(new TextDecoder().decode(files["a.csv"])).toBe("id\r\n1\r\n");
  });
});
