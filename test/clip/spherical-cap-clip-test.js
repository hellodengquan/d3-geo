import assert from "node:assert";
import {describe, it} from "vitest";
import {geoClipCircle, geoCircle, geoContains, geoOrthographic, geoRotation, geoStream, geoTransform} from "d3-geo";

// ---------------------------------------------------------------------------
// Spherical-cap clipping integration tests
//
// A clip cap is the set of unit-sphere points whose angular distance from the
// center [0, 0] is smaller than a radius R:  cos(lambda) cos(phi) > cos(R).
// Its boundary is a small circle. These tests treat the clipper as a black box
// and judge every result against independent spherical geometry (great-circle
// interpolation, angular distance, bisection at the small circle), rather than
// against screen coordinates, so they remain valid for any projection.
// ---------------------------------------------------------------------------

const radians = Math.PI / 180;
const degrees = 180 / Math.PI;
const D = (v) => v * radians; // degrees -> radians
const EPS = 1e-4;

// -- unit-vector / spherical helpers ---------------------------------------

function toCartesian(p) {
  const cp = Math.cos(p[1]);
  return [cp * Math.cos(p[0]), cp * Math.sin(p[0]), Math.sin(p[1])];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

// Angular distance between two spherical points (radians), clamped to [0, pi].
function angularDistance(a, b) {
  return Math.acos(Math.max(-1, Math.min(1, dot(toCartesian(a), toCartesian(b)))));
}

// Slerp along the unique great-circle arc from a to b; t in [0, 1].
function greatCirclePoint(a, b, t) {
  const d = angularDistance(a, b);
  if (d < 1e-12) return a.slice();
  const sa = Math.sin(d);
  const A = Math.sin((1 - t) * d) / sa;
  const B = Math.sin(t * d) / sa;
  const va = toCartesian(a), vb = toCartesian(b);
  const p = norm([
    A * va[0] + B * vb[0],
    A * va[1] + B * vb[1],
    A * va[2] + B * vb[2]
  ]);
  return [Math.atan2(p[1], p[0]), Math.asin(Math.max(-1, Math.min(1, p[2])))];
}

// Independent spherical-cap visibility test: angular distance from cap center.
function capVisible(p, R) {
  return Math.cos(angularDistance(p, [0, 0])) > Math.cos(R);
}

// Reference visible t-intervals of a single great-circle arc a->b inside a cap.
// The route is sampled densely; each visibility transition is refined by
// bisection to the exact small-circle crossing, so the expected intervals are
// grounded in the sphere/small-circle intersection, independent of the clipper.
function expectedVisibleIntervals(a, b, R, samples = 720) {
  const at = (t) => greatCirclePoint(a, b, t);
  const vis = (t) => capVisible(at(t), R);
  const findCrossing = (lo, hi) => {
    let vLo = vis(lo);
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      const vMid = vis(mid);
      if (vMid === vLo) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const intervals = [];
  let inside = vis(0);
  let start = inside ? 0 : null;
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    if (vis(t) !== inside) {
      const c = findCrossing((i - 1) / samples, t);
      if (inside) {
        intervals.push([start, c]);
        start = null;
      } else {
        start = c;
      }
      inside = !inside;
    }
  }
  if (inside) intervals.push([start, 1]);
  return intervals;
}

// Signed spherical area of a closed ring (radians), via spherical excess.
function signedSphericalArea(ring) {
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = toCartesian(ring[i]);
    const b = toCartesian(ring[(i + 1) % n]);
    const cross = [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
    const l = Math.hypot(cross[0], cross[1], cross[2]);
    // atan2 of the unit normal's z-component against 1 + a.b gives a signed
    // angle; skipping zero-length cross products avoids a 0/0 at the poles.
    if (l > 0) sum += Math.atan2(cross[2] / l, dot(a, b) + 1);
  }
  return sum;
}

// -- stream capture --------------------------------------------------------

// Records the clipped stream as a list of lines and nested polygons, keeping
// the spherical (lambda, phi) coordinates the clipper emits.
function recorder() {
  const lines = [];
  const polygons = [];
  let line = null;
  let ring = null;
  let polygon = null;
  return {
    point(x, y) { (ring || line).push([x, y]); },
    lineStart() {
      if (polygon) { ring = []; polygon.push(ring); }
      else { line = []; lines.push(line); }
    },
    lineEnd() { ring = null; line = null; },
    polygonStart() { polygon = []; polygons.push(polygon); },
    polygonEnd() { polygon = null; },
    lines,
    polygons
  };
}

function clipGeometry(object, radiusDegrees) {
  const sink = recorder();
  geoStream(object, geoClipCircle(D(radiusDegrees))(sink));
  return sink;
}

function lineObject(coordsDegrees) {
  return {type: "LineString", coordinates: coordsDegrees.map(([x, y]) => [D(x), D(y)])};
}

// Best t on arc a->b matching a clipped point (the clipper samples the
// great circle, so endpoints may not coincide exactly with input vertices).
// A coarse grid pass localizes the minimum, then a fine pass refines it so
// shallow small-circle crossings are still located precisely.
function nearestT(p, a, b) {
  function scan(steps, lo, hi) {
    let best = lo, bestD = Infinity;
    for (let i = 0; i <= steps; i++) {
      const t = lo + (hi - lo) * (i / steps);
      const d = angularDistance(p, greatCirclePoint(a, b, t));
      if (d < bestD) bestD = d, best = t;
    }
    return {t: best, distance: bestD};
  }
  const coarse = scan(500, 0, 1);
  return scan(200, Math.max(0, coarse.t - 1 / 250), Math.min(1, coarse.t + 1 / 250));
}

// ===========================================================================
// 1. Great-circle routes: visible intervals and travel direction
// ===========================================================================

describe("geoClipCircle: great-circle route visibility", () => {
  const cases = [
    {name: "short cap, equator crossing", radius: 60, coords: [[-80, 0], [80, 0]]},
    {name: "short cap, slanted route", radius: 60, coords: [[-70, -40], [70, 40]]},
    {name: "short cap, meridian crossing", radius: 50, coords: [[0, -80], [0, 80]]},
    {name: "hemisphere cap", radius: 90, coords: [[-120, 20], [120, 20]]},
    {name: "large cap wrapping past the hemisphere", radius: 120, coords: [[-100, 0], [100, 0]]},
    {name: "tiny cap, route grazes the center", radius: 30, coords: [[-40, 5], [40, 5]]}
  ];

  for (const c of cases) {
    it(`recovers the visible interval(s) and endpoints on the small circle — ${c.name}`, () => {
      const a = c.coords[0].map(D), b = c.coords[1].map(D), R = D(c.radius);
      const out = clipGeometry(lineObject(c.coords), c.radius);
      const expected = expectedVisibleIntervals(a, b, R);

      // One output line per connected visible run.
      assert.strictEqual(out.lines.length, expected.length,
        `expected ${expected.length} visible run(s), got ${out.lines.length}`);

      out.lines.forEach((seg, i) => {
        const [t0, t1] = expected[i];
        const first = nearestT(seg[0], a, b);
        const last = nearestT(seg[seg.length - 1], a, b);

        // The emitted run spans exactly the analytically visible t-interval.
        assert.ok(Math.abs(first.t - t0) < 2e-3, `run ${i} start t ${first.t} != ${t0}`);
        assert.ok(Math.abs(last.t - t1) < 2e-3, `run ${i} end t ${last.t} != ${t1}`);

        // Interior and boundary points of the run lie on the input great circle.
        for (const p of seg) {
          assert.ok(angularDistance(p, greatCirclePoint(a, b, nearestT(p, a, b).t)) < 1e-4);
        }

        // Any interval that starts/ends inside the open cap must do so at t=0/t=1;
        // every other endpoint sits on the small circle (the true intersection).
        const onBoundary = (p) => Math.abs(angularDistance(p, [0, 0]) - R) < 2e-4;
        if (t0 > 1e-6) assert.ok(onBoundary(seg[0]), "entry point must lie on the small circle");
        if (t1 < 1 - 1e-6) assert.ok(onBoundary(seg[seg.length - 1]), "exit point must lie on the small circle");
      });
    });
  }

  it("emits nothing when the whole route is outside the cap", () => {
    const out = clipGeometry(lineObject([[100, 30], [140, 50]]), 45);
    assert.strictEqual(out.lines.length, 0);
  });

  it("passes the route through untouched when fully inside the cap", () => {
    const out = clipGeometry(lineObject([[-20, 10], [20, -10]]), 70);
    assert.strictEqual(out.lines.length, 1);
    const seg = out.lines[0];
    assert.ok(angularDistance(seg[0], [D(-20), D(10)]) < EPS);
    assert.ok(angularDistance(seg[seg.length - 1], [D(20), D(-10)]) < EPS);
  });

  it("splits a long route into several ordered visible runs (large cap)", () => {
    // With a >90° cap this equatorial route is visible near both ends and
    // hidden through the middle as it runs over the far side of the sphere.
    const coords = [[-100, 0], [100, 0]];
    const a = coords[0].map(D), b = coords[1].map(D), R = D(120);
    const out = clipGeometry(lineObject(coords), 120);
    const expected = expectedVisibleIntervals(a, b, R);
    assert.ok(expected.length >= 2, "reference geometry must predict multiple runs");
    assert.strictEqual(out.lines.length, expected.length);
    // Runs stay ordered along t.
    const ts = out.lines.map((seg) => nearestT(seg[0], a, b).t);
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] > ts[i - 1]);
  });

  it("preserves travel direction: reversing the route reverses every run", () => {
    const forward = [[-70, -40], [70, 40]];
    const backward = [[70, 40], [-70, -40]];
    const f = clipGeometry(lineObject(forward), 60).lines;
    const g = clipGeometry(lineObject(backward), 60).lines;
    assert.strictEqual(f.length, g.length);
    assert.strictEqual(f.length, 1);

    // Same covered arc, opposite point order.
    const fSeg = f[0], gSeg = g[0];
    assert.strictEqual(fSeg.length, gSeg.length);
    for (let i = 0; i < fSeg.length; i++) {
      assert.ok(angularDistance(fSeg[i], gSeg[gSeg.length - 1 - i]) < 1e-4);
    }
    // And the first forward point is the entry, with t increasing along the run.
    const a = forward[0].map(D), b = forward[1].map(D);
    const tFirst = nearestT(fSeg[0], a, b).t;
    const tLast = nearestT(fSeg[fSeg.length - 1], a, b).t;
    assert.ok(tLast > tFirst, "forward run must travel from entry toward exit");
    const ga = backward[0].map(D), gb = backward[1].map(D);
    // The reversed route still moves forward along its own a->b parameter.
    assert.ok(nearestT(gSeg[gSeg.length - 1], ga, gb).t > nearestT(gSeg[0], ga, gb).t);
  });

  it("treats the endpoints of a multi-vertex route as one continuous great-circle path", () => {
    const coords = [[-100, 0], [-30, 0], [30, 0], [100, 0]];
    const out = clipGeometry(lineObject(coords), 60);
    // All visible vertices share one run because each adjacent pair is connected.
    assert.strictEqual(out.lines.length, 1);
    const lons = out.lines[0].map((p) => p[0] * degrees);
    assert.ok(Math.abs(lons[0] - -60) < 0.1 && Math.abs(lons[lons.length - 1] - 60) < 0.1);
  });
});

// ===========================================================================
// 2. Filled borders: which side of the boundary the fill keeps
// ===========================================================================

describe("geoClipCircle: filled polygon side after small-circle closure", () => {
  // A rectangle straddling the 60° cap boundary, oriented counter-clockwise so
  // its interior is the box (d3: clockwise rings denote holes/exterior).
  // Coordinates in radians.
  const ringRad = (reverse) => {
    const r = [[30, -30], [30, 30], [90, 30], [90, -30], [30, -30]].map(([x, y]) => [D(x), D(y)]);
    return reverse ? r.reverse() : r;
  };
  const R = D(60);

  // Probe points (degrees). The interior probes are cap-visible box points;
  // the exterior probes are cap-visible points outside the box, so containment
  // alone decides which side of the border the fill keeps.
  const insideOriginal = [[50, 0], [40, 20]];
  const outsideOriginal = [[10, 0], [0, 40]];

  function clippedPolygon(radiusDegrees, reverse) {
    const out = clipGeometry({type: "Polygon", coordinates: [ringRad(reverse)]}, radiusDegrees);
    assert.strictEqual(out.polygons.length, 1);
    return out.polygons[0];
  }

  function asGeo(ring) {
    return {type: "Polygon", coordinates: [ring.map((p) => [p[0] * degrees, p[1] * degrees])]};
  }

  it("keeps the original interior: original-inside points remain contained", () => {
    const geo = asGeo(clippedPolygon(60, false)[0]);
    for (const p of insideOriginal) {
      assert.ok(capVisible([D(p[0]), D(p[1])], R), "probe must be cap-visible");
      assert.ok(geoContains(geo, p), `interior point ${p} must stay inside the clipped fill`);
    }
  });

  it("excludes the original exterior even when it is inside the cap", () => {
    const geo = asGeo(clippedPolygon(60, false)[0]);
    for (const p of outsideOriginal) {
      assert.ok(capVisible([D(p[0]), D(p[1])], R), "probe must be cap-visible");
      assert.ok(!geoContains(geo, p), `exterior point ${p} must not enter the clipped fill`);
    }
  });

  it("joins border fragments along the cap small circle, taking the arc that closes the interior", () => {
    const rings = clippedPolygon(60, false);
    const ring = rings[0];

    // The output ring mixes original border vertices with generated closure
    // points. Every generated point must lie on the small circle...
    const closurePoints = ring.filter((p) => Math.abs(angularDistance(p, [0, 0]) - R) < 2e-3);
    assert.ok(closurePoints.length > 2, "a small-circle closure arc should be present");

    // ...and the arc must connect the two border intersections while staying
    // inside the cap (the fill side), never on the far/outside arc.
    for (const p of closurePoints) {
      assert.ok(capVisible(p, R) || Math.abs(angularDistance(p, [0, 0]) - R) < 2e-3,
        "closure arc must run along the visible small circle, not outside the cap");
    }

    // Both intersection anchors exist where the original border meets the circle.
    const anchors = ring.filter((p) => Math.abs(angularDistance(p, [0, 0]) - R) < 2e-3);
    assert.ok(anchors.length >= 2);
  });

  it("reversing the drawing orientation reverses the clipped ring winding", () => {
    // The same border traversed in opposite direction. d3 treats clockwise
    // rings as holes, so the point of the test is orientation and arc choice,
    // not pointwise equality.
    const ccw = clippedPolygon(60, false)[0];
    const cw = clippedPolygon(60, true)[0];

    // Signed spherical area flips sign with drawing direction...
    const aCcw = signedSphericalArea(ccw);
    const aCw = signedSphericalArea(cw);
    assert.ok(Math.abs(aCcw) > 1e-6 && Math.abs(aCw) > 1e-6, "rings must have measurable area");
    assert.ok(aCcw * aCw < 0, "reversed input must produce a reversed (opposite winding) ring");

    // ...both rings cut the cap boundary at the same two intersection points
    // (the original border crosses the small circle on two of its edges). The
    // two anchors are the non-arc endpoints: the boundary points that sit
    // directly next to an original border vertex, identified as the boundary
    // points whose predecessor or successor in the ring is off the small circle.
    const onBoundary = (p) => Math.abs(angularDistance(p, [0, 0]) - R) < 3e-3;
    const anchorsOf = (ring) => ring.filter((p, i) => {
      if (!onBoundary(p)) return false;
      const prev = ring[(i - 1 + ring.length) % ring.length];
      const next = ring[(i + 1) % ring.length];
      return !onBoundary(prev) || !onBoundary(next);
    });
    const ccwAnchors = anchorsOf(ccw);
    const cwAnchors = anchorsOf(cw);
    assert.strictEqual(ccwAnchors.length, 2, "the fill ring must keep both border intersections");
    assert.strictEqual(cwAnchors.length, 2, "the reversed ring must keep both border intersections");
    for (const a of ccwAnchors) {
      assert.ok(cwAnchors.some((b) => angularDistance(a, b) < 3e-3),
        "both rings must share the same border/circle intersections");
    }

    // ...but they keep opposite sides: the fill ring takes the short arc that
    // encloses the original box, the hole ring the long complementary arc.
    const arcLength = (ring) => {
      let total = 0;
      for (let i = 1; i < ring.length; i++) total += angularDistance(ring[i - 1], ring[i]);
      return total;
    };
    assert.ok(arcLength(cw) > arcLength(ccw),
      "the hole (reversed) ring must follow the long arc, the fill ring the short interior-closing arc");
  });

  it("leaves a fully-inside polygon border intact (no closure arc)", () => {
    const ring = [[-20, -20], [-20, 20], [20, 20], [20, -20], [-20, -20]].map(([x, y]) => [D(x), D(y)]);
    const out = clipGeometry({type: "Polygon", coordinates: [ring]}, 70);
    assert.strictEqual(out.polygons.length, 1);
    const produced = out.polygons[0][0];
    // No point is generated on the boundary: all are original vertices.
    for (const p of produced) {
      assert.ok(Math.abs(angularDistance(p, [0, 0]) - D(70)) > 1e-3);
    }
  });

  it("drops a polygon lying wholly outside the cap", () => {
    // Counter-clockwise box entirely on the far side of a 45° cap.
    const ring = [[100, 20], [100, 60], [140, 60], [140, 20], [100, 20]].map(([x, y]) => [D(x), D(y)]);
    const out = clipGeometry({type: "Polygon", coordinates: [ring]}, 45);
    assert.strictEqual(out.polygons.length, 0);
  });

  it("replaces an enclosing polygon with the full cap boundary, interior toward the cap center", () => {
    // An 80° small-circle polygon encloses the whole 60° cap.
    const ring = geoCircle().radius(80).precision(1)().coordinates[0].map(([x, y]) => [D(x), D(y)]);
    const out = clipGeometry({type: "Polygon", coordinates: [ring]}, 60);
    assert.strictEqual(out.polygons.length, 1);
    const produced = out.polygons[0][0];
    for (const p of produced) {
      assert.ok(Math.abs(angularDistance(p, [0, 0]) - D(60)) < 2e-3,
        "result must trace the cap small circle");
    }
    // The cap center is the retained side and stays contained.
    const geo = {type: "Polygon", coordinates: [produced.map((p) => [p[0] * degrees, p[1] * degrees])]};
    assert.ok(geoContains(geo, [0, 0]));
  });
});

// ===========================================================================
// 3. End-to-end through a projection: view rotation, view size and reflection
//
// The projection pipeline is rotate -> cap preclip -> project/resample. The
// preclip stage itself is the same geoClipCircle tested above; here we verify
// how the projection drives it through rotation, clip angle (view size) and
// reflection. Angular/visibility assertions are made on the spherical preclip
// output (independent of projected pixel scale), while the full pipeline is
// used to prove rotation and reflection change / preserve visibility.
// ===========================================================================

describe("geoClipCircle through geoOrthographic (rotation / view size / reflection)", () => {
  function projectedLines(projection, object) {
    const lines = [];
    let line = null;
    const sink = {
      point(x, y) { line.push([x, y]); },
      lineStart() { line = []; lines.push(line); },
      lineEnd() { line = null; },
      polygonStart() {}, polygonEnd() {}, sphere() {}
    };
    geoStream(object, projection.stream(sink));
    return lines;
  }

  // Runs the projection's spherical pipeline up to (and including) its cap
  // preclip: rotate -> preclip. Coordinates stay spherical (radians), so the
  // boundary is judged by angular distance rather than projected pixels.
  // Bare points are collected separately from lines.
  function preclipLines(projection, object) {
    const lines = [];
    const points = [];
    let line = null;
    const sink = {
      point(x, y) { (line || points).push([x, y]); },
      lineStart() { line = []; lines.push(line); },
      lineEnd() { line = null; },
      polygonStart() {}, polygonEnd() {}, sphere() {}
    };
    // Reproduce the projection's pre-rotation in spherical coordinates.
    const [rl, rp] = projection.rotate();
    const rotate = geoRotation([rl, rp]);
    const rotator = geoTransform({
      point(x, y) { this.stream.point(...rotate([x * degrees, y * degrees]).map((v) => v * radians)); }
    });
    geoStream(object, rotator.stream(projection.preclip()(sink)));
    return object.type === "Point" ? (points.length ? [points] : []) : lines;
  }

  const hasAnyLine = (lines) => lines.length > 0;

  it("hides the far hemisphere and keeps the near hemisphere (full 90° view)", () => {
    const projection = geoOrthographic().clipAngle(90);
    // Visibility is judged on the projection's spherical cap preclip, the stage
    // that actually decides near vs. far; this is independent of pixel scaling.
    assert.ok(hasAnyLine(preclipLines(projection, lineObject([[0, 0], [5, 0]]))),
      "the view-center hemisphere must be visible");
    assert.strictEqual(preclipLines(projection, lineObject([[180, 0], [175, 0]])).length, 0,
      "the antipodal (far) hemisphere must be clipped out");
    assert.strictEqual(preclipLines(projection, {type: "Point", coordinates: [D(180), 0]}).length, 0,
      "a bare far-side point must be clipped out");
  });

  it("changes which side is visible when the globe is rotated", () => {
    const front = geoOrthographic().rotate([0, 0]).clipAngle(90);
    const rotated = geoOrthographic().rotate([-90, 0]).clipAngle(90);

    // [0,0] faces the viewer in the default view...
    assert.ok(hasAnyLine(preclipLines(front, lineObject([[0, 0], [5, 0]]))));
    // ...and moves to the far side after a 90° rotation.
    assert.strictEqual(preclipLines(rotated, lineObject([[0, 0], [-5, 0]])).length, 0);
    // A formerly far-side point rotates into view instead.
    assert.ok(hasAnyLine(preclipLines(rotated, lineObject([[90, 0], [85, 0]]))));

    // The near-side feature likewise reaches the full projected pipeline.
    assert.ok(hasAnyLine(projectedLines(rotated, lineObject([[90, 0], [85, 0]]))));
  });

  it("honors clip angle as the view size, cutting on the corresponding small circle", () => {
    const R = D(45);
    const narrow = geoOrthographic().clipAngle(45);
    // A great-circle route from deep inside the cap out well beyond it.
    const lines = preclipLines(narrow, lineObject([[10, 0], [70, 0]]));
    assert.strictEqual(lines.length, 1);
    const seg = lines[0];

    // Every surviving point is inside the cap; the run starts at the interior
    // endpoint and ends exactly on the 45° small circle.
    for (const p of seg) assert.ok(capVisible(p, R) || Math.abs(angularDistance(p, [0, 0]) - R) < 2e-4);
    assert.ok(angularDistance(seg[0], [D(10), 0]) < EPS);
    assert.ok(Math.abs(angularDistance(seg[seg.length - 1], [0, 0]) - R) < 2e-4,
      "the narrow view must terminate on its 45° small circle");

    // A route wholly beyond 45° but inside the 90° limb is removed entirely.
    const outer = preclipLines(narrow, lineObject([[50, 0], [70, 0]]));
    assert.strictEqual(outer.length, 0);

    // The same outer route survives under a full 90° view (view size matters).
    const wide = geoOrthographic().clipAngle(90);
    assert.ok(hasAnyLine(preclipLines(wide, lineObject([[50, 0], [70, 0]]))));
  });

  it("keeps the same visible set under reflection while reversing projected x", () => {
    const object = lineObject([[-50, -30], [50, 30]]);
    const plain = geoOrthographic().clipAngle(90);
    const mirror = geoOrthographic().clipAngle(90).reflectX(true);

    // Reflection does not change the cap, so clipping visibility is identical:
    // both runs keep the same number of emitted points.
    const a = projectedLines(plain, object);
    const b = projectedLines(mirror, object);
    assert.strictEqual(a.length, b.length);
    assert.strictEqual(a.length, 1);
    assert.strictEqual(a[0].length, b[0].length);

    // Spherical preclip output (the actual visibility decision) is unchanged by
    // reflection: identical point sequences on the sphere, preserving order.
    const sa = preclipLines(plain, object)[0];
    const sb = preclipLines(mirror, object)[0];
    assert.strictEqual(sa.length, sb.length);
    for (let i = 0; i < sa.length; i++) {
      assert.ok(angularDistance(sa[i], sb[i]) < 1e-9,
        "reflection must not alter which spherical points are visible or their order");
    }

    // In the projected plane the geometry is mirrored about the central
    // meridian: equal |x| about the translate center, identical y.
    const tx = plain.translate()[0];
    for (let i = 0; i < a[0].length; i++) {
      assert.ok(Math.abs((a[0][i][0] - tx) + (b[0][i][0] - tx)) < 1e-6);
      assert.ok(Math.abs(a[0][i][1] - b[0][i][1]) < 1e-6);
    }
  });
});
