import assert from "node:assert";
import {it} from "vitest";
import {geoEquirectangular, geoOrthographic, geoPath} from "d3-geo";
import {assertInDelta} from "../asserts.js";

// The equirectangular projection below maps spherical coordinates to screen
// pixels as x = 480 + lambda * 5 and y = 250 - phi * 5 (lambda, phi in degrees),
// so every expected screen coordinate below is derivable directly from the
// geometry left on screen after clipping.
const equirectangular = () => geoEquirectangular()
    .scale(900 / Math.PI)
    .precision(0);

const BIG = 1e9;

function centroid(projection, object) {
  return geoPath()
      .projection(projection)
      .centroid(object);
}

// A square spanning lambda 0..10, phi 0..10. On screen it covers x 480..530 and
// y 200..250, so without clipping its area-weighted centroid is [505, 225].
const square = {type: "Polygon", coordinates: [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]]};

// ---------------------------------------------------------------------------
// Projection clipping (clipExtent): the label must sit on the centroid of the
// geometry that actually remains on screen, not of the original, unclipped path.
// ---------------------------------------------------------------------------

it("geoPath.centroid(…) of a polygon clipped to its left half follows the visible geometry", () => {
  // Keep screen x <= 505 (lambda <= 5): the visible rectangle is x 480..530 cut
  // down to x 480..505, whose centroid is x 492.5; the vertical extent is untouched.
  const projection = equirectangular().clipExtent([[-BIG, -BIG], [505, BIG]]);
  assert.deepStrictEqual(centroid(projection, square), [492.5, 225]);
});

it("geoPath.centroid(…) of a polygon clipped to a thin strip follows the visible geometry", () => {
  // Keep screen x <= 490 (lambda <= 2): only x 480..490 survives, centroid x 485.
  const projection = equirectangular().clipExtent([[-BIG, -BIG], [490, BIG]]);
  assert.deepStrictEqual(centroid(projection, square), [485, 225]);
});

it("geoPath.centroid(…) of a polygon clipped vertically follows the visible geometry", () => {
  // Keep screen y >= 240 (phi <= 2): only y 240..250 survives, centroid y 245.
  const projection = equirectangular().clipExtent([[-BIG, 240], [BIG, BIG]]);
  assert.deepStrictEqual(centroid(projection, square), [505, 245]);
});

it("geoPath.centroid(…) of a polygon clipped on both axes follows the visible geometry", () => {
  // Window x 485..500, y 210..235: a rectangle centred on [492.5, 222.5].
  const projection = equirectangular().clipExtent([[485, 210], [500, 235]]);
  assert.deepStrictEqual(centroid(projection, square), [492.5, 222.5]);
});

it("geoPath.centroid(…) differs from the unclipped centroid after clipping", () => {
  const unclipped = centroid(equirectangular(), square);
  const clipped = centroid(equirectangular().clipExtent([[-BIG, -BIG], [490, BIG]]), square);
  assert.deepStrictEqual(unclipped, [505, 225]);
  assert.deepStrictEqual(clipped, [485, 225]);
  assert.notDeepStrictEqual(clipped, unclipped);
});

it("geoPath.centroid(…) of a clipped linestring weights only the visible segment", () => {
  const line = {type: "LineString", coordinates: [[0, 0], [10, 0]]};
  // Full line runs screen x 480..530 at y 250; clipping to x <= 505 leaves the
  // segment x 480..505, whose length-weighted midpoint is x 492.5.
  const projection = equirectangular().clipExtent([[-BIG, -BIG], [505, BIG]]);
  assert.deepStrictEqual(centroid(projection, line), [492.5, 250]);
});

it("geoPath.centroid(…) of a clipped multipoint averages only visible points", () => {
  const multipoint = {type: "MultiPoint", coordinates: [[0, 0], [10, 0]]};
  // The second point (screen x 530) is clipped away, leaving only [480, 250].
  const projection = equirectangular().clipExtent([[-BIG, -BIG], [505, BIG]]);
  assert.deepStrictEqual(centroid(projection, multipoint), [480, 250]);
});

it("geoPath.centroid(…) is ambiguous when a polygon is fully clipped", () => {
  const projection = equirectangular().clipExtent([[0, 0], [10, 10]]);
  assert.strictEqual(centroid(projection, square).every(isNaN), true);
});

it("geoPath.centroid(…) is ambiguous when a linestring is fully clipped", () => {
  const line = {type: "LineString", coordinates: [[0, 0], [10, 0]]};
  const projection = equirectangular().clipExtent([[0, 0], [10, 10]]);
  assert.strictEqual(centroid(projection, line).every(isNaN), true);
});

it("geoPath.centroid(…) is ambiguous when a point is fully clipped", () => {
  const point = {type: "Point", coordinates: [0, 0]};
  const projection = equirectangular().clipExtent([[0, 0], [10, 10]]);
  assert.strictEqual(centroid(projection, point).every(isNaN), true);
});

it("geoPath.centroid(…) is ambiguous for an empty layer after clipping", () => {
  const projection = equirectangular().clipExtent([[0, 0], [10, 10]]);
  assert.strictEqual(centroid(projection, {type: "MultiPolygon", coordinates: []}).every(isNaN), true);
  assert.strictEqual(centroid(projection, {type: "GeometryCollection", geometries: []}).every(isNaN), true);
});

// ---------------------------------------------------------------------------
// Spherical clipping (clipAngle on an orthographic projection): only the front
// hemisphere is drawn, so geometry on the far side contributes nothing.
// ---------------------------------------------------------------------------

it("geoPath.centroid(…) ignores polygon geometry on the far side of the globe", () => {
  const orthographic = geoOrthographic().scale(200).translate([0, 0]).precision(0);
  // This ring sits around the antimeridian, entirely outside the visible limb.
  const farSide = {type: "Polygon", coordinates: [[[170, -10], [170, 10], [-170, 10], [-170, -10], [170, -10]]]};
  assert.strictEqual(centroid(orthographic, farSide).every(isNaN), true);
});

it("geoPath.centroid(…) of a polygon straddling the limb uses only the visible cap", () => {
  const orthographic = geoOrthographic().scale(200).translate([0, 0]).precision(0);
  // Symmetric about the projection centre, so the visible cap stays centred there.
  const straddling = {type: "Polygon", coordinates: [[[-10, -10], [-10, 10], [10, 10], [10, -10], [-10, -10]]]};
  assertInDelta(centroid(orthographic, straddling), [0, 0], 1e-6);
});

it("geoPath.centroid(…) of a rotated, limb-straddling polygon reflects the clipped cap", () => {
  // Rotating the globe pushes the square off-centre; the part surviving the
  // 90° clip circle has its centroid shifted in the opposite direction.
  const orthographic = geoOrthographic().scale(200).translate([0, 0]).precision(0).rotate([-30, 0]);
  const straddling = {type: "Polygon", coordinates: [[[-10, -10], [-10, 10], [10, 10], [10, -10], [-10, -10]]]};
  assertInDelta(centroid(orthographic, straddling), [-96.984631, 0], 1e-6);
});

// ---------------------------------------------------------------------------
// Mixed layers: when part of a layer is clipped away, the surviving geometry of
// the higher-dimension members still determines the label position.
// ---------------------------------------------------------------------------

it("geoPath.centroid(…) of a mixed layer falls back to the visible line when its polygon is fully clipped", () => {
  const orthographic = geoOrthographic().scale(200).translate([0, 0]).precision(0);
  const farSidePolygon = {type: "Polygon", coordinates: [[[170, -10], [170, 10], [-170, 10], [-170, -10], [170, -10]]]};
  const visibleLine = {type: "LineString", coordinates: [[-30, 0], [30, 0]]};
  const mixed = {type: "GeometryCollection", geometries: [farSidePolygon, visibleLine]};
  assertInDelta(centroid(orthographic, mixed), centroid(orthographic, visibleLine), 1e-6);
  assertInDelta(centroid(orthographic, mixed), [0, 0], 1e-6);
});

it("geoPath.centroid(…) of a mixed layer falls back to the visible point when its polygon is fully clipped", () => {
  const orthographic = geoOrthographic().scale(200).translate([0, 0]).precision(0);
  const farSidePolygon = {type: "Polygon", coordinates: [[[170, -10], [170, 10], [-170, 10], [-170, -10], [170, -10]]]};
  const visiblePoint = {type: "Point", coordinates: [0, 0]};
  const mixed = {type: "GeometryCollection", geometries: [farSidePolygon, visiblePoint]};
  assert.deepStrictEqual(centroid(orthographic, mixed), [0, 0]);
});

// ---------------------------------------------------------------------------
// Holes reduce the weight of the area they remove: the signed-area accumulator
// subtracts interior rings, shifting the centroid away from a large hole.
// Ring orientation follows the existing path tests (the exterior ring runs up
// the left edge and across the top; interior rings use the opposite winding).
// ---------------------------------------------------------------------------

it("geoPath.centroid(…) is unchanged by a symmetric, centred hole", () => {
  const exterior = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
  const centeredHole = [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]];
  const withHole = {type: "Polygon", coordinates: [exterior, centeredHole]};
  assert.deepStrictEqual(centroid(equirectangular(), withHole), [505, 225]);
});

it("geoPath.centroid(…) shifts away from a hole on the right", () => {
  const exterior = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
  // Hole covers lambda 6..9, phi 2..8 (screen x 510..525, centroid x 517.5).
  const rightHole = [[6, 2], [9, 2], [9, 8], [6, 8], [6, 2]];
  const withHole = {type: "Polygon", coordinates: [exterior, rightHole]};
  // (Ao * Cx - Ah * Hx) / (Ao - Ah), with Ao = 2500, Ah = 450:
  // (2500 * 505 - 450 * 517.5) / 2050 = 502.256097...
  assertInDelta(centroid(equirectangular(), withHole), [502.256098, 225], 1e-6);
});

it("geoPath.centroid(…) shifts away from a hole on the left", () => {
  const exterior = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
  // Mirror of the right-hand hole: lambda 1..4, phi 2..8.
  const leftHole = [[1, 2], [4, 2], [4, 8], [1, 8], [1, 2]];
  const withHole = {type: "Polygon", coordinates: [exterior, leftHole]};
  assertInDelta(centroid(equirectangular(), withHole), [507.743902, 225], 1e-6);
});

it("geoPath.centroid(…) treats left and right holes as mirror images about the centre", () => {
  const exterior = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
  const rightHole = [[6, 2], [9, 2], [9, 8], [6, 8], [6, 2]];
  const leftHole = [[1, 2], [4, 2], [4, 8], [1, 8], [1, 2]];
  const right = centroid(equirectangular(), {type: "Polygon", coordinates: [exterior, rightHole]});
  const left = centroid(equirectangular(), {type: "Polygon", coordinates: [exterior, leftHole]});
  assertInDelta(505 - (right[0] - 505), left[0], 1e-6);
  assert.strictEqual(right[1], left[1]);
});

// ---------------------------------------------------------------------------
// Laying out successive layers reuses one path instance; every result must be
// determined solely by the current object because result() resets the
// accumulators, including a layer with no drawable position.
// ---------------------------------------------------------------------------

it("geoPath.centroid(…) resets between successive layers on the same path", () => {
  const orthographic = geoOrthographic().scale(200).translate([0, 0]).precision(0);
  const path = geoPath().projection(orthographic);
  const farSide = {type: "Polygon", coordinates: [[[170, -10], [170, 10], [-170, 10], [-170, -10], [170, -10]]]};
  const straddling = {type: "Polygon", coordinates: [[[-10, -10], [-10, 10], [10, 10], [10, -10], [-10, -10]]]};
  const point = {type: "Point", coordinates: [0, 0]};

  assert.strictEqual(path.centroid(farSide).every(isNaN), true);
  assertInDelta(path.centroid(straddling), [0, 0], 1e-6);
  // Re-running the empty layer must still be ambiguous, with no state carried
  // over from the non-empty straddling layer.
  assert.strictEqual(path.centroid(farSide).every(isNaN), true);
  assert.deepStrictEqual(path.centroid(point), [0, 0]);
});

it("geoPath.centroid(…) on clipped layers is independent across calls", () => {
  const path = geoPath();
  const leftStrip = equirectangular().clipExtent([[-BIG, -BIG], [490, BIG]]);
  const bottomStrip = equirectangular().clipExtent([[-BIG, 240], [BIG, BIG]]);

  assert.deepStrictEqual(path.projection(leftStrip).centroid(square), [485, 225]);
  assert.deepStrictEqual(path.projection(bottomStrip).centroid(square), [505, 245]);
  // Switching back reproduces the first result rather than blending the two.
  assert.deepStrictEqual(path.projection(leftStrip).centroid(square), [485, 225]);
});
