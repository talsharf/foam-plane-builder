import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { CameraController } from './cameraController';

export type SelectionFilter = 'VERTEX' | 'EDGE' | 'FACE';
export type GizmoMode = 'translate' | 'rotate';

interface UniqueVertex {
  position: THREE.Vector3;
  indices: number[]; // All duplicate vertex indices in the buffer attribute (for normal splitting)
}

interface Edge {
  id: string;
  v0: number; // Unique vertex index
  v1: number; // Unique vertex index
}

interface Face {
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
  private activeFilter: SelectionFilter = 'VERTEX';
  private activeGizmoMode: GizmoMode = 'translate';

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
  private highlightHelper: THREE.Object3D | null = null;
  private transformControls!: TransformControls;
  private dummyTransformObject = new THREE.Object3D();
  private elToolDisplay: HTMLElement | null = null;

  // Drag states
  private isDragging = false;
  private wasDragging = false;
  private initialVertexPositions: THREE.Vector3[] = []; // Cached positions before drag start
  private affectedUniqueVertexIds: number[] = [];       // Unique vertex IDs modified by active transform

  // Raycasting
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

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
    this.scene.add(this.dummyTransformObject);

    this.elToolDisplay = document.getElementById('tool-display');

    this.setupTransformControls();
    this.setupMouseEvents();
    this.setupUIBindings();
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
    this.vertexHandlesGroup.clear();
    this.transformControls.detach();
  }

  private rebuildEditMode() {
    this.disableEditMode();
    if (!this.targetMesh) return;

    this.indexGeometry();
    this.createVertexHandles();
  }

  // Analysis of buffer geometry: merges split vertices, builds edges and faces
  private indexGeometry() {
    if (!this.targetMesh) return;
    const geom = this.targetMesh.geometry;
    const posAttr = geom.attributes.position;
    if (!posAttr) return;

    this.uniqueVertices = [];
    this.edges = [];
    this.faces = [];

    const epsilon = 0.01;

    // 1. Extract Unique Vertices by position merging
    const tempV = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      tempV.fromBufferAttribute(posAttr, i);
      
      // Look for match
      let found = -1;
      for (let j = 0; j < this.uniqueVertices.length; j++) {
        if (this.uniqueVertices[j].position.distanceTo(tempV) < epsilon) {
          found = j;
          break;
        }
      }

      if (found !== -1) {
        this.uniqueVertices[found].indices.push(i);
      } else {
        this.uniqueVertices.push({
          position: tempV.clone(),
          indices: [i]
        });
      }
    }

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
      const u0 = this.getUniqueVertexIndex(idx0);
      const u1 = this.getUniqueVertexIndex(idx1);
      const u2 = this.getUniqueVertexIndex(idx2);

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
      const p0 = this.uniqueVertices[u0].position;
      const p1 = this.uniqueVertices[u1].position;
      const p2 = this.uniqueVertices[u2].position;

      const norm = new THREE.Vector3()
        .crossVectors(
          new THREE.Vector3().subVectors(p1, p0),
          new THREE.Vector3().subVectors(p2, p0)
        )
        .normalize();
      triNormals.push(norm);
    }

    this.edges = Array.from(edgeMap.values());

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
        const uCurr = this.getTriangleUniqueVertexIds(curr, indices);

        // Scan all other unvisited triangles
        for (let other = 0; other < triangleCount; other++) {
          if (visitedTriangles.has(other)) continue;

          // Normal comparison (coplanar check)
          const angle = faceNormal.angleTo(triNormals[other]);
          if (angle < 0.05) { // ~3 degrees tolerance
            const uOther = this.getTriangleUniqueVertexIds(other, indices);
            
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
        const ids = this.getTriangleUniqueVertexIds(triIdx, indices);
        ids.forEach(id => faceVertexIdsSet.add(id));
      });

      this.faces.push({
        id: `face_${this.faces.length}`,
        uniqueVertexIds: Array.from(faceVertexIdsSet),
        triangles: currentFaceTriangles,
        normal: faceNormal
      });
    }

    // 4. Filter out diagonal/internal edges of coplanar faces so they are not selectable
    const indicesAttr = geom.index;
    const filteredEdges: Edge[] = [];

    this.edges.forEach(edge => {
      // Find all triangles that contain this edge
      const sharingTriangles: number[] = [];
      for (let t = 0; t < triangleCount; t++) {
        const uIds = this.getTriangleUniqueVertexIds(t, indicesAttr);
        if (uIds.includes(edge.v0) && uIds.includes(edge.v1)) {
          sharingTriangles.push(t);
        }
      }

      // Find the face index for each sharing triangle
      const sharingFaceIndices = sharingTriangles.map(triIdx => {
        return this.faces.findIndex(f => f.triangles.includes(triIdx));
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

    this.edges = filteredEdges;
  }

  private getUniqueVertexIndex(bufferIdx: number): number {
    for (let i = 0; i < this.uniqueVertices.length; i++) {
      if (this.uniqueVertices[i].indices.includes(bufferIdx)) {
        return i;
      }
    }
    return 0;
  }

  private getTriangleUniqueVertexIds(triIdx: number, indices: THREE.BufferAttribute | null): number[] {
    let idx0 = triIdx * 3;
    let idx1 = triIdx * 3 + 1;
    let idx2 = triIdx * 3 + 2;

    if (indices) {
      idx0 = indices.getX(idx0);
      idx1 = indices.getX(idx1);
      idx2 = indices.getX(idx2);
    }

    return [
      this.getUniqueVertexIndex(idx0),
      this.getUniqueVertexIndex(idx1),
      this.getUniqueVertexIndex(idx2)
    ];
  }

  // Create yellow selection dots at unique vertices in Edit Mode
  private createVertexHandles() {
    this.vertexHandlesGroup.clear();
    if (!this.targetMesh || this.activeFilter !== 'VERTEX') return;

    const dotGeom = new THREE.SphereGeometry(2.5, 12, 12);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24 }); // Amber

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
    // Left click raycasts selection in Edit Mode
    this.canvas.addEventListener('click', (e) => {
      if (this.wasDragging) {
        this.wasDragging = false;
        return;
      }

      if (e.button !== 0 || !this.isEditMode || !this.targetMesh || this.isDragging) return;

      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      this.raycastSelection();
    });
  }

  private setupUIBindings() {
    const bindBtn = (id: string, callback: () => void) => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', callback);
    };

    bindBtn('btn-filter-vertex', () => this.setSelectionFilter('VERTEX'));
    bindBtn('btn-filter-edge', () => this.setSelectionFilter('EDGE'));
    bindBtn('btn-filter-face', () => this.setSelectionFilter('FACE'));

    bindBtn('btn-gizmo-translate', () => this.setGizmoMode('translate'));
    bindBtn('btn-gizmo-rotate', () => this.setGizmoMode('rotate'));
  }

  private setSelectionFilter(filter: SelectionFilter) {
    if (this.activeFilter === filter) return;
    this.activeFilter = filter;

    const filters: SelectionFilter[] = ['VERTEX', 'EDGE', 'FACE'];
    filters.forEach(f => {
      const btn = document.getElementById(`btn-filter-${f.toLowerCase()}`);
      if (btn) btn.classList.remove('active');
    });

    const activeBtn = document.getElementById(`btn-filter-${filter.toLowerCase()}`);
    if (activeBtn) activeBtn.classList.add('active');

    this.clearSelection();
    this.createVertexHandles();

    this.updateStatusText(`Selection Filter: ${filter}. Click to select.`);
  }

  private setGizmoMode(mode: GizmoMode) {
    if (this.activeGizmoMode === mode) return;
    this.activeGizmoMode = mode;

    const modes: GizmoMode[] = ['translate', 'rotate'];
    modes.forEach(m => {
      const btn = document.getElementById(`btn-gizmo-${m}`);
      if (btn) btn.classList.remove('active');
    });

    const activeBtn = document.getElementById(`btn-gizmo-${mode}`);
    if (activeBtn) activeBtn.classList.add('active');

    this.transformControls.setMode(mode);
  }

  // Selection raycasting engine
  private raycastSelection() {
    const activeCamera = this.cameraController.getActiveCamera();
    this.raycaster.setFromCamera(this.mouse, activeCamera);

    // Apply parent mesh transformations to Raycaster to operate in local coordinates
    const invMatrix = new THREE.Matrix4().copy(this.targetMesh!.matrixWorld).invert();

    if (this.activeFilter === 'VERTEX') {
      // 1. Raycast against vertex handle dots
      const intersects = this.raycaster.intersectObjects(this.vertexHandlesGroup.children);
      if (intersects.length > 0) {
        const selectedHandle = intersects[0].object as THREE.Mesh;
        const uIdx = selectedHandle.userData.uniqueVertexIdx;
        this.selectElement('VERTEX', uIdx);
        return;
      }
    } else if (this.activeFilter === 'FACE' || this.activeFilter === 'EDGE') {
      // 2. Raycast against the main mesh faces
      const intersects = this.raycaster.intersectObject(this.targetMesh!);
      if (intersects.length > 0) {
        const intersection = intersects[0];
        const faceIdx = intersection.faceIndex;
        if (faceIdx === undefined) return;

        // Find which aggregated coplanar face this triangle index belongs to
        const mappedFaceIdx = this.faces.findIndex(f => f.triangles.includes(faceIdx));
        if (mappedFaceIdx === -1) return;

        if (this.activeFilter === 'FACE') {
          this.selectElement('FACE', mappedFaceIdx);
        } else {
          // EDGE Mode: find closest edge of the clicked triangle
          const uIds = this.getTriangleUniqueVertexIds(faceIdx, this.targetMesh!.geometry.index);
          const hitPt = intersection.point.clone().applyMatrix4(invMatrix); // Local hit point

          let minD = Infinity;
          let closestEdgeIdx = -1;

          this.edges.forEach((edge, eIdx) => {
            // Check if this edge belongs to the clicked triangle
            const hasV0 = uIds.includes(edge.v0);
            const hasV1 = uIds.includes(edge.v1);
            if (hasV0 && hasV1) {
              const p0 = this.uniqueVertices[edge.v0].position;
              const p1 = this.uniqueVertices[edge.v1].position;
              
              // Calculate distance from hit point to line segment
              const line = new THREE.Line3(p0, p1);
              const closestPt = new THREE.Vector3();
              line.closestPointToPoint(hitPt, true, closestPt);
              const dist = hitPt.distanceTo(closestPt);

              if (dist < minD) {
                minD = dist;
                closestEdgeIdx = eIdx;
              }
            }
          });

          if (closestEdgeIdx !== -1) {
            this.selectElement('EDGE', closestEdgeIdx);
          }
        }
        return;
      }
    }

    // Clicked empty space: clear
    this.clearSelection();
  }

  private selectElement(type: SelectionFilter, index: number) {
    this.clearSelection();
    this.selectedType = type;
    this.selectedId = index;

    // Handle vertex rotation restriction (disable rotate button, switch mode if active)
    const rotateBtn = document.getElementById('btn-gizmo-rotate') as HTMLButtonElement | null;
    if (rotateBtn) {
      if (type === 'VERTEX') {
        rotateBtn.disabled = true;
        if (this.activeGizmoMode === 'rotate') {
          this.setGizmoMode('translate');
        }
      } else {
        rotateBtn.disabled = false;
      }
    }

    this.calculateSelectionCentroid();
    this.createHighlightHelper();

    // Position dummy object at selection centroid and attach TransformControls
    this.dummyTransformObject.position.copy(this.selectionCentroid);
    this.dummyTransformObject.quaternion.set(0, 0, 0, 1);
    
    // Sync transform mode
    this.transformControls.setMode(this.activeGizmoMode);
    this.transformControls.attach(this.dummyTransformObject);

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
    this.removeHighlightHelper();

    const rotateBtn = document.getElementById('btn-gizmo-rotate') as HTMLButtonElement | null;
    if (rotateBtn) {
      rotateBtn.disabled = false;
    }
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
      // Highlight dot handle
      this.vertexHandlesGroup.children.forEach(child => {
        const handle = child as THREE.Mesh;
        if (handle.userData.uniqueVertexIdx === this.selectedId) {
          (handle.material as THREE.MeshBasicMaterial).color.set(0x06b6d4); // Light Cyan
        }
      });
    } else if (this.selectedType === 'EDGE') {
      // Draw bold white 3D cylinder along edge to guarantee thickness across WebGL platforms
      const edge = this.edges[this.selectedId];
      const p0 = this.uniqueVertices[edge.v0].position;
      const p1 = this.uniqueVertices[edge.v1].position;

      const distance = p0.distanceTo(p1);
      const midpoint = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
      const direction = new THREE.Vector3().subVectors(p1, p0).normalize();
      
      const alignAxis = new THREE.Vector3(0, 1, 0);
      const quaternion = new THREE.Quaternion().setFromUnitVectors(alignAxis, direction);

      const geom = new THREE.CylinderGeometry(1.2, 1.2, distance, 6);
      const boldWhiteMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        depthTest: false
      });
      const lineMesh = new THREE.Mesh(geom, boldWhiteMat);
      lineMesh.position.copy(midpoint);
      lineMesh.quaternion.copy(quaternion);
      lineMesh.renderOrder = 2;
      this.targetMesh.add(lineMesh);
      this.highlightHelper = lineMesh;
    } else if (this.selectedType === 'FACE') {
      // Draw face in white overlay
      const face = this.faces[this.selectedId];
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
        color: 0xffffff,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        transparent: true,
        opacity: 0.8
      });
      
      const mesh = new THREE.Mesh(geom, faceMat);
      mesh.renderOrder = 2;
      this.targetMesh.add(mesh);
      this.highlightHelper = mesh;
    }
  }

  private removeHighlightHelper() {
    if (this.highlightHelper) {
      if (this.highlightHelper.parent) {
        this.highlightHelper.parent.remove(this.highlightHelper);
      }
      
      // Dispose geometry and material to prevent WebGL memory leaks
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
      
      this.highlightHelper = null;
    }

    // Reset vertex handle colors
    this.vertexHandlesGroup.children.forEach(child => {
      const handle = child as THREE.Mesh;
      (handle.material as THREE.MeshBasicMaterial).color.set(0xfbbf24);
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

    // 1. Get delta translation and rotation from dummy object relative to start centroid
    const localCentroid = this.selectionCentroid.clone().applyMatrix4(new THREE.Matrix4().copy(this.targetMesh.matrixWorld).invert());
    
    // Project dummy's current world position/rotation back to local coordinates
    const localDummyPos = this.dummyTransformObject.position.clone().applyMatrix4(new THREE.Matrix4().copy(this.targetMesh.matrixWorld).invert());
    const translation = new THREE.Vector3().subVectors(localDummyPos, localCentroid);
    const rotation = this.dummyTransformObject.quaternion;

    // 2. Apply transformations to vertices
    this.affectedUniqueVertexIds.forEach(id => {
      const initPos = this.initialVertexPositions[id];
      const newPos = initPos.clone()
        .sub(localCentroid)
        .applyQuaternion(rotation)
        .add(localCentroid)
        .add(translation);

      this.uniqueVertices[id].position.copy(newPos);
    });

    this.updateMeshGeometry();
    this.updateHelpers();
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
          // To make it stable, we try to select vertices that were NOT modified by the current drag
          let anchorIds = face.uniqueVertexIds.filter(id => !this.affectedUniqueVertexIds.includes(id));
          
          // If all or too many vertices were modified, just take the first three vertices
          if (anchorIds.length < 3) {
            anchorIds = face.uniqueVertexIds.slice(0, 3);
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

    // Re-highlight helper geometry
    if (this.selectedId !== -1) {
      this.createHighlightHelper();
    }

    // Rebuild wireframe edge lines to match the deformed geometry
    this.cameraController.rebuildEdgesHelper(this.targetMesh);
  }

  private updateStatusText(text: string) {
    if (this.elToolDisplay) {
      this.elToolDisplay.innerText = text;
    }
  }

  // Keep camera controller updated if active camera swaps
  public update() {
    if (this.transformControls && this.transformControls.dragging) {
      const activeCam = this.cameraController.getActiveCamera();
      if (this.transformControls.camera !== activeCam) {
        this.transformControls.camera = activeCam;
      }
    }
  }
}
