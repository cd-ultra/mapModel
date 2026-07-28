# Geo Model Editor

Pick a building on a 3D globe, pull it out as an editable mesh, reshape it
(scale, rotate, slice), and drop it back onto the globe somewhere else —
correctly georeferenced.

Implements [the project plan](#implementation-status) as an npm-workspaces
monorepo.

```
┌──────────────────┐   extract    ┌───────────────────┐   place    ┌──────────────────┐
│  Globe: SOURCE   │ ───────────▶ │  Edit Workspace   │ ─────────▶ │  Globe: DEST     │
│  (CesiumJS)      │ footprint +  │  (Three.js/r3f)   │  edited    │  (CesiumJS)      │
│  pick a building │ height + tags│  scale/rotate/cut │  glTF      │  place at lon/lat│
└──────────────────┘              └───────────────────┘            └──────────────────┘
```

## Quick start

```bash
npm install
cp packages/web/.env.example packages/web/.env
# put a free Cesium ion token in packages/web/.env — https://ion.cesium.com/tokens
npm run dev
```

That runs the app with **no backend**: footprints come straight from the public
Overpass endpoint and nothing is persisted. Good enough to use the whole
extract → edit → place workflow.

To run the API too:

```bash
docker compose up -d                       # Postgres/PostGIS + MinIO (both optional)
cp packages/server/.env.example packages/server/.env
npm run migrate -w @gme/server             # only if DATABASE_URL is set
npm run dev:server                         # :8787
```

Then set `VITE_API_BASE_URL` in `packages/web/.env` so the client uses the
cached footprint proxy and gains a "Save to my library" button.

## Layout

| Package | What it is |
|---|---|
| `packages/shared` | Types plus the geodesy that both ends need: WGS84 ↔ ECEF ↔ local ENU, OSM height-tag parsing, Overpass query building and response parsing. |
| `packages/web` | React + Vite app: Cesium globe, Three.js/r3f edit workspace, CSG slicing, glTF export. |
| `packages/server` | Express API: cached Overpass proxy, PostGIS persistence, S3/local asset storage, pluggable auth. |

## How it works

### Extraction

Cesium OSM Buildings are procedurally extruded from OSM footprints, not
photogrammetry. So "extracting" a building means reading its OSM id off the
picked tile feature, fetching the footprint, and **regenerating** a clean solid —
rather than trying to carve geometry out of an opaque baked tile.

Reading that id is the part most likely to break: the property names on ion's
tileset vary by region and tileset generation. `src/osm/tileFeature.ts` tries
every spelling seen in the wild, reports which one matched, and on failure shows
the user the full property list instead of failing silently.

Footprints come from Overpass. The public endpoint is not built to back an
interactive app, so in production requests go through `/api/osm/footprint`,
which adds a 24h TTL cache and coalesces concurrent requests for the same
building into a single upstream call. The long-term fix is a self-hosted OSM
extract; `OverpassClient` is the seam for that.

### Coordinates

The extruded mesh is authored **X=east, Y=up, Z=south**, centred on the
footprint centroid with its base at `y=0`.

That is not arbitrary. Cesium loads glTF with `upAxis=Y`/`forwardAxis=X`, which
applies `Axis.Y_UP_TO_Z_UP` — mapping `(x, y, z) → (x, -z, y)`. Feed it
`(east, up, south)` and you get `(east, north, up)`: exactly the axes of
`Transforms.eastNorthUpToFixedFrame`. So placement is just the ENU frame times
the heading spin, with no corrective rotation anywhere.

`placement.test.ts` asserts that end-to-end against real Cesium, so a future
release changing those defaults fails a test rather than silently laying every
building on its side.

### Editing and undo

Scale and rotation are node transforms. Slicing is real CSG: the live clipping
plane is only a render-time preview, and committing subtracts a half-space brush
via `three-bvh-csg` to produce capped, exportable geometry.

Undo never inverts a boolean. The raw extrusion is immutable, an edit is a
transform plus an ordered list of cut planes (stored in the mesh's local space),
and undo replays that list from scratch. Cuts on a low-poly building are
milliseconds, and this is far more robust than trying to reverse CSG.

## Commands

```bash
npm test          # all workspaces
npm run typecheck
npm run build
npm run dev       # web only
npm run dev:server
```

## Implementation status

Phases 0–4 from the plan are complete and covered by tests. Phase 5 (persistence)
is complete on the server and wired into the client for save; Phase 6 hardening
is partial.

**Not done — and what it needs:**

- **Auth is a stub.** `src/auth/middleware.ts` defines the seam and defaults to
  rejecting every token; dropping in Auth.js or Clerk means replacing
  `verifyToken`. The server refuses to start with `AUTH_REQUIRED=false` under
  `NODE_ENV=production`, so this cannot be shipped open by accident. Until it is
  wired, "multi-user" means one shared anonymous user.
- **No integration test against a live PostGIS.** `PostgresRepository` is tested
  against a fake `Queryable` that checks SQL shape and row mapping. That catches
  column drift, not a schema mismatch.
- **Load/restore in the UI.** The API lists saved models; the client only writes.
- **Self-hosted OSM extract.** Still on the public Overpass endpoint.
- **Cesium ion quota monitoring.** The free tier has a monthly streaming quota
  that nothing currently watches.

## Licensing

Building data is © OpenStreetMap contributors, licensed
[ODbL](https://opendatacommons.org/licenses/odbl/). ODbL applies to the OSM
database and derived databases, not to this application's code, but it does
require attribution wherever the data is shown and share-alike on derived
databases. The attribution is rendered in the status bar and baked into exported
glTF assets, and Cesium's credit container is deliberately kept visible.
