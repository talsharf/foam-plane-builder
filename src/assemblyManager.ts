import * as THREE from 'three';
import { MeshEditor, UniqueVertex, Edge, Face } from './meshEditor';

export interface AnchorDefinition {
  parentId: string;
  parentFeatureType: 'FACE' | 'VERTEX' | 'EDGE';
  parentFeatureId: string | number;
  localMatrix: THREE.Matrix4; // Stores relative transform of the child in the parent feature's world basis
}

export interface CADComponent {
  id: string;
  name: string;
  mesh: THREE.Mesh;
  anchor: AnchorDefinition | null;
  indexedGeometry: {
    uniqueVertices: UniqueVertex[];
    edges: Edge[];
    faces: Face[];
  };
}

export class AssemblyManager {
  private components = new Map<string, CADComponent>();
  private meshEditor: MeshEditor;
  private activeComponentId: string | null = null;
  private cameraController: any = null;

  public onActiveComponentChanged?: (id: string | null) => void;

  constructor(meshEditor: MeshEditor) {
    this.meshEditor = meshEditor;

    // Register callback on meshEditor
    this.meshEditor.onGeometryChanged = () => {
      // If we are in Tier 1 (no active target mesh in editor) and dragging a component,
      // update its relative anchor localMatrix based on the new dragged position.
      const targetMesh = this.meshEditor.getTargetMesh();
      const transformControls = this.meshEditor.getTransformControls();
      if (!targetMesh && transformControls && transformControls.object) {
        const attachedMesh = transformControls.object as THREE.Mesh;
        const draggedComp = this.getComponentByMesh(attachedMesh);
        if (draggedComp && draggedComp.anchor) {
          const parent = this.components.get(draggedComp.anchor.parentId);
          if (parent) {
            const parentFeatureBasis = this.getFeatureBasis(parent, draggedComp.anchor.parentFeatureType, draggedComp.anchor.parentFeatureId);
            attachedMesh.updateMatrixWorld(true);
            const childWorldMatrix = attachedMesh.matrixWorld.clone();
            const invParentBasis = new THREE.Matrix4().copy(parentFeatureBasis).invert();
            draggedComp.anchor.localMatrix.multiplyMatrices(invParentBasis, childWorldMatrix);
          }
        }
      }

      this.updateAnchors();
    };
  }

  public setCameraController(cameraController: any) {
    this.cameraController = cameraController;
  }

  public addComponent(id: string, name: string, mesh: THREE.Mesh) {
    // Clone material so each component mesh has its own unique instance
    if (mesh.material) {
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map(m => m.clone());
      } else {
        mesh.material = mesh.material.clone();
      }
    }

    // 1. Run geometry indexing for caching
    const indexedGeometry = MeshEditor.indexMeshGeometry(mesh);

    const component: CADComponent = {
      id,
      name,
      mesh,
      anchor: null,
      indexedGeometry
    };

    this.components.set(id, component);
    if (!this.activeComponentId) {
      this.activeComponentId = id;
    }
  }

  public getComponent(id: string): CADComponent | null {
    return this.components.get(id) || null;
  }

  public getComponentByMesh(mesh: THREE.Mesh): CADComponent | null {
    for (const comp of this.components.values()) {
      if (comp.mesh === mesh) return comp;
    }
    return null;
  }

  public setAnchor(
    childId: string,
    parentId: string,
    featureType: 'FACE' | 'VERTEX' | 'EDGE',
    featureId: string | number
  ) {
    const child = this.components.get(childId);
    const parent = this.components.get(parentId);
    if (!child || !parent) {
      console.error(`Component not found for setAnchor: child=${childId}, parent=${parentId}`);
      return;
    }

    // 1. Get the world basis of the parent feature
    const parentFeatureBasis = this.getFeatureBasis(parent, featureType, featureId);

    // 2. Compute the child's local transform relative to this parent feature basis:
    // childWorldMatrix = parentFeatureBasis * localMatrix
    // => localMatrix = inverse(parentFeatureBasis) * childWorldMatrix
    child.mesh.updateMatrixWorld(true);
    const childWorldMatrix = child.mesh.matrixWorld.clone();
    
    const invParentBasis = new THREE.Matrix4().copy(parentFeatureBasis).invert();
    const localMatrix = new THREE.Matrix4().multiplyMatrices(invParentBasis, childWorldMatrix);

    // 3. Save the anchor definition
    child.anchor = {
      parentId,
      parentFeatureType: featureType,
      parentFeatureId: featureId,
      localMatrix
    };
  }

  public getFeatureBasis(
    component: CADComponent,
    featureType: 'FACE' | 'VERTEX' | 'EDGE',
    featureId: string | number
  ): THREE.Matrix4 {
    const basis = new THREE.Matrix4();
    const mesh = component.mesh;
    const geom = component.indexedGeometry;

    if (featureType === 'FACE') {
      const face = geom.faces.find(f => f.id === featureId);
      if (!face) {
        console.warn(`Face ${featureId} not found on component ${component.id}`);
        return mesh.matrixWorld.clone();
      }

      // Compute local centroid
      const centroidLocal = new THREE.Vector3();
      face.uniqueVertexIds.forEach(vid => {
        centroidLocal.add(geom.uniqueVertices[vid].position);
      });
      centroidLocal.divideScalar(face.uniqueVertexIds.length);

      // Compute local normal and tangent axes
      const p0 = geom.uniqueVertices[face.uniqueVertexIds[0]].position;
      const p1 = geom.uniqueVertices[face.uniqueVertexIds[1]].position;

      const normalLocal = face.normal.clone().normalize();
      const tangentLocal = new THREE.Vector3().subVectors(p1, p0).normalize();
      const bitangentLocal = new THREE.Vector3().crossVectors(normalLocal, tangentLocal).normalize();

      // Create local basis matrix (orthonormal translation/rotation)
      const localBasis = new THREE.Matrix4().makeBasis(tangentLocal, bitangentLocal, normalLocal);
      localBasis.setPosition(centroidLocal);

      // World basis matrix
      mesh.updateMatrixWorld(true);
      basis.multiplyMatrices(mesh.matrixWorld, localBasis);

    } else if (featureType === 'VERTEX') {
      const vid = Number(featureId);
      if (vid < 0 || vid >= geom.uniqueVertices.length) {
        console.warn(`Vertex ${featureId} out of bounds on component ${component.id}`);
        return mesh.matrixWorld.clone();
      }

      const posLocal = geom.uniqueVertices[vid].position;
      const localBasis = new THREE.Matrix4().setPosition(posLocal);

      mesh.updateMatrixWorld(true);
      basis.multiplyMatrices(mesh.matrixWorld, localBasis);

    } else if (featureType === 'EDGE') {
      const edge = geom.edges.find(e => e.id === featureId);
      if (!edge) {
        console.warn(`Edge ${featureId} not found on component ${component.id}`);
        return mesh.matrixWorld.clone();
      }

      const p0 = geom.uniqueVertices[edge.v0].position;
      const p1 = geom.uniqueVertices[edge.v1].position;
      const midpointLocal = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
      const dirLocal = new THREE.Vector3().subVectors(p1, p0).normalize();

      // Establish local basis frame for the edge
      const up = new THREE.Vector3(0, 1, 0);
      if (Math.abs(dirLocal.dot(up)) > 0.99) {
        up.set(0, 0, 1);
      }
      const normalLocal = new THREE.Vector3().crossVectors(dirLocal, up).normalize();
      const bitangentLocal = new THREE.Vector3().crossVectors(normalLocal, dirLocal).normalize();

      const localBasis = new THREE.Matrix4().makeBasis(dirLocal, bitangentLocal, normalLocal);
      localBasis.setPosition(midpointLocal);

      mesh.updateMatrixWorld(true);
      basis.multiplyMatrices(mesh.matrixWorld, localBasis);
    }

    return basis;
  }

  public updateAnchors() {
    const updated = new Set<string>();

    const updateComponent = (comp: CADComponent) => {
      if (updated.has(comp.id)) return;

      if (comp.anchor) {
        const parent = this.components.get(comp.anchor.parentId);
        if (parent) {
          updateComponent(parent);

          // Get parent feature's world basis matrix
          const parentFeatureBasis = this.getFeatureBasis(parent, comp.anchor.parentFeatureType, comp.anchor.parentFeatureId);

          // childWorldMatrix = parentFeatureBasis * localMatrix
          const childWorldMatrix = new THREE.Matrix4().multiplyMatrices(parentFeatureBasis, comp.anchor.localMatrix);

          // Decompose childWorldMatrix and apply to child mesh properties
          const pos = new THREE.Vector3();
          const quat = new THREE.Quaternion();
          const scale = new THREE.Vector3();
          childWorldMatrix.decompose(pos, quat, scale);

          comp.mesh.position.copy(pos);
          comp.mesh.quaternion.copy(quat);
          comp.mesh.scale.copy(scale);
          comp.mesh.updateMatrixWorld(true);
          
          // Rebuild wireframe visual helper for child mesh
          this.meshEditor.rebuildMeshHelpers(comp.mesh);
        }
      }

      updated.add(comp.id);
    };

    this.components.forEach(comp => {
      updateComponent(comp);
    });
  }

  public setActiveComponent(id: string | null) {
    this.activeComponentId = id;

    // Sync HTML Select value
    const selectEl = document.getElementById('select-active-component') as HTMLSelectElement | null;
    if (selectEl) {
      selectEl.value = id || '';
    }

    // Toggle Exit button in HUD
    const exitBtn = document.getElementById('btn-exit-component');
    if (exitBtn) {
      exitBtn.style.display = id ? 'flex' : 'none';
    }

    // Update editor target mesh
    if (id) {
      const comp = this.components.get(id);
      if (comp) {
        this.meshEditor.setTargetMesh(comp.mesh);
      }
    } else {
      this.meshEditor.setTargetMesh(null);
    }

    // Trigger material update (opaque vs ghosted)
    this.updateComponentMaterials();

    // Trigger active component changed callback
    if (this.onActiveComponentChanged) {
      this.onActiveComponentChanged(id);
    }
  }

  public getActiveComponentId(): string | null {
    return this.activeComponentId;
  }

  public breakAnchor(componentId: string) {
    const comp = this.components.get(componentId);
    if (comp) {
      comp.anchor = null;
      this.updateComponentMaterials();
    }
  }

  public updateComponentMaterials() {
    const shadingMode = this.cameraController ? this.cameraController.getCurrentShadingMode() : 'SOLID';
    const transformControls = this.meshEditor ? this.meshEditor.getTransformControls() : null;

    this.components.forEach(comp => {
      const mesh = comp.mesh;
      const isInterfaceActive = this.activeComponentId === null || comp.id === this.activeComponentId;
      const isSelected = (this.activeComponentId === comp.id) ||
                         (this.activeComponentId === null && transformControls && transformControls.object === mesh);

      // Handle standard material properties
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach(mat => {
        if (mat instanceof THREE.MeshStandardMaterial || mat instanceof THREE.MeshBasicMaterial) {
          if (isSelected) {
            mat.color.setHex(0xffffff); // Pure white highlighting
            if (mat instanceof THREE.MeshStandardMaterial) {
              mat.emissive.setHex(0x333333); // Subtle glow
            }
          } else {
            mat.color.setHex(0xf1f5f9); // Default foam board slate-white
            if (mat instanceof THREE.MeshStandardMaterial) {
              mat.emissive.setHex(0x000000);
            }
          }

          if (isInterfaceActive) {
            if (shadingMode === 'WIREFRAME') {
              mat.visible = false;
            } else if (shadingMode === 'XRAY') {
              mat.visible = true;
              mat.transparent = true;
              mat.opacity = 0.4;
              mat.depthWrite = true;
            } else { // SOLID
              mat.visible = true;
              mat.transparent = false;
              mat.opacity = 1.0;
              mat.depthWrite = true;
            }
          } else { // Ghosted Component
            if (shadingMode === 'WIREFRAME') {
              mat.visible = false;
            } else {
              mat.visible = true;
              mat.transparent = true;
              mat.opacity = 0.25;
              mat.depthWrite = false;
            }
          }
          mat.needsUpdate = true;
        }
      });

      // Update edgesHelper (wireframe outline helper) if it exists
      const edgesHelper = mesh.getObjectByName('edgesHelper') as THREE.LineSegments | undefined;
      if (edgesHelper) {
        const edgeMat = edgesHelper.material as THREE.LineBasicMaterial;
        if (isInterfaceActive) {
          edgeMat.transparent = false;
          edgeMat.opacity = 1.0;
          if (isSelected) {
            edgeMat.color.setHex(0xffffff); // Pure white edges for selected component
          } else {
            edgeMat.color.setHex(shadingMode === 'WIREFRAME' ? 0xf8fafc : 0x64748b);
          }
        } else {
          edgeMat.transparent = true;
          edgeMat.opacity = 0.25;
          edgeMat.color.setHex(0x334155); // Darker ghosted color
        }
        edgeMat.needsUpdate = true;
      }
    });

    // Toggle Break Anchor button visibility in HUD
    const breakAnchorBtn = document.getElementById('btn-break-anchor');
    if (breakAnchorBtn) {
      let isAnchoredSelected = false;
      const selectedMesh = transformControls ? transformControls.object : null;
      if (selectedMesh && this.activeComponentId === null) {
        const comp = this.getComponentByMesh(selectedMesh as THREE.Mesh);
        if (comp && comp.anchor) {
          isAnchoredSelected = true;
        }
      }
      breakAnchorBtn.style.display = isAnchoredSelected ? 'flex' : 'none';
    }
  }
}
