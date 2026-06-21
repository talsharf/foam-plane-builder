import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { CameraController } from './cameraController';

export type SelectionFilter = 'VERTEX' | 'EDGE' | 'FACE';
export type GizmoMode = 'translate' | 'rotate' | 'scale';

export interface UniqueVertex {
  position: THREE.Vector3;
  indices: number[]; // All duplicate vertex indices in the buffer attribute (for normal splitting)
}

export interface Edge {
  id: string;
  v0: number; // Unique vertex index
  v1: number; // Unique vertex index
}

export interface Face {
  id: string;
  uniqueVertexIds: number[]; // Unique vertex indices forming the face boundary
  triangles: number[];       // Indices of triangles in the geometry index belonging to this face
  normal: THREE.Vector3;
}

export class MeshEditor {
  private scene: THREE.Scene;
  private cameraController: CameraController;
  private orbitControls: OrbitControls;
  private canvas: HTMLCanvasElement;

  // Active editable target
  private targetMesh: THREE.Mesh | null = null;
  private isEditMode = true;
  private activeGizmoMode: GizmoMode = 'translate';

  // Hover states
  private hoveredElement: { type: SelectionFilter; index: number } | null = null;
  private hoverHelper: THREE.Object3D | null = null;

  // Geometry indexing data
  private uniqueVertices: UniqueVertex[] = [];
  private edges: Edge[] = [];
  private faces: Face[] = [];

  // Selection states
  private selectedType: SelectionFilter | null = null;
  private selectedId: number = -1; // Index in uniqueVertices (VERTEX), edges (EDGE), or faces (FACE)
  private selectionCentroid = new THREE.Vector3();

  // Helper visual objects in 3D Scene
  private vertexHandlesGroup = new THREE.Group();
  private scaleHandlesGroup = new THREE.Group();
  private highlightHelper: THREE.Object3D | null = null;
  private transformControls!: TransformControls;
  private dummyTransformObject = new THREE.Object3D();
  private elToolDisplay: HTMLElement | null = null;

  // Drag states
  private isDragging = false;
  private wasDragging = false;
  private initialVertexPositions: THREE.Vector3[] = []; // Cached positions before drag start
  private affectedUniqueVertexIds: number[] = [];       // Unique vertex IDs modified by active transform

  // Custom scaling handles visual group and state
  private isDraggingScaleHandle = false;
  private activeScaleHandle: THREE.Mesh | null = null;
  private hoveredScaleHandle: THREE.Mesh | null = null;

  // Custom scaling math cache
  private initialScaleCentroid = new THREE.Vector3();
  private initialScaleDirection = new THREE.Vector3(); // For edges
  private initialScaleHalfLength = 0;                  // For edges
  private draggedVertexId = -1;                        // For edges (v0 or v1)

  private initialScaleU = new THREE.Vector3();         // For faces
  private initialScaleV = new THREE.Vector3();         // For faces
  private faceHandleType: 'corner' | 'edge' | null = null; // For faces
  private initialHandleU = 0;                          // For faces
  private initialHandleV = 0;                          // For faces
  private initialFaceVerticesUV: { id: number; u: number; v: number }[] = []; // For faces

  // Raycasting
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  // Assembly manager hook and geometry change callback
  private assemblyManager: any = null;
  public onGeometryChanged?: () => void;

  constructor(
    scene: THREE.Scene,
    cameraController: CameraController,
    orbitControls: OrbitControls,
    canvas: HTMLCanvasElement
  ) {
    this.scene = scene;
    this.cameraController = cameraController;
    this.orbitControls = orbitControls;
    this.canvas = canvas;

    this.scene.add(this.vertexHandlesGroup);
    this.scene.add(this.scaleHandlesGroup);
    this.scene.add(this.dummyTransformObject);

    this.elToolDisplay = document.getElementById('tool-display');

    this.setupTransformControls();
    this.setupMouseEvents();
    this.setupUIBindings();
  }

  public setAssemblyManager(assemblyManager: any) {
    this.assemblyManager = assemblyManager;
  }

  // Set the mesh to edit
  public setTargetMesh(mesh: THREE.Mesh | null) {
    this.targetMesh = mesh;
    this.rebuildEditMode();
    if (mesh) {
      this.updateStatusText("Edit Mode Active. Select a vertex, edge, or face.");
    } else {
      this.updateStatusText("Select Mode Active");
    }
  }

  private disableEditMode() {
    this.clearSelection();
    this.hoveredElement = null;
    this.removeHoverHelper();
    this.vertexHandlesGroup.clear();
    this.transformControls.detach();
  }

  private rebuildEditMode() {
    this.disableEditMode();
    if (!this.targetMesh) return;

    if (this.assemblyManager) {
      const comp = this.assemblyManager.getComponentByMesh(this.targetMesh);
      if (comp) {
        this.uniqueVertices = comp.indexedGeometry.uniqueVertices;
        this.edges = comp.indexedGeometry.edges;
        this.faces = comp.indexedGeometry.faces;
      } else {
        this.indexGeometry();
      }
    } else {
      this.indexGeometry();
    }
    
    this.createVertexHandles();
  }

  // Analysis of buffer geometry: merges split vertices, builds edges and faces
  private indexGeometry() {
    if (!this.targetMesh) return;
    const result = MeshEditor.indexMeshGeometry(this.targetMesh);
    this.uniqueVertices = result.uniqueVertices;
    this.edges = result.edges;
    this.faces = result.faces;
  }

  // Analysis of buffer geometry (static helper for AssemblyManager caching)
  public static indexMeshGeometry(mesh: THREE.Mesh): { uniqueVertices: UniqueVertex[]; edges: Edge[]; faces: Face[]; } {
    const geom = mesh.geometry;
    const posAttr = geom.attributes.position;
    if (!posAttr) {
      return { uniqueVertices: [], edges: [], faces: [] };
    }

    const uniqueVertices: UniqueVertex[] = [];
    let edges: Edge[] = [];
    const faces: Face[] = [];

    const epsilon = 0.01;

    // 1. Extract Unique Vertices by position merging
    const tempV = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      tempV.fromBufferAttribute(posAttr, i);
      
      // Look for match
      let found = -1;
      for (let j = 0; j < uniqueVertices.length; j++) {
        if (uniqueVertices[j].position.distanceTo(tempV) < epsilon) {
          found = j;
          break;
        }
      }

      if (found !== -1) {
        uniqueVertices[found].indices.push(i);
      } else {
        uniqueVertices.push({
          position: tempV.clone(),
          indices: [i]
        });
      }
    }

    const getUniqueVertexIndex = (bufferIdx: number): number => {
      for (let i = 0; i < uniqueVertices.length; i++) {
        if (uniqueVertices[i].indices.includes(bufferIdx)) {
          return i;
        }
      }
      return 0;
    };

    const getTriangleUniqueVertexIds = (triIdx: number, indices: THREE.BufferAttribute | null): number[] => {
      let idx0 = triIdx * 3;
      let idx1 = triIdx * 3 + 1;
      let idx2 = triIdx * 3 + 2;

      if (indices) {
        idx0 = indices.getX(idx0);
        idx1 = indices.getX(idx1);
        idx2 = indices.getX(idx2);
      }

      return [
        getUniqueVertexIndex(idx0),
        getUniqueVertexIndex(idx1),
        getUniqueVertexIndex(idx2)
      ];
    };

    // 2. Map Triangles & Extract Edges
    const indices = geom.index;
    const triangleCount = indices ? indices.count / 3 : posAttr.count / 3;
    const triNormals: THREE.Vector3[] = [];

    // Temporary storage for edge creation
    const edgeMap = new Map<string, Edge>();

    for (let t = 0; t < triangleCount; t++) {
      let idx0 = t * 3;
      let idx1 = t * 3 + 1;
      let idx2 = t * 3 + 2;

      if (indices) {
        idx0 = indices.getX(idx0);
        idx1 = indices.getX(idx1);
        idx2 = indices.getX(idx2);
      }

      // Map to unique vertex indices
      const u0 = getUniqueVertexIndex(idx0);
      const u1 = getUniqueVertexIndex(idx1);
      const u2 = getUniqueVertexIndex(idx2);

      // Add Edges (sorted to avoid duplication)
      const addEdge = (a: number, b: number) => {
        const sorted = a < b ? `${a}-${b}` : `${b}-${a}`;
        if (!edgeMap.has(sorted)) {
          edgeMap.set(sorted, {
            id: sorted,
            v0: a < b ? a : b,
            v1: a < b ? b : a
          });
        }
      };

      addEdge(u0, u1);
      addEdge(u1, u2);
      addEdge(u2, u0);

      // Compute triangle normal
      const p0 = uniqueVertices[u0].position;
      const p1 = uniqueVertices[u1].position;
      const p2 = uniqueVertices[u2].position;

      const norm = new THREE.Vector3()
        .crossVectors(
          new THREE.Vector3().subVectors(p1, p0),
          new THREE.Vector3().subVectors(p2, p0)
        )
        .normalize();
      triNormals.push(norm);
    }

    edges = Array.from(edgeMap.values());

    // 3. Auto-group Triangles into Coplanar Faces
    const visitedTriangles = new Set<number>();
    
    for (let t = 0; t < triangleCount; t++) {
      if (visitedTriangles.has(t)) continue;

      const currentFaceTriangles: number[] = [t];
      visitedTriangles.add(t);
      const faceNormal = triNormals[t].clone();

      // Flood fill to find adjacent coplanar triangles
      let queue = [t];
      while (queue.length > 0) {
        const curr = queue.shift()!;
        
        // Find vertices of current triangle
        const uCurr = getTriangleUniqueVertexIds(curr, indices);

        // Scan all other unvisited triangles
        for (let other = 0; other < triangleCount; other++) {
          if (visitedTriangles.has(other)) continue;

          // Normal comparison (coplanar check)
          const angle = faceNormal.angleTo(triNormals[other]);
          if (angle < 0.05) { // ~3 degrees tolerance
            const uOther = getTriangleUniqueVertexIds(other, indices);
            
            // Check if they share at least one edge (2 shared unique vertices)
            const sharedCount = uCurr.filter(v => uOther.includes(v)).length;
            if (sharedCount >= 2) {
              visitedTriangles.add(other);
              currentFaceTriangles.push(other);
              queue.push(other);
            }
          }
        }
      }

      // Collect unique vertex IDs defining this face
      const faceVertexIdsSet = new Set<number>();
      currentFaceTriangles.forEach(triIdx => {
        const ids = getTriangleUniqueVertexIds(triIdx, indices);
        ids.forEach(id => faceVertexIdsSet.add(id));
      });

      faces.push({
        id: `face_${faces.length}`,
        uniqueVertexIds: Array.from(faceVertexIdsSet),
        triangles: currentFaceTriangles,
        normal: faceNormal
      });
    }

    // 4. Filter out diagonal/internal edges of coplanar faces so they are not selectable
    const indicesAttr = geom.index;
    const filteredEdges: Edge[] = [];

    edges.forEach(edge => {
      // Find all triangles that contain this edge
      const sharingTriangles: number[] = [];
      for (let t = 0; t < triangleCount; t++) {
        const uIds = getTriangleUniqueVertexIds(t, indicesAttr);
        if (uIds.includes(edge.v0) && uIds.includes(edge.v1)) {
          sharingTriangles.push(t);
        }
      }

      // Find the face index for each sharing triangle
      const sharingFaceIndices = sharingTriangles.map(triIdx => {
        return faces.findIndex(f => f.triangles.includes(triIdx));
      });

      // If all sharing triangles belong to the same face, it's an internal/diagonal edge
      let isInternal = false;
      if (sharingFaceIndices.length > 1) {
        const firstFaceIdx = sharingFaceIndices[0];
        const allSameFace = sharingFaceIndices.every(faceIdx => faceIdx === firstFaceIdx && faceIdx !== -1);
        if (allSameFace) {
          isInternal = true;
        }
      }

      if (!isInternal) {
        filteredEdges.push(edge);
      }
    });

    return { uniqueVertices, edges: filteredEdges, faces };
  }

  // Create selection dots at unique vertices in Edit Mode
  private createVertexHandles() {
    this.vertexHandlesGroup.clear();
    if (!this.targetMesh) return;

    const dotGeom = new THREE.SphereGeometry(1.2, 12, 12);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0x64748b }); // Slate Gray

    this.uniqueVertices.forEach((uv, idx) => {
      const handle = new THREE.Mesh(dotGeom, dotMat.clone());
      handle.position.copy(uv.position);
      // Save unique vertex index into userData
      handle.userData = { uniqueVertexIdx: idx };
      this.vertexHandlesGroup.add(handle);
    });

    // Update positions relative to targetMesh transform
    this.vertexHandlesGroup.position.copy(this.targetMesh.position);
    this.vertexHandlesGroup.rotation.copy(this.targetMesh.rotation);
  }

  private setupTransformControls() {
    const activeCam = this.cameraController.getActiveCamera();
    this.transformControls = new TransformControls(activeCam, this.canvas);
    this.scene.add(this.transformControls);

    // Disable camera movement during gizmo dragging
    this.transformControls.addEventListener('dragging-changed', (e: any) => {
      this.orbitControls.enabled = !e.value;
      this.isDragging = e.value;

      if (e.value) {
        this.cacheInitialVertexPositions();
      } else {
        // Run planarity enforcer upon releasing mouse
        this.enforcePlanarity();
        this.wasDragging = true;

        // Recalculate selection centroid and update helper positions to prevent jumps
        this.calculateSelectionCentroid();
        this.dummyTransformObject.position.copy(this.selectionCentroid);
        this.dummyTransformObject.quaternion.set(0, 0, 0, 1);
        this.dummyTransformObject.scale.set(1, 1, 1);
        this.updateHelpers();
      }
    });

    // Handle gizmo movements
    this.transformControls.addEventListener('change', () => {
      if (this.isDragging && this.targetMesh) {
        this.applyGizmoTransform();
      }
    });
  }

  private setupMouseEvents() {
    // Intercept clicks on our custom scaling handles
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.isEditMode || !this.targetMesh || this.activeGizmoMode !== 'scale') return;
      if (e.button !== 0) return; // Left click only

      const activeCamera = this.cameraController.getActiveCamera();
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      this.raycaster.setFromCamera(this.mouse, activeCamera);
      const intersects = this.raycaster.intersectObjects(this.scaleHandlesGroup.children);
      if (intersects.length > 0) {
        const hitHandle = intersects[0].object as THREE.Mesh;
        this.startScaleDrag(hitHandle);
        e.stopPropagation();
      }
    });

    // Left click selects the currently hovered element
    this.canvas.addEventListener('click', (e) => {
      if (this.wasDragging) {
        this.wasDragging = false;
        return;
      }

      if (e.button !== 0 || !this.isEditMode || !this.targetMesh || this.isDragging || this.isDraggingScaleHandle) return;

      // If the user clicked on the gizmo, do not change selection
      if (this.transformControls && this.transformControls.axis !== null) {
        return;
      }

      if (this.hoveredElement) {
        this.selectElement(this.hoveredElement.type, this.hoveredElement.index);
      } else {
        this.clearSelection();
      }
    });

    // Pointer move tracks cursor for proximity highlighting
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.isDragging || this.isDraggingScaleHandle || !this.isEditMode || !this.targetMesh) return;

      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      // 1. Raycast against scale handles if in scale mode
      if (this.activeGizmoMode === 'scale' && this.scaleHandlesGroup.children.length > 0) {
        const activeCamera = this.cameraController.getActiveCamera();
        this.raycaster.setFromCamera(this.mouse, activeCamera);
        const intersects = this.raycaster.intersectObjects(this.scaleHandlesGroup.children);
        if (intersects.length > 0) {
          const hitHandle = intersects[0].object as THREE.Mesh;
          this.hoveredScaleHandle = hitHandle;
          
          this.scaleHandlesGroup.children.forEach(child => {
            const h = child as THREE.Mesh;
            if (h === hitHandle) {
              (h.material as THREE.MeshBasicMaterial).color.set(0x166534); // Darker Green hover
            } else {
              (h.material as THREE.MeshBasicMaterial).color.set(h.userData.defaultColor);
            }
          });

          if (this.hoveredElement) {
            this.hoveredElement = null;
            this.removeHoverHelper();
          }
          return;
        } else {
          this.hoveredScaleHandle = null;
          this.scaleHandlesGroup.children.forEach(child => {
            const h = child as THREE.Mesh;
            ((h as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(h.userData.defaultColor);
          });
        }
      }

      // If the cursor is hovering over the transform gizmo axes, do not update hover highlights
      if (this.transformControls && this.transformControls.axis !== null) {
        if (this.hoveredElement !== null) {
          this.hoveredElement = null;
          this.removeHoverHelper();
        }
        return;
      }

      const prox = this.getProximityElement();
      if (!this.hoveredElement || !prox || this.hoveredElement.type !== prox.type || this.hoveredElement.index !== prox.index) {
        this.hoveredElement = prox;
        this.createHoverHelper();
      }
    });

    // Clear hover indicators when leaving the canvas
    this.canvas.addEventListener('pointerleave', () => {
      this.hoveredElement = null;
      this.removeHoverHelper();
      this.hoveredScaleHandle = null;
      this.scaleHandlesGroup.children.forEach(child => {
        const h = child as THREE.Mesh;
        ((h as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(h.userData.defaultColor);
      });
    });
  }

  private setupUIBindings() {
    const bindBtn = (id: string, callback: () => void) => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', callback);
    };

    bindBtn('btn-gizmo-translate', () => this.setGizmoMode('translate'));
    bindBtn('btn-gizmo-rotate', () => this.setGizmoMode('rotate'));
    bindBtn('btn-gizmo-scale', () => this.setGizmoMode('scale'));
  }

  private setGizmoMode(mode: GizmoMode) {
    if (this.activeGizmoMode === mode) return;
    this.activeGizmoMode = mode;

    const modes: GizmoMode[] = ['translate', 'rotate', 'scale'];
    modes.forEach(m => {
      const btn = document.getElementById(`btn-gizmo-${m}`);
      if (btn) btn.classList.remove('active');
    });

    const activeBtn = document.getElementById(`btn-gizmo-${mode}`);
    if (activeBtn) activeBtn.classList.add('active');

    if (mode === 'scale') {
      this.transformControls.detach();
      this.rebuildScaleHandles();
    } else {
      this.clearScaleHandles();
      this.transformControls.setMode(mode);
      if (this.selectedId !== -1) {
        this.transformControls.attach(this.dummyTransformObject);
      }
    }
  }

  // 2D distance from a point to a line segment in screen pixels
  private distanceToSegment2D(mx: number, my: number, x0: number, y0: number, x1: number, y1: number): number {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(mx - x0, my - y0);
    
    let t = ((mx - x0) * dx + (my - y0) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(mx - (x0 + t * dx), my - (y0 + t * dy));
  }

  // Hover & selection proximity detection
  private getProximityElement(): { type: SelectionFilter; index: number } | null {
    if (!this.targetMesh) return null;

    const activeCamera = this.cameraController.getActiveCamera();
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    // Convert mouse NDC to screen pixels
    const mouseX = ((this.mouse.x + 1) * width) / 2;
    const mouseY = ((-this.mouse.y + 1) * height) / 2;

    // 1. Check Vertex proximity in screen space (pixels)
    let minVertexDist = Infinity;
    let closestVertexIdx = -1;

    this.uniqueVertices.forEach((uv, idx) => {
      const worldV = uv.position.clone().applyMatrix4(this.targetMesh!.matrixWorld);
      const screenV = worldV.project(activeCamera);
      
      // Check if vertex is actually in front of camera frustum
      if (screenV.z <= 1) {
        const sx = ((screenV.x + 1) * width) / 2;
        const sy = ((-screenV.y + 1) * height) / 2;
        const dist = Math.hypot(sx - mouseX, sy - mouseY);

        if (dist < minVertexDist) {
          minVertexDist = dist;
          closestVertexIdx = idx;
        }
      }
    });

    const VERTEX_THRESHOLD_PIXELS = 16; // 16px hover radius
    if (closestVertexIdx !== -1 && minVertexDist < VERTEX_THRESHOLD_PIXELS) {
      return { type: 'VERTEX', index: closestVertexIdx };
    }

    // 2. Check Edge proximity in screen space (pixels)
    let minEdgeDist = Infinity;
    let closestEdgeIdx = -1;

    this.edges.forEach((edge, idx) => {
      const p0 = this.uniqueVertices[edge.v0].position.clone().applyMatrix4(this.targetMesh!.matrixWorld);
      const p1 = this.uniqueVertices[edge.v1].position.clone().applyMatrix4(this.targetMesh!.matrixWorld);
      
      const s0 = p0.project(activeCamera);
      const s1 = p1.project(activeCamera);

      if (s0.z <= 1 && s1.z <= 1) {
        const sx0 = ((s0.x + 1) * width) / 2;
        const sy0 = ((-s0.y + 1) * height) / 2;
        const sx1 = ((s1.x + 1) * width) / 2;
        const sy1 = ((-s1.y + 1) * height) / 2;

        const dist = this.distanceToSegment2D(mouseX, mouseY, sx0, sy0, sx1, sy1);
        if (dist < minEdgeDist) {
          minEdgeDist = dist;
          closestEdgeIdx = idx;
        }
      }
    });

    const EDGE_THRESHOLD_PIXELS = 12; // 12px hover width
    if (closestEdgeIdx !== -1 && minEdgeDist < EDGE_THRESHOLD_PIXELS) {
      return { type: 'EDGE', index: closestEdgeIdx };
    }

    // 3. Check Face raycasting intersection
    this.raycaster.setFromCamera(this.mouse, activeCamera);
    const intersects = this.raycaster.intersectObject(this.targetMesh);
    if (intersects.length > 0) {
      const intersection = intersects[0];
      const faceIdx = intersection.faceIndex;
      if (faceIdx !== undefined) {
        const mappedFaceIdx = this.faces.findIndex(f => f.triangles.includes(faceIdx));
        if (mappedFaceIdx !== -1) {
          return { type: 'FACE', index: mappedFaceIdx };
        }
      }
    }

    return null;
  }

  private selectElement(type: SelectionFilter, index: number) {
    this.clearSelection();
    this.selectedType = type;
    this.selectedId = index;

    // Handle vertex rotation and scale restrictions (disable rotate/scale buttons, switch mode if active)
    const rotateBtn = document.getElementById('btn-gizmo-rotate') as HTMLButtonElement | null;
    const scaleBtn = document.getElementById('btn-gizmo-scale') as HTMLButtonElement | null;
    if (type === 'VERTEX') {
      if (rotateBtn) rotateBtn.disabled = true;
      if (scaleBtn) scaleBtn.disabled = true;
      if (this.activeGizmoMode === 'rotate' || this.activeGizmoMode === 'scale') {
        this.setGizmoMode('translate');
      }
    } else {
      if (rotateBtn) rotateBtn.disabled = false;
      if (scaleBtn) scaleBtn.disabled = false;
    }

    this.calculateSelectionCentroid();
    this.createHighlightHelper();

    if (this.activeGizmoMode === 'scale') {
      this.transformControls.detach();
      this.rebuildScaleHandles();
    } else {
      this.clearScaleHandles();
      // Position dummy object at selection centroid and attach TransformControls
      this.dummyTransformObject.position.copy(this.selectionCentroid);
      this.dummyTransformObject.quaternion.set(0, 0, 0, 1);
      this.dummyTransformObject.scale.set(1, 1, 1);
      
      // Sync transform mode
      this.transformControls.setMode(this.activeGizmoMode);
      this.transformControls.attach(this.dummyTransformObject);
    }

    // Update status text
    let desc = "";
    if (type === 'VERTEX') desc = `Vertex #${index} selected. Translate to deform.`;
    else if (type === 'EDGE') desc = `Edge selected (${this.edges[index].v0} to ${this.edges[index].v1}).`;
    else desc = `Face #${index} selected (contains ${this.faces[index].uniqueVertexIds.length} vertices).`;
    
    this.updateStatusText(`Selected ${desc}`);
  }

  private clearSelection() {
    this.selectedType = null;
    this.selectedId = -1;
    this.transformControls.detach();
    this.clearScaleHandles();
    this.removeHighlightHelper();

    const rotateBtn = document.getElementById('btn-gizmo-rotate') as HTMLButtonElement | null;
    const scaleBtn = document.getElementById('btn-gizmo-scale') as HTMLButtonElement | null;
    if (rotateBtn) rotateBtn.disabled = false;
    if (scaleBtn) scaleBtn.disabled = false;
  }

  private calculateSelectionCentroid() {
    if (!this.targetMesh || this.selectedId === -1) return;

    const center = new THREE.Vector3();
    const uIds = this.getSelectedUniqueVertexIds();

    uIds.forEach(id => {
      center.add(this.uniqueVertices[id].position);
    });
    center.divideScalar(uIds.length);

    // Apply targetMesh world matrix to project local centroid to world coordinates
    this.selectionCentroid.copy(center).applyMatrix4(this.targetMesh.matrixWorld);
  }

  private getSelectedUniqueVertexIds(): number[] {
    if (this.selectedId === -1) return [];
    if (this.selectedType === 'VERTEX') {
      return [this.selectedId];
    } else if (this.selectedType === 'EDGE') {
      const edge = this.edges[this.selectedId];
      return [edge.v0, edge.v1];
    } else if (this.selectedType === 'FACE') {
      return this.faces[this.selectedId].uniqueVertexIds;
    }
    return [];
  }

  // Highlights selected element (Vertex, Edge, or Face boundaries)
  private createHighlightHelper() {
    this.removeHighlightHelper();
    if (!this.targetMesh || this.selectedId === -1) return;

    if (this.selectedType === 'VERTEX') {
      // Highlight dot handle and scale up
      this.vertexHandlesGroup.children.forEach(child => {
        const handle = child as THREE.Mesh;
        if (handle.userData.uniqueVertexIdx === this.selectedId) {
          (handle.material as THREE.MeshBasicMaterial).color.set(0x06b6d4); // Light Cyan
          handle.scale.set(1.8, 1.8, 1.8);
        }
      });
    } else if (this.selectedType === 'EDGE') {
      // Draw bold yellow 3D cylinder along edge to guarantee thickness across WebGL platforms
      const edge = this.edges[this.selectedId];
      const p0 = this.uniqueVertices[edge.v0].position;
      const p1 = this.uniqueVertices[edge.v1].position;

      const distance = p0.distanceTo(p1);
      const midpoint = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
      const direction = new THREE.Vector3().subVectors(p1, p0).normalize();
      
      const alignAxis = new THREE.Vector3(0, 1, 0);
      const quaternion = new THREE.Quaternion().setFromUnitVectors(alignAxis, direction);

      const geom = new THREE.CylinderGeometry(1.2, 1.2, distance, 6);
      const boldYellowMat = new THREE.MeshBasicMaterial({
        color: 0xfbbf24, // Yellow highlight
        depthTest: false
      });
      const lineMesh = new THREE.Mesh(geom, boldYellowMat);
      lineMesh.position.copy(midpoint);
      lineMesh.quaternion.copy(quaternion);
      lineMesh.renderOrder = 2;
      this.targetMesh.add(lineMesh);
      this.highlightHelper = lineMesh;
    } else if (this.selectedType === 'FACE') {
      const face = this.faces[this.selectedId];
      const group = new THREE.Group();

      // 1. Draw the face surface in semi-transparent white
      const geom = new THREE.BufferGeometry();
      const vertices: number[] = [];
      const positionAttr = this.targetMesh.geometry.attributes.position;
      const indexAttr = this.targetMesh.geometry.index;

      face.triangles.forEach(triIdx => {
        let idx0 = triIdx * 3;
        let idx1 = triIdx * 3 + 1;
        let idx2 = triIdx * 3 + 2;

        if (indexAttr) {
          idx0 = indexAttr.getX(idx0);
          idx1 = indexAttr.getX(idx1);
          idx2 = indexAttr.getX(idx2);
        }

        const p0 = new THREE.Vector3().fromBufferAttribute(positionAttr, idx0);
        const p1 = new THREE.Vector3().fromBufferAttribute(positionAttr, idx1);
        const p2 = new THREE.Vector3().fromBufferAttribute(positionAttr, idx2);

        vertices.push(p0.x, p0.y, p0.z);
        vertices.push(p1.x, p1.y, p1.z);
        vertices.push(p2.x, p2.y, p2.z);
      });

      geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geom.computeVertexNormals();

      const faceMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, // White overlay
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        transparent: true,
        opacity: 0.6
      });
      
      const faceMesh = new THREE.Mesh(geom, faceMat);
      faceMesh.renderOrder = 2;
      group.add(faceMesh);

      // 2. Draw the 4 boundary edges of the face in yellow
      const boundaryEdges = this.edges.filter(edge => 
        face.uniqueVertexIds.includes(edge.v0) && face.uniqueVertexIds.includes(edge.v1)
      );

      const cylinderGeom = new THREE.CylinderGeometry(1.2, 1.2, 1.0, 6);
      const yellowMat = new THREE.MeshBasicMaterial({
        color: 0xfbbf24, // Yellow highlight
        depthTest: false
      });

      boundaryEdges.forEach(edge => {
        const p0 = this.uniqueVertices[edge.v0].position;
        const p1 = this.uniqueVertices[edge.v1].position;

        const distance = p0.distanceTo(p1);
        const midpoint = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
        const direction = new THREE.Vector3().subVectors(p1, p0).normalize();
        
        const alignAxis = new THREE.Vector3(0, 1, 0);
        const quaternion = new THREE.Quaternion().setFromUnitVectors(alignAxis, direction);

        const edgeMesh = new THREE.Mesh(cylinderGeom, yellowMat);
        edgeMesh.scale.set(1, distance, 1);
        edgeMesh.position.copy(midpoint);
        edgeMesh.quaternion.copy(quaternion);
        edgeMesh.renderOrder = 3; // Render boundary lines on top of the face overlay
        group.add(edgeMesh);
      });

      this.targetMesh.add(group);
      this.highlightHelper = group;
    }
  }

  private removeHighlightHelper() {
    if (this.highlightHelper) {
      if (this.highlightHelper.parent) {
        this.highlightHelper.parent.remove(this.highlightHelper);
      }
      
      if (this.highlightHelper instanceof THREE.Group) {
        this.highlightHelper.children.forEach(child => {
          const mesh = child as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          if (mesh.material) {
            if (Array.isArray(mesh.material)) {
              mesh.material.forEach(m => m.dispose());
            } else {
              mesh.material.dispose();
            }
          }
        });
      } else {
        if ((this.highlightHelper as any).geometry) {
          (this.highlightHelper as any).geometry.dispose();
        }
        if ((this.highlightHelper as any).material) {
          const mat = (this.highlightHelper as any).material;
          if (Array.isArray(mat)) {
            mat.forEach((m: any) => m.dispose());
          } else {
            mat.dispose();
          }
        }
      }
      
      this.highlightHelper = null;
    }

    // Reset vertex handle colors and scale
    this.vertexHandlesGroup.children.forEach(child => {
      const handle = child as THREE.Mesh;
      (handle.material as THREE.MeshBasicMaterial).color.set(0x64748b); // Slate Gray
      handle.scale.set(1, 1, 1);
    });
  }

  private createHoverHelper() {
    this.removeHoverHelper();
    if (!this.targetMesh || !this.hoveredElement || this.hoveredElement.index === -1) return;

    const { type, index } = this.hoveredElement;

    // Do not hover if the element is already selected
    if (this.selectedType === type && this.selectedId === index) return;

    if (type === 'VERTEX') {
      // Color the handle orange and scale up to indicate hover
      this.vertexHandlesGroup.children.forEach(child => {
        const handle = child as THREE.Mesh;
        if (handle.userData.uniqueVertexIdx === index) {
          (handle.material as THREE.MeshBasicMaterial).color.set(0xf59e0b); // Orange hover
          handle.scale.set(1.6, 1.6, 1.6);
        }
      });
    } else if (type === 'EDGE') {
      // Draw a thinner, semi-transparent white cylinder for hover preview
      const edge = this.edges[index];
      const p0 = this.uniqueVertices[edge.v0].position;
      const p1 = this.uniqueVertices[edge.v1].position;

      const distance = p0.distanceTo(p1);
      const midpoint = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
      const direction = new THREE.Vector3().subVectors(p1, p0).normalize();
      
      const alignAxis = new THREE.Vector3(0, 1, 0);
      const quaternion = new THREE.Quaternion().setFromUnitVectors(alignAxis, direction);

      const geom = new THREE.CylinderGeometry(0.6, 0.6, distance, 6);
      const hoverMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.4,
        depthTest: false
      });
      const lineMesh = new THREE.Mesh(geom, hoverMat);
      lineMesh.position.copy(midpoint);
      lineMesh.quaternion.copy(quaternion);
      lineMesh.renderOrder = 3;
      
      this.targetMesh.add(lineMesh);
      this.hoverHelper = lineMesh;
    } else if (type === 'FACE') {
      // Draw a softer white overlay for face hover preview
      const face = this.faces[index];
      const geom = new THREE.BufferGeometry();
      
      const vertices: number[] = [];
      const positionAttr = this.targetMesh.geometry.attributes.position;
      const indexAttr = this.targetMesh.geometry.index;

      face.triangles.forEach(triIdx => {
        let idx0 = triIdx * 3;
        let idx1 = triIdx * 3 + 1;
        let idx2 = triIdx * 3 + 2;

        if (indexAttr) {
          idx0 = indexAttr.getX(idx0);
          idx1 = indexAttr.getX(idx1);
          idx2 = indexAttr.getX(idx2);
        }

        const p0 = new THREE.Vector3().fromBufferAttribute(positionAttr, idx0);
        const p1 = new THREE.Vector3().fromBufferAttribute(positionAttr, idx1);
        const p2 = new THREE.Vector3().fromBufferAttribute(positionAttr, idx2);

        vertices.push(p0.x, p0.y, p0.z);
        vertices.push(p1.x, p1.y, p1.z);
        vertices.push(p2.x, p2.y, p2.z);
      });

      geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geom.computeVertexNormals();

      const hoverFaceMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        transparent: true,
        opacity: 0.3
      });
      
      const mesh = new THREE.Mesh(geom, hoverFaceMat);
      mesh.renderOrder = 3;
      this.targetMesh.add(mesh);
      this.hoverHelper = mesh;
    }
  }

  private removeHoverHelper() {
    if (this.hoverHelper) {
      if (this.hoverHelper.parent) {
        this.hoverHelper.parent.remove(this.hoverHelper);
      }
      
      // Dispose geometry and material to prevent WebGL memory leaks
      if ((this.hoverHelper as any).geometry) {
        (this.hoverHelper as any).geometry.dispose();
      }
      if ((this.hoverHelper as any).material) {
        const mat = (this.hoverHelper as any).material;
        if (Array.isArray(mat)) {
          mat.forEach((m: any) => m.dispose());
        } else {
          mat.dispose();
        }
      }
      this.hoverHelper = null;
    }

    // Reset vertex handle colors and scale (except the selected one, which stays cyan and scaled up)
    this.vertexHandlesGroup.children.forEach(child => {
      const handle = child as THREE.Mesh;
      const uIdx = handle.userData.uniqueVertexIdx;
      if (this.selectedType === 'VERTEX' && this.selectedId === uIdx) {
        (handle.material as THREE.MeshBasicMaterial).color.set(0x06b6d4); // Selected Cyan
        handle.scale.set(1.8, 1.8, 1.8);
      } else {
        (handle.material as THREE.MeshBasicMaterial).color.set(0x64748b); // Inactive Slate Gray
        handle.scale.set(1, 1, 1);
      }
    });
  }

  // Cache vertex positions in local coordinates before drag operations
  private cacheInitialVertexPositions() {
    if (!this.targetMesh) return;
    const posAttr = this.targetMesh.geometry.attributes.position;
    if (!posAttr) return;

    this.initialVertexPositions = [];
    for (let i = 0; i < this.uniqueVertices.length; i++) {
      this.initialVertexPositions.push(this.uniqueVertices[i].position.clone());
    }

    this.affectedUniqueVertexIds = this.getSelectedUniqueVertexIds();
  }

  // Main transformation application
  private applyGizmoTransform() {
    if (!this.targetMesh || this.affectedUniqueVertexIds.length === 0) return;

    // 1. Get delta translation, rotation, and scale from dummy object relative to start centroid
    const localCentroid = this.selectionCentroid.clone().applyMatrix4(new THREE.Matrix4().copy(this.targetMesh.matrixWorld).invert());
    
    // Project dummy's current world position/rotation/scale back to local coordinates
    const localDummyPos = this.dummyTransformObject.position.clone().applyMatrix4(new THREE.Matrix4().copy(this.targetMesh.matrixWorld).invert());
    const translation = new THREE.Vector3().subVectors(localDummyPos, localCentroid);
    const rotation = this.dummyTransformObject.quaternion;
    const scale = this.dummyTransformObject.scale;

    // 2. Apply transformations to vertices (Scale relative to centroid, then Rotate, then Translate)
    this.affectedUniqueVertexIds.forEach(id => {
      const initPos = this.initialVertexPositions[id];
      const newPos = initPos.clone()
        .sub(localCentroid)
        .multiply(scale)
        .applyQuaternion(rotation)
        .add(localCentroid)
        .add(translation);

      this.uniqueVertices[id].position.copy(newPos);
    });

    this.updateMeshGeometry();
    this.updateHelpers();
    if (this.onGeometryChanged) this.onGeometryChanged();
  }

  // Mathematical Planarity Enforcer (projects non-coplanar vertices onto face planes)
  private enforcePlanarity() {
    if (!this.targetMesh) return;

    const epsilon = 0.05;
    let iterations = 0;
    let maxIterations = 3; // Iterative projection relaxation loop
    let geometryChanged = false;

    while (iterations < maxIterations) {
      let changedThisIteration = false;

      // Loop through all faces of the mesh
      for (const face of this.faces) {
        // Enforce planarity on faces with 4 or more vertices
        if (face.uniqueVertexIds.length >= 4) {
          
          // 1. Choose three reference anchor vertices of the face
          // Prioritize modified vertices as anchors to make the face plane follow the user's deformation,
          // then fill the remaining anchors with unmodified vertices of the face.
          let anchorIds = face.uniqueVertexIds.filter(id => this.affectedUniqueVertexIds.includes(id));
          
          if (anchorIds.length < 3) {
            const unmodifiedIds = face.uniqueVertexIds.filter(id => !this.affectedUniqueVertexIds.includes(id));
            anchorIds = anchorIds.concat(unmodifiedIds).slice(0, 3);
          } else {
            anchorIds = anchorIds.slice(0, 3);
          }

          if (anchorIds.length < 3) continue; // Face has too few vertices

          const p0 = this.uniqueVertices[anchorIds[0]].position;
          const p1 = this.uniqueVertices[anchorIds[1]].position;
          const p2 = this.uniqueVertices[anchorIds[2]].position;

          // 2. Calculate face normal
          const normal = new THREE.Vector3()
            .crossVectors(
              new THREE.Vector3().subVectors(p1, p0),
              new THREE.Vector3().subVectors(p2, p0)
            )
            .normalize();

          // 3. Project any non-coplanar vertices onto the plane defined by (p0, normal)
          // Plane equation: normal . (pt - p0) = 0
          for (const id of face.uniqueVertexIds) {
            const pt = this.uniqueVertices[id].position;
            const distToPlane = normal.dot(new THREE.Vector3().subVectors(pt, p0));

            if (Math.abs(distToPlane) > epsilon) {
              // Project point orthogonally onto plane
              pt.addScaledVector(normal, -distToPlane);
              changedThisIteration = true;
              geometryChanged = true;
            }
          }
        }
      }

      if (!changedThisIteration) break;
      iterations++;
    }

    if (geometryChanged) {
      this.updateMeshGeometry();
      this.updateHelpers();
      console.log(`Planarity enforced successfully in ${iterations} iterations.`);
      if (this.onGeometryChanged) this.onGeometryChanged();
    }
  }

  // Update underlying WebGL buffer geometry attributes
  private updateMeshGeometry() {
    if (!this.targetMesh) return;
    const geom = this.targetMesh.geometry;
    const posAttr = geom.attributes.position as THREE.BufferAttribute;

    this.uniqueVertices.forEach(uv => {
      uv.indices.forEach(idx => {
        posAttr.setXYZ(idx, uv.position.x, uv.position.y, uv.position.z);
      });
    });

    posAttr.needsUpdate = true;
    geom.computeVertexNormals();
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
  }

  // Update selection helpers and vertex dots placement
  private updateHelpers() {
    if (!this.targetMesh) return;

    // Sync vertex handles positions
    this.vertexHandlesGroup.children.forEach(child => {
      const handle = child as THREE.Mesh;
      const uIdx = handle.userData.uniqueVertexIdx;
      handle.position.copy(this.uniqueVertices[uIdx].position);
    });

    // Sync scale handles positions if in scale mode
    if (this.activeGizmoMode === 'scale' && !this.isDraggingScaleHandle) {
      this.rebuildScaleHandles();
    }

    // Re-highlight helper geometry
    if (this.selectedId !== -1) {
      this.createHighlightHelper();
    }

    // Rebuild wireframe edge lines to match the deformed geometry
    this.cameraController.rebuildEdgesHelper(this.targetMesh);
  }

  private clearScaleHandles() {
    this.scaleHandlesGroup.children.forEach(child => {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach(m => m.dispose());
        } else {
          mesh.material.dispose();
        }
      }
    });
    this.scaleHandlesGroup.clear();
    this.hoveredScaleHandle = null;
    this.activeScaleHandle = null;
  }

  private rebuildScaleHandles() {
    this.clearScaleHandles();
    if (!this.targetMesh || this.selectedId === -1 || this.activeGizmoMode !== 'scale') return;

    this.scaleHandlesGroup.position.copy(this.targetMesh.position);
    this.scaleHandlesGroup.rotation.copy(this.targetMesh.rotation);

    const boxGeom = new THREE.BoxGeometry(3.0, 3.0, 3.0); // Double sized handles
    const handleColor = 0x22c55e; // Green
    
    if (this.selectedType === 'EDGE') {
      const edge = this.edges[this.selectedId];
      const p0 = this.uniqueVertices[edge.v0].position;
      const p1 = this.uniqueVertices[edge.v1].position;

      const handle0 = new THREE.Mesh(boxGeom, new THREE.MeshBasicMaterial({ color: handleColor, depthTest: false }));
      handle0.position.copy(p0);
      handle0.userData = { vertexId: edge.v0, defaultColor: handleColor };
      handle0.renderOrder = 10;
      this.scaleHandlesGroup.add(handle0);

      const handle1 = new THREE.Mesh(boxGeom, new THREE.MeshBasicMaterial({ color: handleColor, depthTest: false }));
      handle1.position.copy(p1);
      handle1.userData = { vertexId: edge.v1, defaultColor: handleColor };
      handle1.renderOrder = 10;
      this.scaleHandlesGroup.add(handle1);

    } else if (this.selectedType === 'FACE') {
      const face = this.faces[this.selectedId];
      const corners = face.uniqueVertexIds.map(id => this.uniqueVertices[id].position.clone());
      const centroid = new THREE.Vector3();
      corners.forEach(p => centroid.add(p));
      centroid.divideScalar(corners.length);

      // Orthonormal basis in plane
      const edgeMid = new THREE.Vector3().addVectors(corners[0], corners[1]).multiplyScalar(0.5);
      const U = new THREE.Vector3().subVectors(edgeMid, centroid).normalize();
      
      const normal = new THREE.Vector3().crossVectors(
        new THREE.Vector3().subVectors(corners[1], corners[0]),
        new THREE.Vector3().subVectors(corners[2], corners[0])
      ).normalize();
      const V = new THREE.Vector3().crossVectors(normal, U).normalize();

      // Corner handles
      corners.forEach((p, idx) => {
        const u = new THREE.Vector3().subVectors(p, centroid).dot(U);
        const v = new THREE.Vector3().subVectors(p, centroid).dot(V);

        const handle = new THREE.Mesh(boxGeom, new THREE.MeshBasicMaterial({ color: handleColor, depthTest: false }));
        handle.position.copy(p);
        handle.userData = { handleType: 'corner', cornerIndex: idx, u, v, defaultColor: handleColor };
        handle.renderOrder = 10;
        this.scaleHandlesGroup.add(handle);
      });

      // Edge midpoint handles (use actual boundary edges instead of iterating corners order)
      const boundaryEdges = this.edges.filter(edge => 
        face.uniqueVertexIds.includes(edge.v0) && face.uniqueVertexIds.includes(edge.v1)
      );

      boundaryEdges.forEach((edge, idx) => {
        const p0 = this.uniqueVertices[edge.v0].position;
        const p1 = this.uniqueVertices[edge.v1].position;
        const mid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);

        const u = new THREE.Vector3().subVectors(mid, centroid).dot(U);
        const v = new THREE.Vector3().subVectors(mid, centroid).dot(V);

        const handle = new THREE.Mesh(boxGeom, new THREE.MeshBasicMaterial({ color: handleColor, depthTest: false }));
        handle.position.copy(mid);
        handle.userData = { 
          handleType: 'edge', 
          edgeIndex: idx, 
          v0: edge.v0, 
          v1: edge.v1, 
          u, 
          v, 
          defaultColor: handleColor 
        };
        handle.renderOrder = 10;
        this.scaleHandlesGroup.add(handle);
      });
    }
  }

  private updateScaleHandlesPositions() {
    if (!this.targetMesh || this.selectedId === -1 || this.activeGizmoMode !== 'scale') return;

    if (this.selectedType === 'EDGE') {
      const edge = this.edges[this.selectedId];
      const p0 = this.uniqueVertices[edge.v0].position;
      const p1 = this.uniqueVertices[edge.v1].position;

      this.scaleHandlesGroup.children.forEach(child => {
        const handle = child as THREE.Mesh;
        if (handle.userData.vertexId === edge.v0) {
          handle.position.copy(p0);
        } else if (handle.userData.vertexId === edge.v1) {
          handle.position.copy(p1);
        }
      });
    } else if (this.selectedType === 'FACE') {
      const face = this.faces[this.selectedId];
      const corners = face.uniqueVertexIds.map(id => this.uniqueVertices[id].position.clone());
      const centroid = new THREE.Vector3();
      corners.forEach(p => centroid.add(p));
      centroid.divideScalar(corners.length);

      this.scaleHandlesGroup.children.forEach(child => {
        const handle = child as THREE.Mesh;
        if (handle.userData.handleType === 'corner') {
          const idx = handle.userData.cornerIndex;
          handle.position.copy(corners[idx]);
        } else if (handle.userData.handleType === 'edge') {
          const v0 = handle.userData.v0;
          const v1 = handle.userData.v1;
          const p0 = this.uniqueVertices[v0].position;
          const p1 = this.uniqueVertices[v1].position;
          const mid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
          handle.position.copy(mid);
        }
      });
    }
  }

  private startScaleDrag(hitHandle: THREE.Mesh) {
    if (!this.targetMesh) return;
    this.isDraggingScaleHandle = true;
    this.orbitControls.enabled = false;
    this.activeScaleHandle = hitHandle;
    (hitHandle.material as THREE.MeshBasicMaterial).color.set(0x14532d); // Dark Forest Green for active drag

    this.cacheInitialVertexPositions();

    if (this.selectedType === 'EDGE') {
      const edge = this.edges[this.selectedId];
      const p0 = this.initialVertexPositions[edge.v0];
      const p1 = this.initialVertexPositions[edge.v1];
      this.initialScaleCentroid.copy(p0).add(p1).multiplyScalar(0.5);
      this.initialScaleDirection.subVectors(p1, p0).normalize();
      this.initialScaleHalfLength = p0.distanceTo(p1) * 0.5;
      this.draggedVertexId = hitHandle.userData.vertexId;
    } else if (this.selectedType === 'FACE') {
      const face = this.faces[this.selectedId];
      const corners = face.uniqueVertexIds.map(id => this.initialVertexPositions[id]);
      this.initialScaleCentroid.set(0, 0, 0);
      corners.forEach(p => this.initialScaleCentroid.add(p));
      this.initialScaleCentroid.divideScalar(corners.length);

      const edgeMid = new THREE.Vector3().addVectors(corners[0], corners[1]).multiplyScalar(0.5);
      this.initialScaleU.subVectors(edgeMid, this.initialScaleCentroid).normalize();
      
      const normal = new THREE.Vector3().crossVectors(
        new THREE.Vector3().subVectors(corners[1], corners[0]),
        new THREE.Vector3().subVectors(corners[2], corners[0])
      ).normalize();
      this.initialScaleV.crossVectors(normal, this.initialScaleU).normalize();

      this.initialHandleU = hitHandle.userData.u;
      this.initialHandleV = hitHandle.userData.v;
      this.faceHandleType = hitHandle.userData.handleType;
      
      this.initialFaceVerticesUV = face.uniqueVertexIds.map(id => {
        const p = this.initialVertexPositions[id];
        return {
          id,
          u: new THREE.Vector3().subVectors(p, this.initialScaleCentroid).dot(this.initialScaleU),
          v: new THREE.Vector3().subVectors(p, this.initialScaleCentroid).dot(this.initialScaleV)
        };
      });
    }

    const onPointerMove = (moveEvent: PointerEvent) => {
      this.handleScaleDrag(moveEvent);
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      this.endScaleDrag();
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  private handleScaleDrag(e: PointerEvent) {
    if (!this.targetMesh || !this.isDraggingScaleHandle || !this.activeScaleHandle) return;

    const activeCamera = this.cameraController.getActiveCamera();
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, activeCamera);

    const worldCentroid = this.initialScaleCentroid.clone().applyMatrix4(this.targetMesh.matrixWorld);

    const cameraDir = new THREE.Vector3();
    activeCamera.getWorldDirection(cameraDir);

    const planeNormal = new THREE.Vector3();
    if (this.selectedType === 'EDGE') {
      const worldDir = this.initialScaleDirection.clone().transformDirection(this.targetMesh.matrixWorld);
      planeNormal.crossVectors(worldDir, cameraDir).cross(worldDir).normalize();
    } else {
      const face = this.faces[this.selectedId];
      const corners = face.uniqueVertexIds.map(id => this.initialVertexPositions[id]);
      const normalLocal = new THREE.Vector3().crossVectors(
        new THREE.Vector3().subVectors(corners[1], corners[0]),
        new THREE.Vector3().subVectors(corners[2], corners[0])
      ).normalize();
      planeNormal.copy(normalLocal).transformDirection(this.targetMesh.matrixWorld);
    }

    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, worldCentroid);
    const intersection = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(plane, intersection);

    if (intersection) {
      const localIntersect = intersection.clone().applyMatrix4(new THREE.Matrix4().copy(this.targetMesh.matrixWorld).invert());

      if (this.selectedType === 'EDGE') {
        const edge = this.edges[this.selectedId];
        const projection = new THREE.Vector3().subVectors(localIntersect, this.initialScaleCentroid).dot(this.initialScaleDirection);
        
        let scaleFactor = 1.0;
        if (this.draggedVertexId === edge.v1) {
          scaleFactor = projection / this.initialScaleHalfLength;
        } else {
          scaleFactor = -projection / this.initialScaleHalfLength;
        }
        
        scaleFactor = Math.max(0.05, scaleFactor);

        this.uniqueVertices[edge.v1].position.copy(this.initialScaleCentroid).addScaledVector(this.initialScaleDirection, this.initialScaleHalfLength * scaleFactor);
        this.uniqueVertices[edge.v0].position.copy(this.initialScaleCentroid).addScaledVector(this.initialScaleDirection, -this.initialScaleHalfLength * scaleFactor);

      } else if (this.selectedType === 'FACE') {
        const newU = new THREE.Vector3().subVectors(localIntersect, this.initialScaleCentroid).dot(this.initialScaleU);
        const newV = new THREE.Vector3().subVectors(localIntersect, this.initialScaleCentroid).dot(this.initialScaleV);

        let scaleU = 1.0;
        let scaleV = 1.0;

        if (this.faceHandleType === 'corner') {
          scaleU = newU / this.initialHandleU;
          scaleV = newV / this.initialHandleV;
        } else {
          if (Math.abs(this.initialHandleU) > Math.abs(this.initialHandleV)) {
            scaleU = newU / this.initialHandleU;
          } else {
            scaleV = newV / this.initialHandleV;
          }
        }

        scaleU = Math.max(0.05, scaleU);
        scaleV = Math.max(0.05, scaleV);

        this.initialFaceVerticesUV.forEach(item => {
          const newPos = this.initialScaleCentroid.clone()
            .addScaledVector(this.initialScaleU, item.u * scaleU)
            .addScaledVector(this.initialScaleV, item.v * scaleV);
          this.uniqueVertices[item.id].position.copy(newPos);
        });
      }

      this.updateMeshGeometry();
      this.updateScaleHandlesPositions();
      this.updateHelpers();
      if (this.onGeometryChanged) this.onGeometryChanged();
    }
  }

  private endScaleDrag() {
    this.isDraggingScaleHandle = false;
    this.orbitControls.enabled = true;
    if (this.activeScaleHandle) {
      (this.activeScaleHandle.material as THREE.MeshBasicMaterial).color.set(this.activeScaleHandle.userData.defaultColor);
      this.activeScaleHandle = null;
    }

    this.enforcePlanarity();
    this.rebuildScaleHandles();
    this.wasDragging = true;
    if (this.onGeometryChanged) this.onGeometryChanged();
  }

  private updateStatusText(text: string) {
    if (this.elToolDisplay) {
      this.elToolDisplay.innerText = text;
    }
  }

  private getScreenScaleFactor(object: THREE.Object3D): number {
    const activeCamera = this.cameraController.getActiveCamera();
    if (!activeCamera) return 1.0;

    const worldPos = new THREE.Vector3();
    object.getWorldPosition(worldPos);

    if (activeCamera instanceof THREE.PerspectiveCamera) {
      const distance = activeCamera.position.distanceTo(worldPos);
      // Calibrate so that at a distance of ~300 units, the scale factor is 1.0 (default size 3.0 looks good).
      return distance / 300.0;
    } else if (activeCamera instanceof THREE.OrthographicCamera) {
      // Orthographic camera size on screen is determined by (top - bottom) / zoom.
      const height = (activeCamera.top - activeCamera.bottom) / activeCamera.zoom;
      return height / 250.0;
    }
    return 1.0;
  }

  // Keep camera controller updated if active camera swaps
  public update() {
    if (this.transformControls && this.transformControls.dragging) {
      const activeCam = this.cameraController.getActiveCamera();
      if (this.transformControls.camera !== activeCam) {
        this.transformControls.camera = activeCam;
      }
    }

    // Scale our custom scale handles based on viewport/camera distance to keep screen size constant
    if (this.activeGizmoMode === 'scale' && this.scaleHandlesGroup.children.length > 0) {
      this.scaleHandlesGroup.children.forEach(child => {
        const handle = child as THREE.Mesh;
        const scaleFactor = this.getScreenScaleFactor(handle);
        
        let stateMultiplier = 1.0;
        if (this.isDraggingScaleHandle && handle === this.activeScaleHandle) {
          stateMultiplier = 1.8;
        } else if (handle === this.hoveredScaleHandle) {
          stateMultiplier = 1.4;
        }
        
        const finalScale = scaleFactor * stateMultiplier;
        handle.scale.set(finalScale, finalScale, finalScale);
      });
    }
  }

  public rebuildMeshHelpers(mesh: THREE.Mesh) {
    if (this.targetMesh === mesh) {
      // Sync vertex handles group position/rotation
      this.vertexHandlesGroup.position.copy(this.targetMesh.position);
      this.vertexHandlesGroup.rotation.copy(this.targetMesh.rotation);
      
      // Sync scale handles position/rotation
      if (this.activeGizmoMode === 'scale') {
        this.rebuildScaleHandles();
      }
      
      // Update transform controls gizmo if active
      if (this.selectedId !== -1) {
        this.calculateSelectionCentroid();
        this.dummyTransformObject.position.copy(this.selectionCentroid);
        this.dummyTransformObject.quaternion.set(0, 0, 0, 1);
        this.dummyTransformObject.scale.set(1, 1, 1);
      }
    }
  }
}
