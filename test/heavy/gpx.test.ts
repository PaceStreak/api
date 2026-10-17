import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FormatError } from "../../src/heavy/bytes.ts";
import {
  GPX_NOT_GPX,
  GPX_UNREADABLE,
  GpxReader,
  type GpxState,
  type GpxTrack,
  parseGpx,
} from "../../src/heavy/gpx.ts";
import { cutsFor, enc, feedSliced } from "./helpers.ts";

/** A Garmin-style export: namespaces, extensions, comments, CDATA, entities, a BOM and two tracks. */
const GARMIN = `﻿<?xml version="1.0" encoding="UTF-8"?>
<!-- exported -->
<gpx version="1.1" creator="Garmin Connect" xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata><name>not a track name</name><time>2026-09-01T06:00:00Z</time></metadata>
  <trk>
    <name>Morning &amp; Run &#x2615;</name>
    <type><![CDATA[running]]></type>
    <trkseg>
      <trkpt lat="51.5000" lon='-0.1200'><ele>10.0</ele><time>2026-09-01T06:00:00Z</time>
        <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>120</gpxtpx:hr><gpxtpx:hr>99</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>
      </trkpt>
      <trkpt lat="51.5010" lon="-0.1200"><ele> 14.5 </ele><time>2026-09-01T06:00:30Z</time></trkpt>
      <trkpt lat="51.5020" lon="-0.1200"/>
    </trkseg>
    <trkseg><trkpt lat="51.5030" lon="-0.1200"><time></time><ele>12<!-- c -->0</ele></trkpt></trkseg>
  </trk>
  <rte><rtept lat="1" lon="2"><time>2026-01-01T00:00:00Z</time></rtept></rte>
  <trk><name>  </name><trkseg><trkpt lat="1" lon="2"><time>2026-09-02T07:00:00+02:00</time></trkpt></trkseg></trk>
</gpx>
`;

const fixture = enc(GARMIN);

describe("gpx scanner", () => {
  it("extracts tracks, names, types and points like ElementTree would", () => {
    const tracks = parseGpx(fixture);
    expect(tracks).toEqual<GpxTrack[]>([
      {
        name: "Morning & Run ☕",
        type: "running",
        points: [
          { lat: "51.5000", lon: "-0.1200", ele: "10.0", time: "2026-09-01T06:00:00Z", hr: "120" },
          { lat: "51.5010", lon: "-0.1200", ele: "14.5", time: "2026-09-01T06:00:30Z", hr: null },
          { lat: "51.5020", lon: "-0.1200", ele: null, time: null, hr: null },
          // ElementTree drops comments and joins the text around them.
          { lat: "51.5030", lon: "-0.1200", ele: "120", time: null, hr: null },
        ],
      },
      {
        name: "",
        type: null,
        points: [{ lat: "1", lon: "2", ele: null, time: "2026-09-02T07:00:00+02:00", hr: null }],
      },
    ]);
  });

  it("rejects DOCTYPE and ENTITY declarations (defusedxml parity)", () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]><gpx><trk><name>&lol;</name></trk></gpx>`;
    expect(() => parseGpx(enc(bomb))).toThrow(new FormatError(GPX_UNREADABLE));
    expect(() => parseGpx(enc(`<gpx><!ENTITY x "y"></gpx>`))).toThrow(new FormatError(GPX_UNREADABLE));
    // Split right after "<!": still rejected once the next byte arrives.
    const r = new GpxReader();
    expect(r.push(enc("<?xml version='1.0'?><!"))).toEqual([]);
    expect(() => r.push(enc("DOCTYPE gpx>"))).toThrow(GPX_UNREADABLE);
  });

  it("rejects malformed XML, undefined entities and a non-GPX root", () => {
    for (const bad of [
      "<gpx><trk></gpx>",
      "<gpx><trk><name>a &foo; b</name></trk></gpx>",
      "<gpx><trk><name>a & b</name></trk></gpx>",
      "<gpx>",
      "<gpx></gpx><gpx></gpx>",
      "",
      "garbage<gpx></gpx>",
    ]) {
      expect(() => parseGpx(enc(bad)), bad).toThrow(new FormatError(GPX_UNREADABLE));
    }
    expect(() => parseGpx(enc("<kml><trk/></kml>"))).toThrow(new FormatError(GPX_NOT_GPX));
  });

  it("slice-at-any-offset equals whole-file parse (property)", () => {
    const whole = parseGpx(fixture);
    fc.assert(
      fc.property(cutsFor(fixture.length), (cuts) => {
        const { out } = feedSliced<GpxState, GpxTrack>(fixture, cuts, (st) => new GpxReader(st));
        expect(out).toEqual(whole);
      }),
      { numRuns: 300 },
    );
  });

  it("carries the open track across slices", () => {
    const cut = GARMIN.indexOf('<trkseg><trkpt lat="51.5030"');
    const bytes = enc(GARMIN);
    const at = enc(GARMIN.slice(0, cut)).length;
    const r = new GpxReader();
    expect(r.push(bytes.subarray(0, at))).toEqual([]);
    expect(r.state.track?.points).toHaveLength(3);
    const next = new GpxReader(JSON.parse(JSON.stringify(r.state)) as GpxState);
    expect(next.push(bytes.subarray(at))).toHaveLength(2);
    expect(next.end()).toEqual([]);
  });
});
