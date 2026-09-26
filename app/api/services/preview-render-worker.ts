// Standalone child process that renders blueprint preview images with the
// node Canvas + PIXI stack. Runs out-of-process because pixi-shim installs
// DOM globals and decoded textures accumulate RSS — neither belongs in the
// API process. Textures are loaded per render (only the ids the blueprint
// references): preloading the full registered set costs ~400MB RSS, which
// OOM-killed the whole container on small prod instances. Spawned lazily by
// PreviewImageService and killed again after an idle period.
//
// IPC protocol (advanced serialization — the parent forks with
// serialization: 'advanced' so Buffers cross the channel natively, no base64).
// The master crosses as raw RGBA pixels: no PNG encode here, no PNG decode in
// the parent — sharp ingests the raw buffer directly.
//   parent -> worker: { type: 'render', requestId, mdb, size, blueprintId, itemCount }
//   worker -> parent: { type: 'ready' }
//                     { type: 'rendered', requestId, raw: Buffer, width, height, timings }
//                     { type: 'error', requestId, message }
//
// CLI: `node preview-render-worker.js --smoke` renders a built-in fixture and
// exits 0/1 — run inside the deploy image to validate native deps + assets.
import * as fs from 'fs';
import * as path from 'path';
import * as v8 from 'v8';

import {
  Blueprint as SharedBlueprint,
  ImageSource,
  BuildableElement,
  BuildMenuCategory,
  BuildMenuItem,
  BSpriteInfo,
  SpriteInfo,
  BSpriteModifier,
  SpriteModifier,
  BBuilding,
  OniItem,
  MdbBlueprint,
  Vector2,
  CameraService,
  ConnectionHelper,
  Overlay,
  Display,
  TerrainFeature,
  BTerrainFeature,
  MARKER_URLS,
  MarkerName,
  NOTE_ICON_TILE_FRACTION,
  noteBadgeColor,
  noteMarkerSprite,
  drawTerrainFeature,
  terrainIconUrl,
} from '../../../lib';
import { PixiNodeUtil } from '../pixi-node-util';
import { startMemoryHeartbeat } from './memory-heartbeat';
import { resolveMaxRssMb } from './render-memory';

const REPO_ROOT = path.resolve(__dirname, '../../..');

// The renderer resolves the relative asset urls the shared lib registers
// ('assets/ui_image/…', 'assets/images/…', 'assets/connection_sprites/…').
// Only the frontend asset root carries the complete set (the backend
// `assets/` root lacks `images/`): in the production container that is the
// built frontend at app/public, in a dev checkout it is frontend/src.
function resolveAssetBaseDir(): string {
  const candidates = [path.join(REPO_ROOT, 'app/public'), path.join(REPO_ROOT, 'frontend/src')];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'assets/images'))) return candidate;
  }
  throw new Error(
    'preview-render-worker: no asset root with assets/images found (looked in app/public, frontend/src)'
  );
}

function initSharedLib() {
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'assets/database/database-2024.json'), 'utf8');
  const json = JSON.parse(raw);

  ImageSource.init();
  BuildableElement.init();
  BuildableElement.load(json.elements as BuildableElement[]);
  BuildMenuCategory.init();
  BuildMenuCategory.load(json.buildMenuCategories as BuildMenuCategory[]);
  BuildMenuItem.init();
  BuildMenuItem.load(json.buildMenuItems as BuildMenuItem[]);
  SpriteInfo.init();
  SpriteInfo.load(json.uiSprites as BSpriteInfo[]);
  SpriteModifier.init();
  SpriteModifier.load(json.spriteModifiers as BSpriteModifier[]);
  OniItem.init();
  OniItem.load(json.buildings as BBuilding[]);
  TerrainFeature.init();
  TerrainFeature.load(json.terrainFeatures as BTerrainFeature[]);
}

function rssMb(): number {
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

function logRss(label: string) {
  console.log(`preview-render-worker: ${label} rss=${rssMb()}MB`);
}

const MB = 1024 * 1024;

/**
 * One memory reading, split by where the bytes live. RSS alone cannot
 * attribute a render's cost; heapUsed vs external can — the JS object graph
 * and the decoded canvas bitmaps scale with different things.
 */
function memSample(): MemSample {
  const m = process.memoryUsage();
  return {
    rss: Math.round(m.rss / MB),
    heap: Math.round(v8.getHeapStatistics().used_heap_size / MB),
    external: Math.round(m.external / MB),
    arrayBuffers: Math.round(m.arrayBuffers / MB),
  };
}

/**
 * Bytes currently held by decoded textures, counted from the textures
 * themselves rather than inferred from RSS.
 *
 * RSS cannot answer this. Every decode goes through libpng at native size
 * even when only a downscaled copy is retained, and a native allocator does
 * not return freed blocks to the OS — so peak RSS records the transient
 * full-size decodes whether or not anything keeps them. This counts what the
 * worker is actually still holding.
 */
function residentTextureMb(pixi: PixiNodeUtil): number {
  let bytes = 0;
  for (const key of ImageSource.keys) {
    if (!ImageSource.isTextureLoaded(key)) continue;
    const baseTexture = ImageSource.getBaseTexture(key, pixi);
    if (baseTexture?.width && baseTexture?.height)
      bytes += baseTexture.width * baseTexture.height * 4;
  }
  return Math.round(bytes / MB);
}

// Diagnostic only, off unless PREVIEW_WORKER_HEAP_SNAPSHOT_DIR is set: a
// snapshot is hundreds of MB and stops the world to write. Set it to attribute
// a render's heap to constructors (which is the scene graph, which is the
// imported blueprint, which is textures); leave it unset everywhere else.
const HEAP_SNAPSHOT_DIR = process.env.PREVIEW_WORKER_HEAP_SNAPSHOT_DIR;

async function writeHeapSnapshot(phase: string, label: string): Promise<void> {
  if (!HEAP_SNAPSHOT_DIR) return;
  try {
    await fs.promises.mkdir(HEAP_SNAPSHOT_DIR, { recursive: true });
    const safeLabel = label.replace(/[^\w.-]+/g, '_').slice(0, 80);
    const file = path.join(HEAP_SNAPSHOT_DIR, `${safeLabel}-${phase}.heapsnapshot`);
    // Synchronous and blocking by design: the point is to capture the heap at
    // this exact phase boundary, not whatever it drifts to afterwards.
    v8.writeHeapSnapshot(file);
    console.log(`preview-render-worker: wrote heap snapshot ${file} (heap ${memSample().heap}MB)`);
  } catch (e) {
    console.warn(`preview-render-worker: heap snapshot at ${phase} failed:`, e);
  }
}

// Every image id a render of this blueprint can request. Static walk of the
// texture consumers (DrawPart.prepareSprite, SpriteInfo.getTexture,
// drawPixiUtility) so only these files are decoded — preloading the full
// registered set costs ~400MB RSS and OOM-kills small prod instances.
interface CollectedImages {
  /** Every image id this render can request. */
  ids: Set<string>;
  /**
   * For flat icons only: the largest footprint, in cells, that any item draws
   * this icon into. Multiplied by the render's cell pitch it gives the only
   * resolution the icon can actually show, which is what caps the decode.
   *
   * Atlas images are deliberately absent. Their sprites are addressed by pixel
   * rectangles (SpriteInfo.uvMin/uvSize) that scaling would silently
   * invalidate, so they are always decoded at native size.
   */
  flatIconCells: Map<string, number>;
}

function collectImageIds(blueprint: SharedBlueprint): CollectedImages {
  const ids = new Set<string>();
  const flatIconCells = new Map<string, number>();
  for (const item of blueprint.blueprintItems) {
    const cells = Math.max(item.oniItem.size?.x ?? 1, item.oniItem.size?.y ?? 1, 1);
    for (const part of item.drawParts) {
      if (part.flatIconId) {
        ids.add(part.flatIconId);
        flatIconCells.set(part.flatIconId, Math.max(flatIconCells.get(part.flatIconId) ?? 0, cells));
      } else if (part.spriteModifier) {
        const spriteInfo = SpriteInfo.getSpriteInfo(part.spriteModifier.spriteInfoName);
        if (spriteInfo?.imageId) ids.add(spriteInfo.imageId);
      }
    }
    for (const connection of item.oniItem.utilityConnections ?? []) {
      const connectionSprite = ConnectionHelper.getConnectionSprite(connection);
      const spriteInfo =
        connectionSprite && SpriteInfo.getSpriteInfo(connectionSprite.spriteInfoId);
      if (spriteInfo?.imageId) ids.add(spriteInfo.imageId);
    }
  }
  return { ids, flatIconCells };
}

// Decode the given textures if they are not already resident. Missing or
// unregistered files get a 1x1 transparent placeholder instead of failing the
// whole render: node PIXI cannot load textures lazily (sync getBaseTexture),
// and a handful of legacy ui sprites may be absent without affecting
// blueprint rendering. Returns the number of placeholders used.
// Items drawn per rasterize batch. 0 renders the whole blueprint in one pass,
// which is what this did before batching existed.
const RASTER_CHUNK_SIZE = Number(process.env.PREVIEW_RASTER_CHUNK ?? 250);

// Off with PREVIEW_ICON_DOWNSCALE=0, which restores native-resolution decodes.
const ICON_DOWNSCALE = process.env.PREVIEW_ICON_DOWNSCALE !== '0';
// Cells are drawn at `tileSize` px, so an icon's useful resolution is its
// footprint times that. The margin covers the art that legitimately overhangs
// its footprint (uiImageRect placement, connection-sprite caps) and leaves a
// little headroom so the cap never becomes the visible limit on quality.
const ICON_SUPERSAMPLE = Number(process.env.PREVIEW_ICON_SUPERSAMPLE ?? 4) || 4;
// Below this the cap costs a rescale to save nothing worth having.
const MIN_ICON_CAP_PX = 32;

/**
 * The resolution each flat icon is currently resident at, so a later render
 * needing more detail than an earlier one settled for re-decodes instead of
 * drawing a blurred cache hit. An icon decoded at its native size records
 * Infinity — there is no more detail to fetch, and without that distinction a
 * small icon would re-decode on every render that asked for more than it has.
 */
const decodedIconCap = new Map<string, number>();

// Decode the given textures if they are not already resident. Missing or
// unregistered files get a 1x1 transparent placeholder instead of failing the
// whole render: node PIXI cannot load textures lazily (sync getBaseTexture),
// and a handful of legacy ui sprites may be absent without affecting
// blueprint rendering. Returns the number of placeholders used.
async function ensureTextures(
  pixi: PixiNodeUtil,
  baseDir: string,
  collected: CollectedImages,
  tileSizePx: number
): Promise<number> {
  let missing = 0;
  for (const key of collected.ids) {
    const cells = ICON_DOWNSCALE ? collected.flatIconCells.get(key) : undefined;
    // Atlas images (absent from flatIconCells) keep an uncapped decode.
    const cap =
      cells == null
        ? Infinity
        : Math.max(MIN_ICON_CAP_PX, Math.ceil(cells * tileSizePx * ICON_SUPERSAMPLE));
    if (ImageSource.isTextureLoaded(key)) {
      // Resident and at least as detailed as this render needs.
      if ((decodedIconCap.get(key) ?? Infinity) >= cap) continue;
    }
    try {
      const imageUrl = ImageSource.getUrl(key)!;
      const { baseTexture, nativeMaxDim } = await pixi.decodeToBaseTexture(
        path.join(baseDir, imageUrl),
        Number.isFinite(cap) ? cap : undefined
      );
      ImageSource.setBaseTexture(key, baseTexture);
      decodedIconCap.set(key, nativeMaxDim <= cap ? Infinity : cap);
    } catch {
      missing++;
      ImageSource.setBaseTexture(key, pixi.getNewBaseRenderTexture({ width: 1, height: 1 }));
      decodedIconCap.set(key, Infinity);
    }
  }
  if (missing > 0)
    console.warn(`preview-render-worker: ${missing} textures missing, using placeholders`);
  return missing;
}

// Marker textures for world notes, decoded on first use and kept for the life
// of the worker. Unlike building art these are a fixed set of 17 small icons
// that most blueprints draw from, so they are not worth re-resolving per
// render — and they are not ImageSource-registered ids, so ensureTextures
// cannot carry them.
const markerTextures = new Map<MarkerName, any>();

async function getMarkerTexture(
  pixi: PixiNodeUtil,
  baseDir: string,
  marker: MarkerName
): Promise<any> {
  let texture = markerTextures.get(marker);
  if (texture === undefined) {
    let baseTexture;
    try {
      baseTexture = await pixi.getImageFromCanvas(path.join(baseDir, MARKER_URLS[marker]));
    } catch {
      console.warn(`preview-render-worker: note marker ${marker} missing, using placeholder`);
      baseTexture = pixi.getNewBaseRenderTexture({ width: 1, height: 1 });
    }
    // A whole-image Texture, not the BaseTexture: PIXI.Sprite.from cannot
    // auto-detect a BaseTexture as a source and throws on it.
    texture = pixi.getNewTextureWhole(baseTexture);
    markerTextures.set(marker, texture);
  }
  return texture;
}

// Terrain icon textures, decoded on first use and kept for the life of the
// worker — one flat icon per feature prefab. Like markerTextures, these are
// not ImageSource-registered ids, so ensureTextures cannot carry them.
const terrainTextures = new Map<string, any>();

async function getTerrainTexture(pixi: PixiNodeUtil, baseDir: string, url: string): Promise<any> {
  let texture = terrainTextures.get(url);
  if (texture === undefined) {
    let baseTexture;
    try {
      baseTexture = await pixi.getImageFromCanvas(path.join(baseDir, url));
    } catch {
      console.warn(`preview-render-worker: terrain icon ${url} missing, using placeholder`);
      baseTexture = pixi.getNewBaseRenderTexture({ width: 1, height: 1 });
    }
    // A whole-image Texture, not the BaseTexture — see getMarkerTexture.
    texture = pixi.getNewTextureWhole(baseTexture);
    terrainTextures.set(url, texture);
  }
  return texture;
}

// Terrain annotations (geysers, vents, volcanoes): the same footprint outline
// and icon placement the editor overlay and the client-side export/thumbnail
// snapshots draw (lib/src/drawing/terrain-markers.ts), with no selection
// state — a one-shot render never has a selection. Drawn above buildings and
// below world-note pins, so a note is never hidden behind a geyser's art.
async function drawTerrainFeatures(
  pixi: PixiNodeUtil,
  baseDir: string,
  blueprint: SharedBlueprint,
  camera: CameraService
): Promise<void> {
  if (blueprint.terrainFeatures.length === 0) return;

  const container = pixi.getNewContainer();
  // Above blueprintItems (which top out at ZIndex.BuildingUse) but below the
  // world-note pins container's 1e6.
  container.zIndex = 5e5;
  camera.container.addChild(container);

  const graphics = pixi.getNewGraphics();
  container.addChild(graphics);

  const zoom = camera.currentZoom;
  const offset = camera.cameraOffset;

  for (const feature of blueprint.terrainFeatures) {
    const known = TerrainFeature.getFeature(feature.id);
    const width = known != null ? known.width : 1;
    const height = known != null ? known.height : 1;

    // Cell coords are bottom-left anchored and y-up; screen is y-down, so the
    // top edge of the footprint is the anchor plus its height.
    const left = (feature.x + offset.x) * zoom;
    const top = (offset.y - feature.y - height + 1) * zoom;

    const sprite = pixi.getSpriteFrom(
      await getTerrainTexture(pixi, baseDir, terrainIconUrl(feature))
    );
    container.addChild(sprite);
    drawTerrainFeature(
      graphics,
      sprite,
      left,
      top,
      width * zoom,
      height * zoom,
      zoom,
      known?.uiImageRect
    );
  }
}

// World-note pins, drawn on top of the buildings — the same markers the editor
// canvas and the client-side export snapshots draw, so a blueprint's card
// shows the annotations its author placed. Sizing and colour come from the
// shared note-marker rules; the selection ring and sprite pooling the editor
// overlay does are per-frame concerns a one-shot render has no use for.
async function drawWorldNotes(
  pixi: PixiNodeUtil,
  baseDir: string,
  blueprint: SharedBlueprint,
  camera: CameraService
): Promise<void> {
  if (blueprint.worldNotes.length === 0) return;

  const container = pixi.getNewContainer();
  // Above every building: blueprint items top out at ZIndex.BuildingUse.
  container.zIndex = 1e6;
  camera.container.addChild(container);

  const zoom = camera.currentZoom;
  const offset = camera.cameraOffset;
  const size = NOTE_ICON_TILE_FRACTION * zoom;
  const resolve = (tag: number) => BuildableElement.getElementByTag(tag);

  for (const note of blueprint.worldNotes) {
    const marker = noteMarkerSprite(note, resolve);
    const badge = noteBadgeColor(note, resolve);
    const sprite = pixi.getSpriteFrom(await getMarkerTexture(pixi, baseDir, marker));
    sprite.anchor.set(0.5, 0.5);
    sprite.tint = badge.color;
    sprite.alpha = badge.alpha;
    sprite.width = size;
    sprite.height = size;
    // Cell centre, matching BlueprintItem.drawPixi's +0.5 convention.
    sprite.x = (note.x + offset.x + 0.5) * zoom;
    sprite.y = (offset.y - note.y + 0.5) * zoom;
    container.addChild(sprite);
  }
}

interface RenderTimings {
  importMs: number;
  texturesMs: number;
  rasterizeMs: number;
  extractMs: number;
  /**
   * Highest RSS seen across the render's phase boundaries. Sampled there
   * rather than on a timer because the rasterize loop is synchronous — a
   * timer never gets a turn, so it would report the idle figure and call it
   * a peak.
   */
  peakRssMb: number;
  /**
   * Memory at each phase boundary, split by where it actually lives.
   *
   * RSS is what the container kills on, but it folds the V8 heap, native
   * allocations and allocator slack into one number, so it cannot say what
   * got big. The ladder that set PREVIEW_MAX_RENDER_ITEMS was RSS-only, so
   * the per-item cost it implies is an upper bound on nothing in particular.
   * Splitting rss / heapUsed / external per phase is what distinguishes the
   * JS-side scene graph (heapUsed, scales with item count) from decoded
   * canvas bitmaps (external, scales with distinct prefabs) — two different
   * problems with two different fixes.
   */
  mem: MemPhases;
  /** Decoded-texture bytes the worker still holds after this render. */
  residentTextureMb: number;
}

/** One memory reading, in MB. */
interface MemSample {
  rss: number;
  /** Live V8 heap: the JS object graph (BlueprintItems, PIXI display objects). */
  heap: number;
  /** Native memory V8 knows about — decoded canvas bitmaps land here. */
  external: number;
  arrayBuffers: number;
}

/** Memory at each render phase boundary. */
interface MemPhases {
  /** Entering the render: resident textures + shared lib, nothing per-render. */
  start: MemSample;
  /** After importFromMdb: adds the BlueprintItem/DrawPart graph. */
  afterImport: MemSample;
  /** After ensureTextures: adds this blueprint's decoded textures. */
  afterTextures: MemSample;
  /** After drawPixi over every item: adds the PIXI scene graph. */
  afterRasterize: MemSample;
  /** After extract: adds the RGBA master. */
  afterExtract: MemSample;
  /** After destroy(): what the render failed to hand back. */
  afterRelease: MemSample;
}

// Pixel geometry of the render: the size of one cell, and where cell (0,0)'s
// corner lands. Lets a consumer (the preview variant deriver) draw a grid at
// the blueprint's real pitch instead of a decorative fixed-size one.
export interface PreviewFraming {
  tileSize: number;
  offsetPx: { x: number; y: number };
}

interface MasterPixels {
  /** Non-premultiplied RGBA, size*size*4 bytes — sharp raw input format. */
  raw: Buffer;
  width: number;
  height: number;
  framing: PreviewFraming;
  timings: RenderTimings;
}

// Deterministic fit-to-content framing — same camera rules as the historic
// thumbnail path (~1.5 tiles padding, content centered on a square canvas)
// but without the integer zoom flooring so framing is resolution-independent.
async function renderMaster(
  pixi: PixiNodeUtil,
  assetBaseDir: string,
  mdb: MdbBlueprint,
  size: number,
  // Names the heap snapshots this render writes, when they are enabled at all.
  label = 'render'
): Promise<MasterPixels> {
  const start = memSample();
  let peakRssMb = start.rss;
  const sampleRss = () => {
    peakRssMb = Math.max(peakRssMb, rssMb());
  };
  // Phase-boundary readings. Every entry is overwritten below; seeded from
  // `start` so a render that throws mid-phase still yields a well-formed
  // object rather than zeroes that read as real measurements.
  const mem: MemPhases = {
    start,
    afterImport: start,
    afterTextures: start,
    afterRasterize: start,
    afterExtract: start,
    afterRelease: start,
  };

  const importStart = Date.now();
  const blueprint = new SharedBlueprint();
  blueprint.importFromMdb(mdb);
  if (blueprint.blueprintItems.length === 0) throw new Error('empty blueprint');

  // Framing is resolved before the textures are decoded, not after: the cell
  // pitch is what says how much resolution an icon can possibly show, and an
  // icon decoded before that is known can only be decoded at native size.
  const [topLeft, bottomRight] = blueprint.getBoundingBox();
  const totalTileSize = new Vector2(bottomRight.x - topLeft.x + 3, bottomRight.y - topLeft.y + 3);
  const maxTotalSize = Math.max(totalTileSize.x, totalTileSize.y);
  const tileSize = size / maxTotalSize;

  const texturesStart = Date.now();
  sampleRss();
  mem.afterImport = memSample();
  await ensureTextures(pixi, assetBaseDir, collectImageIds(blueprint), tileSize);

  const rasterizeStart = Date.now();
  sampleRss();
  mem.afterTextures = memSample();
  const residentTextures = residentTextureMb(pixi);
  // Baseline snapshot: everything the render needs *before* a single PIXI
  // display object exists. Differencing it against the rasterize snapshot is
  // what attributes the scene graph, rather than inferring it from RSS.
  await writeHeapSnapshot('textures', label);
  const cameraOffset = new Vector2(-topLeft.x + 1, bottomRight.y + 1);
  if (totalTileSize.x > totalTileSize.y)
    cameraOffset.y += totalTileSize.x / 2 - totalTileSize.y / 2;
  if (totalTileSize.y > totalTileSize.x)
    cameraOffset.x += totalTileSize.y / 2 - totalTileSize.x / 2;

  const exportCamera = new CameraService(pixi.getNewContainer());
  exportCamera.setHardZoom(tileSize);
  exportCamera.cameraOffset = cameraOffset;
  exportCamera.overlay = Overlay.Base;
  exportCamera.display = Display.solid;
  const baseRenderTexture = pixi.getNewBaseRenderTexture({ width: size, height: size });
  const renderTexture = pixi.getNewRenderTexture(baseRenderTexture);

  // Tileables first, for every item: updateTileables inspects an item's
  // neighbours, so it cannot be interleaved with a draw order that only has
  // part of the blueprint in hand.
  blueprint.blueprintItems.forEach(item => item.updateTileables(blueprint));
  // Then depth, which drawPixi would otherwise resolve lazily per item — it
  // has to be known up front because it is what the draw order sorts on.
  blueprint.blueprintItems.forEach(item => item.cameraChanged(exportCamera));

  // Rasterize in depth-ordered batches, compositing each into the same render
  // texture and destroying it before building the next.
  //
  // One container for the whole blueprint meant every item's PIXI display
  // objects had to be live simultaneously: ~35KB an item on a real base
  // (several drawParts each — tileable variants, connection sprites, port
  // sprites), so 8,612 items is ~300MB of JS heap against a 256MB ceiling,
  // and the worker aborts with "Reached heap limit" rather than failing.
  // Batching makes the live set a function of the batch, not the blueprint.
  //
  // Correctness rests on the sort: with items in ascending depth and batches
  // composited in order, the painter's result is what one sorted container
  // produced. Items of equal depth keep their relative order across a batch
  // boundary too, because an earlier batch is always drawn first.
  const ordered = [...blueprint.blueprintItems].sort((a, b) => a.depth - b.depth);
  const chunkSize = RASTER_CHUNK_SIZE > 0 ? RASTER_CHUNK_SIZE : ordered.length;
  // `ordered` is now the only handle on the items, so a drawn batch can be
  // released. Nothing below reads blueprintItems — the bounding box is already
  // resolved, and the terrain/note passes work off their own arrays.
  blueprint.blueprintItems = [];

  // Utility ports are added to the *camera* container at zIndex 200, above
  // every building, so they cannot be composited with the batch that created
  // them — a later batch's buildings would paint over them. They are lifted
  // out of each batch and drawn in the overlay pass below.
  const utilityLayer = pixi.getNewContainer();
  utilityLayer.sortableChildren = true;
  utilityLayer.zIndex = 200;

  for (let offset = 0; offset < ordered.length; offset += chunkSize) {
    const chunk = ordered.slice(offset, offset + chunkSize);
    const chunkContainer = pixi.getNewContainer();
    chunkContainer.sortableChildren = true;
    exportCamera.container = chunkContainer;

    for (const item of chunk) item.drawPixi(exportCamera, pixi);
    // addChild re-parents, so this both rescues the sprites and takes them out
    // of the batch that is about to be destroyed.
    for (const item of chunk)
      for (const sprite of item.utilitySprites ?? []) if (sprite != null) utilityLayer.addChild(sprite);

    pixi.pixiApp.renderer.render(chunkContainer, renderTexture, false);
    // texture/baseTexture default to false here, so the shared decoded
    // textures survive; only this batch's display objects go.
    chunkContainer.destroy({ children: true });

    // Destroying the container is not enough on its own: a destroyed PIXI
    // object is still a live JS object, and every one of them is still
    // reachable from the item that made it (item.container,
    // drawPart.sprite). Until those references go, nothing is collected and
    // batching saves exactly nothing — which is what the first attempt at
    // this measured. Dropping them is what makes the batch's memory
    // recoverable.
    for (const item of chunk) {
      // Already re-parented into utilityLayer, and item.destroy() would
      // destroy them out from under the overlay pass.
      item.utilitySprites = [];
      item.destroy();
      for (const part of item.drawParts) {
        part.sprite = null;
        part.isReady = false;
      }
      // The imported graph is per-item too (~4KB each) and nothing reads it
      // after the item is drawn.
      item.drawParts.length = 0;
    }
    // Release the batch's items themselves. `ordered` is the only remaining
    // reference — blueprint.blueprintItems was emptied once the draw order
    // was taken.
    ordered.fill(null as any, offset, offset + chunk.length);
  }

  // Everything that belongs above the buildings, in one final pass: ports
  // (200), terrain annotations (5e5), then world notes (1e6).
  const overlayContainer = pixi.getNewContainer();
  overlayContainer.sortableChildren = true;
  exportCamera.container = overlayContainer;
  overlayContainer.addChild(utilityLayer);
  await drawTerrainFeatures(pixi, assetBaseDir, blueprint, exportCamera);
  await drawWorldNotes(pixi, assetBaseDir, blueprint, exportCamera);
  pixi.pixiApp.renderer.render(overlayContainer, renderTexture, false);

  // Raw RGBA straight out of getImageData (non-premultiplied): no PNG encode.
  // The old toDataURL path (full zlib encode + base64 + JSON IPC + re-decode
  // in the parent) was pure overhead — the master is consumed once and thrown
  // away.
  const extractStart = Date.now();
  sampleRss();
  mem.afterRasterize = memSample();
  // Peak snapshot: the scene graph is fully built and nothing has been
  // released yet. afterRasterize - afterTextures is the scene graph's live
  // cost; this snapshot says which constructors it went to.
  await writeHeapSnapshot('rasterize', label);
  const pixels: Uint8ClampedArray = pixi.pixiApp.renderer.plugins.extract.pixels(renderTexture);
  const raw = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  sampleRss();
  mem.afterExtract = memSample();

  // Each batch destroyed itself as it was composited; this is the overlay
  // pass, which is all that is still standing.
  exportCamera.container.destroy({ children: true });
  baseRenderTexture.destroy();
  renderTexture.destroy();
  // NOTE: global.gc is undefined unless the process was started with
  // --expose-gc, which the parent's fork() does not pass — so this has always
  // been a silent no-op. Left as-is here; whether to pass the flag is a
  // separate decision (it costs a full GC pause per render, and it targets
  // the cross-render texture drift rather than this render's peak).
  global.gc && global.gc();
  mem.afterRelease = memSample();

  return {
    raw,
    width: size,
    height: size,
    // Pixel position of cell (0,0)'s corner: screenX = (cellX + offset.x) *
    // zoom, screenY = (offset.y - cellY) * zoom (BlueprintItem.drawPixi's own
    // convention), each evaluated at cellX = cellY = 0.
    framing: {
      tileSize,
      offsetPx: { x: cameraOffset.x * tileSize, y: cameraOffset.y * tileSize },
    },
    timings: {
      importMs: texturesStart - importStart,
      texturesMs: rasterizeStart - texturesStart,
      rasterizeMs: extractStart - rasterizeStart,
      extractMs: Date.now() - extractStart,
      peakRssMb,
      mem,
      residentTextureMb: residentTextures,
    },
  };
}

// Minimal blueprint exercising every texture path: a flat-icon building
// (Battery), a tileable atlas-backed tile, a connectable (Wire, 16 bitmask
// sprites), a building with utility ports (LiquidPump), and a terrain
// annotation (Cool Steam Vent) to exercise drawTerrainFeatures. Rendered by
// `--smoke` to validate the deployed image end-to-end.
const SMOKE_FIXTURE: MdbBlueprint = {
  blueprintItems: [
    { id: 'Battery', position: new Vector2(0, 0) },
    { id: 'Tile', position: new Vector2(2, 0) },
    { id: 'Tile', position: new Vector2(3, 0) },
    { id: 'Wire', position: new Vector2(2, 1), connections: 3 },
    { id: 'Wire', position: new Vector2(3, 1), connections: 1 },
    { id: 'LiquidPump', position: new Vector2(0, 3) },
  ],
  terrainFeatures: [{ id: 'GeyserGeneric_steam', x: 5, y: 0 }],
};

// Render the fixture and exit 0/1. Run inside the built prod image (ideally
// under a prod-like memory cap) to validate what unit tests cannot: the
// canvas native binding, the on-disk asset layout, and the memory envelope.
async function runSmokeTest(pixi: PixiNodeUtil, assetBaseDir: string) {
  const blueprint = new SharedBlueprint();
  blueprint.importFromMdb(SMOKE_FIXTURE);
  // Uncapped: this call is asking whether every fixture texture exists on
  // disk, not what resolution it should be held at. renderMaster below applies
  // the real cap, and a native-size decode is never re-fetched for one.
  const missing = await ensureTextures(pixi, assetBaseDir, collectImageIds(blueprint), Infinity);
  if (missing > 0) throw new Error(`smoke: ${missing} fixture textures missing from asset root`);

  const { raw, width, height } = await renderMaster(pixi, assetBaseDir, SMOKE_FIXTURE, 1200);
  // The fixture covers a meaningful share of the frame; an all-placeholder
  // render (blank/transparent output) is the failure this guards against.
  let opaque = 0;
  for (let i = 3; i < raw.length; i += 4) if (raw[i] > 0) opaque++;
  const coverage = opaque / (width * height);
  if (coverage < 0.05)
    throw new Error(`smoke: render suspiciously empty (${(coverage * 100).toFixed(2)}% coverage)`);
  logRss(`smoke render ok (${(coverage * 100).toFixed(1)}% pixel coverage)`);
}

async function main() {
  const smoke = process.argv.includes('--smoke');
  if (!smoke && !process.send)
    throw new Error('preview-render-worker must be forked with an IPC channel');

  // Resolved (and logged) up front — including under --smoke, so the deploy
  // image check in CI shows the cap the production container will run with.
  const { maxRssMb, detail } = resolveMaxRssMb();
  // heap_size_limit is what --max-old-space-size actually produced. Logged
  // because the ceiling is the difference between a render that finishes and
  // one that aborts the process, and until now it was only inferable.
  const heapLimitMb = Math.round(v8.getHeapStatistics().heap_size_limit / (1024 * 1024));
  console.log(`preview-render-worker: ${detail}, v8 heap limit ${heapLimitMb}MB`);

  initSharedLib();
  const pixi = new PixiNodeUtil({ forceCanvas: true, preserveDrawingBuffer: true });
  const assetBaseDir = resolveAssetBaseDir();

  // Safety net for image ids collectImageIds missed: PixiNodeUtil throws here
  // by design ("all textures should be preloaded"); in this worker a warning
  // plus a blank placeholder beats failing the whole render.
  pixi.getNewBaseTexture = (url: string) => {
    console.warn(`preview-render-worker: texture not preloaded, using placeholder: ${url}`);
    return pixi.getNewBaseRenderTexture({ width: 1, height: 1 });
  };

  if (smoke) {
    await runSmokeTest(pixi, assetBaseDir);
    process.exit(0);
  }

  // Loaded textures accumulate across renders (ImageSource caches per image
  // id), so a long-lived worker serving many distinct blueprints drifts back
  // toward the full-preload footprint. Once RSS crosses the cap, exit between
  // renders: the parent re-forks on the next request (~1s cold start) and the
  // container never approaches the cgroup memory limit.
  let rendersInFlight = 0;

  process.on('message', async (message: any) => {
    if (!message || message.type !== 'render') return;
    const { requestId, mdb, size, blueprintId, itemCount } = message;
    // Announced *before* the render, because a render that exhausts the heap
    // aborts the process and never gets to log anything afterwards. Without
    // this line a crash is anonymous and the id has to be reconstructed from
    // Mongo — which is exactly how this bug had to be investigated.
    const label = `${blueprintId ?? 'unknown'} (${itemCount ?? '?'} items)`;
    console.log(`preview-render-worker: rendering ${label} request ${requestId} rss=${rssMb()}MB`);
    rendersInFlight++;
    try {
      let reply: object;
      let phases = '';
      try {
        const { raw, width, height, framing, timings } = await renderMaster(
          pixi,
          assetBaseDir,
          mdb,
          size,
          `${blueprintId ?? 'unknown'}-${itemCount ?? 0}items`
        );
        reply = { type: 'rendered', requestId, raw, width, height, framing, timings };
        const m = timings.mem;
        // Deltas, not absolutes: the absolute figures are dominated by the
        // resident baseline, which says nothing about this render. Each phase
        // reports rss/heap/external so a growth can be attributed to the JS
        // object graph or to native bitmaps rather than guessed at.
        const delta = (to: MemSample, from: MemSample) =>
          `${to.rss - from.rss}/${to.heap - from.heap}/${to.external - from.external}`;
        phases =
          ` import=${timings.importMs}ms textures=${timings.texturesMs}ms` +
          ` rasterize=${timings.rasterizeMs}ms extract=${timings.extractMs}ms` +
          ` peakRss=${timings.peakRssMb}MB textures=${timings.residentTextureMb}MB` +
          ` mem[rss/heap/external]MB(start=${m.start.rss}/${m.start.heap}/${m.start.external}` +
          ` +import=${delta(m.afterImport, m.start)}` +
          ` +tex=${delta(m.afterTextures, m.afterImport)}` +
          ` +raster=${delta(m.afterRasterize, m.afterTextures)}` +
          ` +extract=${delta(m.afterExtract, m.afterRasterize)}` +
          ` released=${delta(m.afterExtract, m.afterRelease)})`;
      } catch (e) {
        reply = { type: 'error', requestId, message: e instanceof Error ? e.message : String(e) };
      }
      // Wait for the IPC channel to flush the reply: process.exit in the
      // recycle check below would otherwise drop a still-queued message.
      await new Promise<void>(resolve => process.send!(reply, () => resolve()));
      logRss(`handled request ${requestId} ${label}${phases}`);
    } finally {
      rendersInFlight--;
    }
    const currentRssMb = rssMb();
    if (rendersInFlight === 0 && currentRssMb > maxRssMb) {
      console.log(`preview-render-worker: rss ${currentRssMb}MB over ${maxRssMb}MB cap, recycling`);
      process.exit(0);
    }
  });

  process.send!({ type: 'ready' });
  logRss('ready');
  startMemoryHeartbeat('preview-render-worker');
}

main().catch(e => {
  console.error('preview-render-worker failed to start:', e);
  process.exit(1);
});
