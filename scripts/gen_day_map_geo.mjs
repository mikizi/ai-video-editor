// Map geometry for the day-map motion template: Małopolska / Tatra region, projected for a 1920x1080 frame
// with the area of interest right of centre (text sits on the left). Prints JSON incl. the projection parameters.
import { createRequire } from "module";
const require = createRequire(process.cwd() + "/remotion-composer/");
const { geoMercator, geoPath } = require("d3-geo");
const topo = require("topojson-client");
const fs = require("fs");
const world = JSON.parse(fs.readFileSync(process.cwd() + "/remotion-composer/node_modules/world-atlas/countries-50m.json", "utf8"));
const W = 1920, H = 1080;
const CENTER = [20.1, 49.65], SCALE = 30770, TR = [1180, 560];
const proj = geoMercator().center(CENTER).scale(SCALE).translate(TR);
const path = geoPath(proj).digits(1);
const countries = topo.feature(world, world.objects.countries);
const NEAR = ["Poland", "Slovakia", "Czechia", "Ukraine", "Hungary", "Germany", "Austria", "Romania"];
const pick = (n) => countries.features.find((f) => f.properties.name === n);
console.log(JSON.stringify({
  land: path({ type: "FeatureCollection", features: countries.features.filter((f) => ["Slovakia", "Czechia", "Ukraine", "Hungary", "Germany", "Austria", "Romania"].includes(f.properties.name)) }),
  borders: path(topo.mesh(world, { type: "GeometryCollection", geometries: world.objects.countries.geometries.filter((g) => NEAR.includes(g.properties.name)) }, (a, b) => a !== b)),
  poland: path(pick("Poland")),
  proj: { lon0: CENTER[0], lat0: CENTER[1], k: SCALE, tx: TR[0], ty: TR[1] },
}));
