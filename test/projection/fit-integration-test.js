import assert from "node:assert";
import {it} from "vitest";
import {geoEquirectangular, geoOrthographic, geoPath} from "d3-geo";
import {assertInDelta, assertPathEqual} from "../asserts.js";

// Integration tests for the map-editor fitting workflow: the editor holds a
// projection configured with its own display window (clipExtent), centers a
// selection into a new layout rectangle with projection.fitExtent, and then
// draws with that same projection.
//
// Per the fitting contract:
// - the selection's shape and the layout rectangle's aspect ratio jointly
//   determine the scale and the letterbox margins;
// - the display window (clipExtent, a postclip) neither affects nor is
//   affected by the fit — it only clips what is subsequently drawn;
// - regions of the sphere that never reach the map at all (preclip, e.g.
//   clipAngle or the far side of an orthographic projection) do not count
//   toward the layout, unlike regions merely hidden by the display window.

// Clockwise exterior rings, per d3-geo's spherical winding convention.
const wideSelection = {type: "Polygon", coordinates: [[[-60, -20], [-60, 20], [60, 20], [60, -20], [-60, -20]]]}; // 120° × 40°
const tallSelection = {type: "Polygon", coordinates: [[[-20, -60], [-20, 60], [20, 60], [20, -60], [-20, -60]]]}; // 40° × 120°

it("projection.fitExtent(…) integration - a wide selection is width-constrained and centered with vertical margins", () => {
  const projection = geoEquirectangular().precision(0);
  projection.fitExtent([[50, 50], [450, 350]], wideSelection); // 400 × 300 layout
  assertInDelta(projection.scale(), 190.985932, 1e-6);
  assertInDelta(projection.translate(), [250, 200], 1e-6);
  // The selection spans the full layout width; equal 83.333px margins above and below.
  assertInDelta(geoPath(projection).bounds(wideSelection), [[50, 133.333333], [450, 266.666667]], 1e-6);
});

it("projection.fitExtent(…) integration - a tall selection is height-constrained and centered with horizontal margins", () => {
  const projection = geoEquirectangular().precision(0);
  projection.fitExtent([[50, 50], [450, 350]], tallSelection); // 400 × 300 layout
  assertInDelta(projection.scale(), 143.239449, 1e-6);
  assertInDelta(projection.translate(), [250, 200], 1e-6);
  // The selection spans the full layout height; equal 150px margins left and right.
  assertInDelta(geoPath(projection).bounds(tallSelection), [[200, 50], [300, 350]], 1e-6);
});

it("projection.fitExtent(…) integration - the editor's clipExtent is preserved by the fit", () => {
  const projection = geoEquirectangular()
      .precision(0)
      .clipExtent([[0, 0], [500, 400]]); // the editor's display window
  projection.fitExtent([[50, 50], [450, 350]], wideSelection);
  // The fit produces the same layout as without a window…
  assertInDelta(projection.scale(), 190.985932, 1e-6);
  assertInDelta(projection.translate(), [250, 200], 1e-6);
  // …and leaves the display window untouched for subsequent drawing.
  assert.deepStrictEqual(projection.clipExtent(), [[0, 0], [500, 400]]);
});

it("projection.fitExtent(…) integration - the display window clips the drawing, not the layout", () => {
  const windowless = geoEquirectangular().precision(0)
      .fitExtent([[50, 50], [450, 350]], wideSelection);
  const windowed = geoEquirectangular().precision(0)
      .clipExtent([[300, 150], [500, 300]]) // overlaps only part of the layout
      .fitExtent([[50, 50], [450, 350]], wideSelection);
  // Regions merely hidden by the display window still count toward the layout:
  // both projections compute identical scale and translate.
  assertInDelta(windowed.scale(), windowless.scale(), 1e-12);
  assertInDelta(windowed.translate(), windowless.translate(), 1e-12);
  // Drawing with the same projection afterwards is clipped to the window: the
  // drawn bounds are the intersection of the fitted layout and the window.
  assertInDelta(geoPath(windowless).bounds(wideSelection), [[50, 133.333333], [450, 266.666667]], 1e-6);
  assertInDelta(geoPath(windowed).bounds(wideSelection), [[300, 150], [450, 266.666667]], 1e-6);
  assertPathEqual(geoPath(windowless)(wideSelection), "M50,266.667L50,133.333L450,133.333L450,266.667Z");
  assertPathEqual(geoPath(windowed)(wideSelection), "M450,150L450,266.667L300,266.667L300,150Z");
});

it("projection.fitExtent(…) integration - sphere regions that never project do not count toward the layout", () => {
  const sphere = {type: "Sphere"};
  const extent = [[0, 0], [960, 500]];
  // Equirectangular projects the whole sphere: the full 2π × π extent counts.
  const equirectangular = geoEquirectangular().precision(0).fitExtent(extent, sphere);
  assertInDelta(equirectangular.scale(), 152.788745, 1e-6);
  assertInDelta(equirectangular.translate(), [480, 250], 1e-6);
  // Orthographic never projects the far hemisphere: only the visible disc
  // counts, so the same layout rectangle yields a larger scale.
  const orthographic = geoOrthographic().fitExtent(extent, sphere);
  assertInDelta(orthographic.scale(), 250, 1e-6);
  assertInDelta(orthographic.translate(), [480, 250], 1e-6);
  // A display window hides part of that disc when drawing, but the hidden
  // part still counts toward the layout: the fit is unchanged.
  const windowed = geoOrthographic().clipExtent([[0, 0], [100, 100]]).fitExtent(extent, sphere);
  assertInDelta(windowed.scale(), orthographic.scale(), 1e-12);
  assertInDelta(windowed.translate(), orthographic.translate(), 1e-12);
  assert.deepStrictEqual(windowed.clipExtent(), [[0, 0], [100, 100]]);
  // A clip angle, by contrast, keeps the region beyond 45° from ever
  // projecting: it does not count toward the layout, and the scale grows.
  const capped = geoOrthographic().clipAngle(45).fitExtent(extent, sphere);
  assertInDelta(capped.scale(), 353.607247, 1e-6);
  assertInDelta(capped.translate(), [480, 250], 1e-6);
  assert(capped.scale() > orthographic.scale());
});
