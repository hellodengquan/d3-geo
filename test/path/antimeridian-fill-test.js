// Integration tests for the filled region of spherical polygons that cross the
// antimeridian. On the projected world map the two shores of the Pacific are
// drawn against the left and right edges of the canvas; a polygon that crosses
// the date line must be cut at both edges and each piece filled separately, so
// that the land (and any enclosed lake) rejoins the outline it belongs to.
//
// The filled region is the ground truth here: every probe samples the pixels
// that the canvas path actually paints (and, as a cross-check, the spherical
// containment reported by geoContains).
import assert from "node:assert";
import {readFile} from "node:fs/promises";
import {it} from "vitest";
import {Canvas} from "canvas";
import {feature} from "topojson-client";
import {
  geoCircle,
  geoContains,
  geoEquirectangular,
  geoPath
} from "d3-geo";

const width = 960;
const height = 480;
const margin = 48;
const scale = (width - 2 * margin) / (2 * Math.PI);

// Five probes per sample: the pixel itself and four pixels two steps away.
// A sample only counts when all five agree, which keeps every assertion away
// from antialiased edges and from the seam itself.
const stencil = [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]];

// Rotations that move the cut to a different meridian.
const rotations = [[180, 0], [90, 0], [-90, 0], [45, 0], [-45, 0]];

// The default projection places the date line at the left and right edges,
// with a generous margin so that both sides of the cut are drawn.
function projection(rotate) {
  const p = geoEquirectangular()
      .scale(scale)
      .translate([width / 2, height / 2])
      .precision(0.1);
  return rotate ? p.rotate(rotate) : p;
}

function rasterize(object, p) {
  const canvas = new Canvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.beginPath();
  geoPath(p, context)(object);
  context.fillStyle = "#000";
  context.fill();
  return context.getImageData(0, 0, width, height).data;
}

// Classify the filled region at a geographic point: "land" for a solidly
// painted block, "water" for a solidly blank block, "mixed" when the block
// straddles an edge, and "off" when the point falls outside the canvas.
function classify(pixels, p, lon, lat) {
  const q = p([lon, lat]);
  const x = Math.round(q[0]);
  const y = Math.round(q[1]);
  let black = 0;
  let white = 0;
  let total = 0;
  for (const [dx, dy] of stencil) {
    const cx = x + dx;
    const cy = y + dy;
    if (cx < 0 || cx >= width || cy < 0 || cy >= height) return "off";
    const value = pixels[(cy * width + cx) * 4];
    ++total;
    if (value < 64) ++black;
    else if (value > 191) ++white;
  }
  return black === total ? "land" : white === total ? "water" : "mixed";
}

function fillOf(object, p) {
  const pixels = rasterize(object, p);
  return function(lon, lat) {
    return classify(pixels, p, lon, lat);
  };
}

// Every row is [longitude, latitude, expected]; the expected value must match
// both the painted region and the spherical membership.
function assertFilled(fill, table, message) {
  const failures = [];
  for (const [lon, lat, expected] of table) {
    const painted = fill(lon, lat);
    if (painted !== expected) {
      failures.push(`${lon},${lat}: painted ${painted}, expected ${expected}`);
    }
  }
  assert.deepStrictEqual(failures, [], message);
}

function assertSpherical(object, table) {
  const failures = [];
  for (const [lon, lat, expected] of table) {
    const inside = geoContains(object, [lon, lat]) ? "land" : "water";
    if (inside !== expected) {
      failures.push(`${lon},${lat}: geoContains ${inside}, expected ${expected}`);
    }
  }
  assert.deepStrictEqual(failures, [], "the probe table disagrees with geoContains");
}

function polygon(...rings) {
  return {type: "Polygon", coordinates: rings};
}

// Move every longitude by delta, wrapping back into [-180, 180]. Shifting a
// closed polygon by 180° relocates its cut from one side of the map to the
// other without changing the spherical shape, so its filled area on the
// projected plane must not change.
function shiftLongitudes(object, delta) {
  const wrap = lon => (lon + delta + 540) % 360 - 180;
  const ring = coordinates => coordinates.map(([lon, lat]) => [wrap(lon), lat]);
  return {
    type: object.type,
    coordinates: object.type === "Polygon"
        ? object.coordinates.map(ring)
        : object.coordinates.map(polygon => polygon.map(ring))
  };
}

function relativeDifference(a, b) {
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
}

let landPromise;

function loadLand() {
  return landPromise || (landPromise = readFile(
    "./node_modules/world-atlas/world/50m.json", "utf8"
  ).then(JSON.parse).then(world => feature(world, world.objects.land)));
}

// A band that straddles the date line: it covers every longitude between
// −170° and +170° the short way around, so its filled region is two shore
// strips, one at each edge of the canvas, with the rest of the map empty.
const band = polygon(
  [[170, -10], [170, 10], [-170, 10], [-170, -10], [170, -10]]
);

// The same band moved 180° away from the cut, for comparison.
const localBand = polygon(
  [[-10, -10], [-10, 10], [10, 10], [10, -10], [-10, -10]]
);

// A band with a hole (a lake) that also straddles the date line.
const lake = polygon(
  [[170, -10], [170, 10], [-170, 10], [-170, -10], [170, -10]],
  [[175, -4], [-175, -4], [-175, 4], [175, 4], [175, -4]]
);

// Land that enters and leaves the seam four times: at each edge the filled
// column alternates land/water down the map, and the two edges agree.
const comb = polygon(
  [[175, -30], [175, 30], [-175, 30], [-175, 20], [175, 20], [175, 10],
   [-175, 10], [-175, 0], [175, 0], [175, -10], [-175, -10], [-175, -20],
   [175, -20], [175, -30]]
);

// A C-shaped bay whose mouth spans the seam: the water reaches both edges.
const bay = polygon(
  [[160, -20], [160, 20], [-170, 20], [-170, 10], [175, 10], [175, -10],
   [-170, -10], [-170, -20], [160, -20]]
);

// Asymmetric across the seam: a block of land straddles the date line with a
// notch cut into the eastern shore. At most latitudes the same spot on both
// shores is land, but at the equator the eastern shore is land while the
// matching point on the western shore is water; the cut must reproduce that
// asymmetry instead of reflecting one shore onto the other.
const notch = polygon(
  [[170, -20], [170, 20], [-170, 15], [-170, 10], [178, 10], [178, -10],
   [-170, -15], [170, -20]]
);

// Polar caps centred on the date line: the seam runs straight through the pole
// where the antimeridian cut degenerates into a single point.
const northCap = geoCircle().center([180, 90]).radius(20)();
const southCap = geoCircle().center([180, -90]).radius(30)();
const hemisphere = geoCircle().center([180, 0]).radius(60)();
const island = geoCircle().center([180, 0]).radius(10)();

// A polygon that stays clear of the seams and of the date line: the canvas
// must not wrap it, otherwise the comparison below is meaningless.
const control = polygon(
  [[-6, -6], [-6, 6], [6, 6], [6, -6], [-6, -6]]
);

it("a polygon crossing the date line is filled at both edges", () => {
  const p = projection();
  const fill = fillOf(band, p);
  const table = [
    // Both shores are land …
    [178, 0, "land"], [-178, 0, "land"],
    [175, 5, "land"], [-175, 5, "land"],
    [172, -8, "land"], [-172, -8, "land"],
    // … the rest of the map is water …
    [0, 0, "water"], [150, 0, "water"], [-150, 0, "water"],
    [160, 0, "water"], [-160, 0, "water"],
    // … and the band’s far sides are water again.
    [178, 14, "water"], [-178, 14, "water"]
  ];
  assertSpherical(band, table);
  assertFilled(fill, table, "both shores of the cut band must be filled");
});

it("the filled band spans both edges and its area matches the unshifted copy", () => {
  const p = projection();
  const path = geoPath().projection(p);
  const seamBounds = path.bounds(band);
  const localBounds = path.bounds(localBand);

  // The part that crosses the cut reaches from the left margin to the right.
  assert(Math.abs(seamBounds[0][0] - margin) < 1e-6);
  assert(Math.abs(seamBounds[1][0] - (width - margin)) < 1e-6);

  // The unshifted copy is a narrow strip with the same vertical extent.
  assert(localBounds[1][0] - localBounds[0][0] < 60);
  assert(Math.abs(seamBounds[0][1] - localBounds[0][1]) < 1e-6);
  assert(Math.abs(seamBounds[1][1] - localBounds[1][1]) < 1e-6);

  // Cutting and rejoining must not change the painted area.
  assert(relativeDifference(path.area(band), path.area(localBand)) < 1e-9);
});

it("a lake enclosed by a polygon crossing the date line is a hole on both shores", () => {
  const p = projection();
  const fill = fillOf(lake, p);
  const table = [
    // Land around the lake on both sides …
    [178, 8, "land"], [-178, 8, "land"],
    [178, -8, "land"], [-178, -8, "land"],
    [172, 0, "land"], [-172, 0, "land"],
    // … water inside the lake on both sides …
    [178, 0, "water"], [-178, 0, "water"],
    // … and water far away from the band.
    [0, 0, "water"], [168, 0, "water"], [-168, 0, "water"]
  ];
  assertSpherical(lake, table);
  assertFilled(fill, table, "the enclosed lake must be cut out of both shores");
});

it("the lake removes the same painted area as its unshifted copy", () => {
  const p = projection();
  const path = geoPath().projection(p);
  const shifted = shiftLongitudes(lake, 180);
  // Cutting the hole at the seam resamples its clipped edge at a different
  // spacing, so the two areas agree only to within a fraction of a percent.
  assert(relativeDifference(path.area(lake), path.area(shifted)) < 1e-2);
  // The lake is 10° wide and 8° tall, so it must take something out of the band.
  assert(path.area(lake) < path.area(band));
  assert(path.area(band) - path.area(lake) > 0.1 * path.area(band));
});

it("land that re-enters the seam four times keeps its alternation on both shores", () => {
  const p = projection();
  const fill = fillOf(comb, p);
  const table = [
    [178, 25, "land"], [-178, 25, "land"],
    [178, 15, "water"], [-178, 15, "water"],
    [178, 5, "land"], [-178, 5, "land"],
    [178, -5, "water"], [-178, -5, "water"],
    [178, -15, "land"], [-178, -15, "land"],
    [178, -25, "water"], [-178, -25, "water"],
    // The middle of the map stays water: the comb only touches the edges.
    [0, 25, "water"], [0, 0, "water"],
    [160, 0, "water"], [-160, 0, "water"]
  ];
  assertSpherical(comb, table);
  assertFilled(fill, table, "each land tongue must be rejoined on its own shore");
});

it("the comb alternates identically when the cut moves to another meridian", () => {
  for (const rotate of rotations) {
    const p = projection(rotate);
    const fill = fillOf(comb, p);
    const table = [
      [178, 25, "land"], [-178, 25, "land"],
      [178, 15, "water"], [-178, 15, "water"],
      [178, 5, "land"], [-178, 5, "land"],
      [178, -5, "water"], [-178, -5, "water"],
      [178, -15, "land"], [-178, -15, "land"],
      [178, -25, "water"], [-178, -25, "water"]
    ];
    assertFilled(fill, table, `cut rotated by ${rotate}`);
  }
});

it("a bay whose mouth spans the seam is water on both shores", () => {
  const p = projection();
  const fill = fillOf(bay, p);
  const table = [
    [178, 15, "land"], [-178, 15, "land"],
    [178, 0, "water"], [-178, 0, "water"],
    [178, -15, "land"], [-178, -15, "land"],
    [165, 0, "land"], [-165, 0, "water"],
    [0, 0, "water"], [150, 0, "water"], [-150, 0, "water"]
  ];
  assertSpherical(bay, table);
  assertFilled(fill, table, "the bay mouth must stay open across the seam");
});

it("land on each side of the seam rejoins the outline it belongs to", () => {
  const p = projection();
  const fill = fillOf(notch, p);
  const table = [
    // The two shores differ at the equator: the eastern shore is land and
    // the matching western shore is water.
    [176, 0, "land"], [-176, 0, "water"],
    [176, 4, "land"], [-176, 4, "water"],
    [176, -4, "land"], [-176, -4, "water"],
    // Away from the notch both shores are land.
    [176, 14, "land"], [-176, 14, "land"],
    [176, -14, "land"], [-176, -14, "land"],
    // The interior of the map is untouched by the seam.
    [0, 0, "water"], [150, 0, "water"], [-150, 0, "water"]
  ];
  assertSpherical(notch, table);
  assertFilled(fill, table, "each shore must take the side of the outline it belongs to");
});

it("a cap centred on the date line is filled around the pole on both shores", () => {
  const north = fillOf(northCap, projection());
  const northTable = [
    [0, 88, "land"], [178, 85, "land"], [-178, 85, "land"],
    [178, 74, "land"], [-178, 74, "land"], [0, 74, "land"],
    [178, 68, "water"], [-178, 68, "water"], [0, 68, "water"],
    [0, -89, "water"], [179, 0, "water"], [-179, 0, "water"]
  ];
  assertSpherical(northCap, northTable);
  assertFilled(north, northTable, "the north polar cap must close through both edges");

  const south = fillOf(southCap, projection());
  const southTable = [
    [0, -88, "land"], [178, -85, "land"], [-178, -85, "land"],
    [178, -64, "land"], [-178, -64, "land"], [0, -64, "land"],
    [178, -58, "water"], [-178, -58, "water"], [0, -58, "water"],
    [0, 89, "water"], [179, 0, "water"], [-179, 0, "water"]
  ];
  assertSpherical(southCap, southTable);
  assertFilled(south, southTable, "the south polar cap must close through both edges");
});

it("polar caps keep their painted area when the cut crosses them elsewhere", () => {
  const p = projection();
  const path = geoPath().projection(p);
  for (const cap of [northCap, southCap, hemisphere, island]) {
    assert(relativeDifference(path.area(cap), path.area(shiftLongitudes(cap, 180))) < 1e-6);
  }
});

it("a hemisphere spanning the seam is land on both shores and water at its rim", () => {
  const p = projection();
  const fill = fillOf(hemisphere, p);
  const table = [
    [178, 0, "land"], [-178, 0, "land"],
    [150, 0, "land"], [-150, 0, "land"],
    [130, 0, "land"], [-130, 0, "land"],
    [110, 0, "water"], [-110, 0, "water"],
    [60, 0, "water"], [-60, 0, "water"],
    [0, 0, "water"], [0, 89, "water"]
  ];
  assertSpherical(hemisphere, table);
  assertFilled(fill, table, "the hemisphere must be continuous across the seam");
});

it("a small island centred on the seam is one landmass split between the edges", () => {
  const p = projection();
  const fill = fillOf(island, p);
  const table = [
    [178, 0, "land"], [-178, 0, "land"],
    [177, 0, "land"], [-177, 0, "land"],
    [174, 0, "land"], [-174, 0, "land"],
    [178, 8, "land"], [-178, -8, "land"],
    [168, 0, "water"], [-168, 0, "water"],
    [178, 12, "water"], [-178, -12, "water"],
    [0, 0, "water"]
  ];
  assertSpherical(island, table);
  assertFilled(fill, table, "the island must be painted on both sides of the cut");
});

it("the canvas does not wrap a polygon that avoids the date line", () => {
  const p = projection();
  const fill = fillOf(control, p);
  const table = [
    [0, 0, "land"],
    [178, 0, "water"], [-178, 0, "water"],
    [0, 20, "water"]
  ];
  assertFilled(fill, table, "the control polygon must not appear at the edges");
  const bounds = geoPath().projection(p).bounds(control);
  assert(bounds[1][0] - bounds[0][0] < 60);
  assert(bounds[0][0] > width / 2 - 60);
});

it("the world’s land is filled where it lies, including at the poles", async () => {
  const land = await loadLand();
  const fill = fillOf(land, projection());
  const table = [
    // Continents.
    [-72, -50, "land"], [-42, -14, "land"], [-68, 2, "land"], [32, 16, "land"],
    [82, 26, "land"], [54, 34, "land"], [-2, 42, "land"], [108, 48, "land"],
    [-38, 78, "land"], [-56, 80, "land"], [-30, 80, "land"], [-64, 78, "land"],
    // Oceans in the middle of the map.
    [-118, -54, "water"], [-50, -46, "water"], [2, -38, "water"], [-96, -28, "water"],
    [8, -18, "water"], [-48, 8, "water"], [-18, 24, "water"], [38, 70, "water"],
    [28, 84, "water"], [102, 86, "water"],
    // The Arctic Ocean is water above the north pole …
    [0, 86, "water"], [0, 89, "water"], [179, 85, "water"], [-179, 85, "water"],
    // … and Antarctica is land around the south pole, on both shores.
    [0, -85, "land"], [0, -88, "land"], [90, -88, "land"], [-90, -88, "land"],
    [-178, -88, "land"], [168, -88, "land"], [158, -86, "land"], [-174, -86, "land"],
    // The Bering Strait: land reaches the seam on both sides at high latitudes.
    [-156, 60, "land"], [-156, 62, "land"], [-156, 70, "land"],
    [168, 62, "land"], [166, 66, "land"],
    // Open Pacific water lies against the edges at most latitudes.
    [-178, 60, "water"], [-178, 78, "water"], [170, 80, "water"],
    [-178, -82, "water"], [170, -82, "water"], [-178, -76, "water"], [174, 16, "water"]
  ];
  assertSpherical(land, table);
  assertFilled(fill, table, "the world map must agree with the spherically contained land");
});

it("the world’s filled region is unchanged when the cut moves to another meridian", async () => {
  const land = await loadLand();
  const base = fillOf(land, projection());
  for (const rotate of rotations) {
    const fill = fillOf(land, projection(rotate));
    const differences = [];
    for (let lat = -80; lat <= 80; lat += 4) {
      for (let lon = -176; lon <= 176; lon += 4) {
        const before = base(lon, lat);
        const after = fill(lon, lat);
        // Ignore anything within a pixel-block of an edge.
        if (before === "mixed" || after === "mixed" || before === "off" || after === "off") continue;
        if (before !== after) differences.push([lon, lat, before, after]);
      }
    }
    assert.deepStrictEqual(differences, [], `cut rotated by ${rotate}`);
  }
});

it("the world raster matches its spherical membership away from the edges", async () => {
  const land = await loadLand();
  const fill = fillOf(land, projection());
  const failures = [];
  for (let lat = -84; lat <= 84; lat += 8) {
    for (let lon = -176; lon <= 176; lon += 8) {
      const painted = fill(lon, lat);
      if (painted === "mixed" || painted === "off") continue;
      const inside = geoContains(land, [lon, lat]) ? "land" : "water";
      if (painted !== inside) failures.push([lon, lat, painted, inside]);
    }
  }
  assert.deepStrictEqual(failures, [], "painted land must equal spherically contained land");
});
