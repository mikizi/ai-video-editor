// Pre-computes the map geometry (SVG paths) for the route-map motion template from the local Natural Earth data
// (world-atlas + d3-geo + topojson-client in remotion-composer/node_modules). Prints JSON.
import { createRequire } from "module";
const require = createRequire(process.cwd() + "/remotion-composer/");
const { geoMercator, geoPath, geoDistance } = require("d3-geo");
const topo = require("topojson-client");
const fs = require("fs");
const world = JSON.parse(fs.readFileSync(process.cwd() + "/remotion-composer/node_modules/world-atlas/countries-50m.json", "utf8"));
const W = 1920, H = 1080;
const proj = geoMercator().center([27.4, 41.4]).scale(1500).translate([W / 2, H / 2]).clipExtent([[-40, -40], [W + 40, H + 40]]);
const path = geoPath(proj).digits(1);
const countries = topo.feature(world, world.objects.countries);
const pick = (n) => countries.features.find((f) => f.properties.name === n);
const TLV = [34.78, 32.01], KRK = [19.94, 50.07];
const pt = (c) => proj(c).map((v) => Math.round(v * 10) / 10);
const km = geoDistance(TLV, KRK) * 6371;
console.log(JSON.stringify({
  land: path(topo.merge(world, world.objects.countries.geometries)),
  borders: path(topo.mesh(world, world.objects.countries, (a, b) => a !== b)),
  israel: path(pick("Israel")), poland: path(pick("Poland")),
  tlv: pt(TLV), krk: pt(KRK), km: Math.round(km / 10) * 10,
}));
