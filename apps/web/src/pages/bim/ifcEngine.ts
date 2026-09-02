/**
 * IfcEngine — in-browser IFC viewer built on three.js + web-ifc (wasm).
 *
 * Responsibilities:
 *  - parse an IFC STEP file entirely client-side (web-ifc wasm)
 *  - stream every placed geometry into THREE meshes (deinterleaved pos+normal)
 *  - element picking (raycast → expressID → GetLine attributes)
 *  - per-IfcType visibility, isolate/clear, horizontal section plane
 *  - camera fit, viewpoint capture for BCF-style coordination issues
 *
 * The page wraps every engine call in try/catch and degrades to the
 * API-backed elements table when wasm/WebGL are unavailable.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as WebIFC from "web-ifc";
import wasmUrl from "web-ifc/web-ifc.wasm?url";

export interface PickedElement {
  expressID: number;
  globalId: string | null;
  name: string | null;
  ifcType: string;
  attributes: { key: string; value: string }[];
}

export interface TypeBucket {
  ifcType: string;
  meshCount: number;
}

export interface Viewpoint {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
}

const PICK_DRAG_TOLERANCE = 5; // px — pointer moved more than this = orbit, not pick
const GLOBALID_INDEX_CAP = 30000; // safety cap for the lazy GlobalId → expressID index

export class IfcEngine {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private resizeObserver: ResizeObserver;

  private api: WebIFC.IfcAPI | null = null;
  private modelID = -1;

  private root = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private materialCache = new Map<string, THREE.MeshLambertMaterial>();
  private highlightMaterial: THREE.MeshLambertMaterial;
  private twinMaterial: THREE.MeshLambertMaterial;
  private bbox = new THREE.Box3();

  private selectedExpressID: number | null = null;
  private selectedOriginals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  /** meshes tinted because their element is bound to a digital-twin asset */
  private tintedOriginals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private hiddenTypes = new Set<string>();
  private isolatedExpressID: number | null = null;

  private clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  private sectionEnabled = false;

  private globalIdIndex: Map<string, number> | null = null;
  private disposed = false;

  private pointerDownAt: { x: number; y: number } | null = null;
  private readonly onPointerDown = (e: PointerEvent) => {
    this.pointerDownAt = { x: e.clientX, y: e.clientY };
  };
  private readonly onPointerUp = (e: PointerEvent) => {
    const start = this.pointerDownAt;
    this.pointerDownAt = null;
    if (!start) return;
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    if (moved > PICK_DRAG_TOLERANCE) return;
    this.pickAtScreen(e.clientX, e.clientY);
  };

  /** page callback — fired with the picked element, or null on empty click */
  onPick: ((el: PickedElement | null) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.setClearColor(0xf0f2f6, 1);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";

    this.scene = new THREE.Scene();
    this.scene.add(this.root);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);
    this.camera.position.set(20, 16, 20);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    const hemi = new THREE.HemisphereLight(0xffffff, 0xb8bec9, 1.05);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(40, 70, 30);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.45);
    dir2.position.set(-30, 20, -40);
    this.scene.add(dir2);

    const grid = new THREE.GridHelper(100, 50, 0xb9c2d0, 0xdde2ea);
    grid.name = "__grid";
    this.scene.add(grid);

    this.highlightMaterial = new THREE.MeshLambertMaterial({
      color: 0xf59e0b,
      emissive: 0x92400e,
      emissiveIntensity: 0.55,
      side: THREE.DoubleSide,
    });
    // twin-linked elements: green, so "this is already an asset" is visible
    // in the model rather than only in a list
    this.twinMaterial = new THREE.MeshLambertMaterial({
      color: 0x10b981,
      emissive: 0x065f46,
      emissiveIntensity: 0.35,
      side: THREE.DoubleSide,
    });

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);

    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);

    this.renderer.setAnimationLoop(() => {
      if (this.disposed) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  /* ------------------------------- loading ------------------------------- */

  /** Parse the IFC buffer and build the scene. Returns per-type mesh stats. */
  async load(buffer: ArrayBuffer): Promise<{ elementCount: number; types: TypeBucket[] }> {
    const api = new WebIFC.IfcAPI();
    // Point web-ifc at the Vite-emitted wasm asset. SetWasmPath covers dev
    // (unhashed file name); the locate handler covers production builds where
    // the asset name is hashed.
    api.SetWasmPath(wasmUrl.substring(0, wasmUrl.lastIndexOf("/") + 1), true);
    await api.Init((path: string) => (path.endsWith(".wasm") ? wasmUrl : path), true);
    this.api = api;

    this.modelID = api.OpenModel(new Uint8Array(buffer));

    const typeMeshCounts = new Map<string, number>();
    const seenExpressIDs = new Set<number>();

    api.StreamAllMeshes(this.modelID, (flatMesh) => {
      let ifcType = "IFCPRODUCT";
      try {
        const code = api.GetLineType(this.modelID, flatMesh.expressID);
        const name = api.GetNameFromTypeCode(Number(code));
        if (name) ifcType = String(name).toUpperCase();
      } catch {
        /* keep fallback type */
      }

      const placedCount = flatMesh.geometries.size();
      for (let i = 0; i < placedCount; i++) {
        const placed = flatMesh.geometries.get(i);
        let geometry: THREE.BufferGeometry | null = null;
        try {
          geometry = this.buildGeometry(placed.geometryExpressID);
        } catch {
          geometry = null;
        }
        if (!geometry) continue;

        const material = this.materialFor(placed.color);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.fromArray(placed.flatTransformation);
        mesh.userData["expressID"] = flatMesh.expressID;
        mesh.userData["ifcType"] = ifcType;
        this.meshes.push(mesh);
        this.root.add(mesh);
        typeMeshCounts.set(ifcType, (typeMeshCounts.get(ifcType) ?? 0) + 1);
      }
      seenExpressIDs.add(flatMesh.expressID);
    });

    if (this.meshes.length === 0) {
      throw new Error("No renderable geometry found in this IFC file");
    }

    this.bbox.setFromObject(this.root);
    this.fitCameraToModel();
    this.positionGrid();

    const types = [...typeMeshCounts.entries()]
      .map(([ifcType, meshCount]) => ({ ifcType, meshCount }))
      .sort((a, b) => b.meshCount - a.meshCount);
    return { elementCount: seenExpressIDs.size, types };
  }

  private buildGeometry(geometryExpressID: number): THREE.BufferGeometry | null {
    const api = this.api;
    if (!api) return null;
    const geom = api.GetGeometry(this.modelID, geometryExpressID);
    const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
    const indices = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
    if (verts.length === 0 || indices.length === 0) {
      geom.delete();
      return null;
    }

    // interleaved: x y z nx ny nz — deinterleave into position + normal
    const vertexCount = verts.length / 6;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    for (let v = 0; v < vertexCount; v++) {
      const src = v * 6;
      const dst = v * 3;
      positions[dst] = verts[src] ?? 0;
      positions[dst + 1] = verts[src + 1] ?? 0;
      positions[dst + 2] = verts[src + 2] ?? 0;
      normals[dst] = verts[src + 3] ?? 0;
      normals[dst + 1] = verts[src + 4] ?? 0;
      normals[dst + 2] = verts[src + 5] ?? 0;
    }
    const index = new Uint32Array(indices); // copy out of wasm memory

    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    bg.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    bg.setIndex(new THREE.BufferAttribute(index, 1));
    geom.delete();
    return bg;
  }

  private materialFor(color: { x: number; y: number; z: number; w: number }): THREE.MeshLambertMaterial {
    const key = `${color.x.toFixed(3)}|${color.y.toFixed(3)}|${color.z.toFixed(3)}|${color.w.toFixed(3)}`;
    const cached = this.materialCache.get(key);
    if (cached) return cached;
    const material = new THREE.MeshLambertMaterial({
      color: new THREE.Color(color.x, color.y, color.z),
      transparent: color.w < 1,
      opacity: color.w < 1 ? Math.max(color.w, 0.15) : 1,
      side: THREE.DoubleSide,
    });
    this.materialCache.set(key, material);
    return material;
  }

  /* ------------------------------- camera -------------------------------- */

  fitCameraToModel(): void {
    if (this.bbox.isEmpty()) return;
    const size = this.bbox.getSize(new THREE.Vector3());
    const center = this.bbox.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    this.camera.near = Math.max(maxDim / 1000, 0.01);
    this.camera.far = maxDim * 60;
    this.camera.updateProjectionMatrix();
    const offset = new THREE.Vector3(1, 0.75, 1).normalize().multiplyScalar(maxDim * 1.55);
    this.camera.position.copy(center).add(offset);
    this.controls.target.copy(center);
    this.controls.update();
  }

  private positionGrid(): void {
    const grid = this.scene.getObjectByName("__grid");
    if (!grid || this.bbox.isEmpty()) return;
    const size = this.bbox.getSize(new THREE.Vector3());
    const center = this.bbox.getCenter(new THREE.Vector3());
    const span = Math.max(size.x, size.z, 10) * 2;
    this.scene.remove(grid);
    const next = new THREE.GridHelper(span, 40, 0xb9c2d0, 0xdde2ea);
    next.name = "__grid";
    next.position.set(center.x, this.bbox.min.y - 0.05, center.z);
    this.scene.add(next);
  }

  getViewpoint(): Viewpoint {
    const p = this.camera.position;
    const t = this.controls.target;
    return {
      position: { x: p.x, y: p.y, z: p.z },
      target: { x: t.x, y: t.y, z: t.z },
    };
  }

  /* ------------------------------- picking ------------------------------- */

  private pickAtScreen(clientX: number, clientY: number): void {
    if (this.disposed || this.meshes.length === 0) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const visible = this.meshes.filter((m) => m.visible);
    const hits = this.raycaster.intersectObjects(visible, false);
    const hit = hits[0];
    if (!hit) {
      this.clearSelection();
      this.onPick?.(null);
      return;
    }
    const expressID = Number((hit.object as THREE.Mesh).userData["expressID"]);
    this.selectExpressID(expressID);
    this.onPick?.(this.describeElement(expressID));
  }

  /** GetLine attribute inspection — every access guarded. */
  describeElement(expressID: number): PickedElement {
    const fallbackType =
      (this.meshes.find((m) => m.userData["expressID"] === expressID)?.userData["ifcType"] as
        | string
        | undefined) ?? "IFCPRODUCT";
    const result: PickedElement = {
      expressID,
      globalId: null,
      name: null,
      ifcType: fallbackType,
      attributes: [],
    };
    if (!this.api || this.modelID < 0) return result;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const line: any = this.api.GetLine(this.modelID, expressID);
      if (!line) return result;
      const ctor = line.constructor?.name;
      if (typeof ctor === "string" && ctor.length > 0) result.ifcType = ctor.toUpperCase();
      const scalar = (v: unknown): string | null => {
        if (v === null || v === undefined) return null;
        if (typeof v === "object" && v !== null && "value" in (v as Record<string, unknown>)) {
          const inner = (v as { value: unknown }).value;
          return inner === null || inner === undefined ? null : String(inner);
        }
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          return String(v);
        }
        return null;
      };
      result.globalId = scalar(line.GlobalId);
      result.name = scalar(line.Name);
      for (const key of Object.keys(line)) {
        if (key === "expressID" || key === "type" || key === "GlobalId" || key === "Name") continue;
        const value = scalar(line[key]);
        if (value !== null && value !== "") result.attributes.push({ key, value });
        if (result.attributes.length >= 14) break;
      }
    } catch {
      /* attribute inspection is best-effort */
    }
    return result;
  }

  selectExpressID(expressID: number): void {
    this.clearSelection();
    this.selectedExpressID = expressID;
    for (const mesh of this.meshes) {
      if (mesh.userData["expressID"] === expressID) {
        this.selectedOriginals.set(mesh, mesh.material);
        mesh.material = this.highlightMaterial;
      }
    }
  }

  clearSelection(): void {
    for (const [mesh, material] of this.selectedOriginals) mesh.material = material;
    this.selectedOriginals.clear();
    this.selectedExpressID = null;
  }

  /** Is anything currently tinted as a twin asset? */
  hasTint(): boolean {
    return this.tintedOriginals.size > 0;
  }

  getSelectedExpressID(): number | null {
    return this.selectedExpressID;
  }

  /**
   * Select an element by its IFC GlobalId (from the API elements table).
   * Builds a lazy GlobalId → expressID index on first use (capped).
   * Returns the picked element, or null when the GUID has no geometry.
   */
  selectByGlobalId(globalId: string): PickedElement | null {
    const expressID = this.lookupExpressID(globalId);
    if (expressID === undefined) return null;
    this.selectExpressID(expressID);
    this.focusExpressID(expressID);
    return this.describeElement(expressID);
  }

  /** Build (once) and read the lazy GlobalId -> expressID index. */
  private lookupExpressID(globalId: string): number | undefined {
    if (!this.api || this.modelID < 0) return undefined;
    if (!this.globalIdIndex) {
      this.globalIdIndex = new Map();
      const uniqueIds = new Set<number>();
      for (const mesh of this.meshes) uniqueIds.add(Number(mesh.userData["expressID"]));
      let n = 0;
      for (const id of uniqueIds) {
        if (++n > GLOBALID_INDEX_CAP) break;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const line: any = this.api.GetLine(this.modelID, id);
          const guid = line?.GlobalId?.value;
          if (typeof guid === "string") this.globalIdIndex.set(guid, id);
        } catch {
          /* skip unreadable lines */
        }
      }
    }
    return this.globalIdIndex.get(globalId);
  }

  /**
   * Tint every element bound to a digital-twin asset (spec Domain L #658).
   * Returns how many of the supplied GlobalIds were found in the geometry, so
   * the page can say "42 of 60 linked assets are in this model" instead of
   * implying the rest do not exist.
   */
  tintByGlobalIds(globalIds: readonly string[]): number {
    this.clearTint();
    const ids = new Set<number>();
    for (const globalId of globalIds) {
      const expressID = this.lookupExpressID(globalId);
      if (expressID !== undefined) ids.add(expressID);
    }
    for (const mesh of this.meshes) {
      if (!ids.has(Number(mesh.userData["expressID"]))) continue;
      if (this.selectedOriginals.has(mesh)) continue; // selection wins
      this.tintedOriginals.set(mesh, mesh.material);
      mesh.material = this.twinMaterial;
    }
    return ids.size;
  }

  clearTint(): void {
    for (const [mesh, material] of this.tintedOriginals) mesh.material = material;
    this.tintedOriginals.clear();
  }

  /** Move the orbit target onto an element without changing camera distance much. */
  private focusExpressID(expressID: number): void {
    const box = new THREE.Box3();
    let found = false;
    for (const mesh of this.meshes) {
      if (mesh.userData["expressID"] === expressID) {
        box.expandByObject(mesh);
        found = true;
      }
    }
    if (!found || box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    this.controls.target.copy(center);
    this.controls.update();
  }

  /* --------------------------- visibility tools --------------------------- */

  setTypeVisible(ifcType: string, visible: boolean): void {
    const key = ifcType.toUpperCase();
    if (visible) this.hiddenTypes.delete(key);
    else this.hiddenTypes.add(key);
    this.applyVisibility();
  }

  /** Isolate the currently selected element. Returns false when nothing is selected. */
  isolateSelection(): boolean {
    if (this.selectedExpressID === null) return false;
    this.isolatedExpressID = this.selectedExpressID;
    this.applyVisibility();
    return true;
  }

  clearIsolation(): void {
    this.isolatedExpressID = null;
    this.applyVisibility();
  }

  isIsolated(): boolean {
    return this.isolatedExpressID !== null;
  }

  private applyVisibility(): void {
    for (const mesh of this.meshes) {
      const type = String(mesh.userData["ifcType"] ?? "");
      const typeVisible = !this.hiddenTypes.has(type);
      const isolationVisible =
        this.isolatedExpressID === null || mesh.userData["expressID"] === this.isolatedExpressID;
      mesh.visible = typeVisible && isolationVisible;
    }
  }

  /* ----------------------------- section plane ---------------------------- */

  setSectionEnabled(enabled: boolean): void {
    this.sectionEnabled = enabled;
    const planes = enabled ? [this.clipPlane] : null;
    for (const material of this.materialCache.values()) material.clippingPlanes = planes;
    this.highlightMaterial.clippingPlanes = planes;
  }

  isSectionEnabled(): boolean {
    return this.sectionEnabled;
  }

  /** Cut everything above `height` (world Y). */
  setSectionHeight(height: number): void {
    this.clipPlane.constant = height;
  }

  getHeightRange(): { min: number; max: number } {
    if (this.bbox.isEmpty()) return { min: 0, max: 10 };
    return { min: this.bbox.min.y, max: this.bbox.max.y };
  }

  /* -------------------------------- cleanup ------------------------------- */

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.controls.dispose();
    for (const mesh of this.meshes) mesh.geometry.dispose();
    for (const material of this.materialCache.values()) material.dispose();
    this.highlightMaterial.dispose();
    this.twinMaterial.dispose();
    this.meshes = [];
    this.materialCache.clear();
    try {
      if (this.api && this.modelID >= 0) this.api.CloseModel(this.modelID);
    } catch {
      /* wasm teardown is best-effort */
    }
    this.api = null;
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }

  private resize(): void {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}
