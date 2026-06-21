import * as THREE from 'three';
import { AssemblyManager } from './assemblyManager';
import { MeshEditor, SelectionFilter } from './meshEditor';

export interface ComponentStateSnapshot {
  componentId: string;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
  anchor: {
    parentId: string;
    parentFeatureType: 'FACE' | 'VERTEX' | 'EDGE';
    parentFeatureId: string | number;
    localMatrix: THREE.Matrix4;
  } | null;
  geometryPositions: Float32Array;
  geometryIndices: Uint16Array | Uint32Array | null;
}

export interface AssemblyStateSnapshot {
  components: ComponentStateSnapshot[];
  activeComponentId: string | null;
  selectedType: SelectionFilter | null;
  selectedId: number;
}

export class HistoryManager {
  private undoStack: AssemblyStateSnapshot[] = [];
  private redoStack: AssemblyStateSnapshot[] = [];
  private assemblyManager: AssemblyManager;
  private meshEditor: MeshEditor;
  private maxStates = 50;

  constructor(assemblyManager: AssemblyManager, meshEditor: MeshEditor) {
    this.assemblyManager = assemblyManager;
    this.meshEditor = meshEditor;
  }

  // Create a snapshot of the current state
  private captureSnapshot(): AssemblyStateSnapshot {
    const componentSnapshots: ComponentStateSnapshot[] = [];
    
    this.assemblyManager.getComponentsList().forEach((comp) => {
      const mesh = comp.mesh;
      const geom = mesh.geometry;
      
      const posAttr = geom.attributes.position as THREE.BufferAttribute;
      const indexAttr = geom.index;

      componentSnapshots.push({
        componentId: comp.id,
        position: new THREE.Vector3().copy(mesh.position),
        quaternion: new THREE.Quaternion().copy(mesh.quaternion),
        scale: new THREE.Vector3().copy(mesh.scale),
        anchor: comp.anchor ? {
          parentId: comp.anchor.parentId,
          parentFeatureType: comp.anchor.parentFeatureType,
          parentFeatureId: comp.anchor.parentFeatureId,
          localMatrix: new THREE.Matrix4().copy(comp.anchor.localMatrix)
        } : null,
        geometryPositions: new Float32Array(posAttr.array as any),
        geometryIndices: indexAttr ? new (indexAttr.array.constructor as any)(indexAttr.array) : null
      });
    });

    return {
      components: componentSnapshots,
      activeComponentId: this.assemblyManager.getActiveComponentId(),
      selectedType: this.meshEditor.getSelectedType(),
      selectedId: this.meshEditor.getSelectedId()
    };
  }

  // Push current state to undo stack before modifications
  public pushState() {
    const snapshot = this.captureSnapshot();
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.maxStates) {
      this.undoStack.shift();
    }
    // Clear redo stack on new action
    this.redoStack = [];
    this.updateButtons();
  }

  // Undo the last action
  public undo() {
    if (this.undoStack.length === 0) return;

    // Save current state to redo stack
    const currentState = this.captureSnapshot();
    this.redoStack.push(currentState);

    const previousState = this.undoStack.pop()!;
    this.restoreSnapshot(previousState);
    this.updateButtons();
  }

  // Redo the last undone action
  public redo() {
    if (this.redoStack.length === 0) return;

    // Save current state to undo stack
    const currentState = this.captureSnapshot();
    this.undoStack.push(currentState);

    const nextState = this.redoStack.pop()!;
    this.restoreSnapshot(nextState);
    this.updateButtons();
  }

  private restoreSnapshot(snapshot: AssemblyStateSnapshot) {
    // 1. Restore each component's geometry, transform, and anchor
    snapshot.components.forEach((compState) => {
      const comp = this.assemblyManager.getComponent(compState.componentId);
      if (!comp) return;

      const mesh = comp.mesh;
      const geom = mesh.geometry;

      // Restore position, quaternion, scale
      mesh.position.copy(compState.position);
      mesh.quaternion.copy(compState.quaternion);
      mesh.scale.copy(compState.scale);
      mesh.updateMatrixWorld(true);

      // Restore anchor
      comp.anchor = compState.anchor ? {
        parentId: compState.anchor.parentId,
        parentFeatureType: compState.anchor.parentFeatureType,
        parentFeatureId: compState.anchor.parentFeatureId,
        localMatrix: new THREE.Matrix4().copy(compState.anchor.localMatrix)
      } : null;

      // Restore geometry buffer arrays
      const posAttr = geom.attributes.position as THREE.BufferAttribute;
      
      // If the buffer size changed (due to future subdivision/extrusion), assign new BufferAttribute
      if (posAttr.array.length !== compState.geometryPositions.length) {
        geom.setAttribute('position', new THREE.BufferAttribute(compState.geometryPositions.slice(), 3));
      } else {
        (posAttr.array as any).set(compState.geometryPositions);
        posAttr.needsUpdate = true;
      }

      if (compState.geometryIndices) {
        if (!geom.index || geom.index.array.length !== compState.geometryIndices.length) {
          geom.setIndex(new THREE.BufferAttribute(compState.geometryIndices.slice(), 1));
        } else {
          (geom.index.array as any).set(compState.geometryIndices);
          geom.index.needsUpdate = true;
        }
      } else {
        geom.setIndex(null);
      }

      geom.computeVertexNormals();
      geom.computeBoundingBox();
      geom.computeBoundingSphere();

      // Re-index geometry in the cache
      comp.indexedGeometry = MeshEditor.indexMeshGeometry(mesh);
    });

    // 2. Restore active component workspace
    const oldActiveId = this.assemblyManager.getActiveComponentId();
    this.assemblyManager.setActiveComponent(snapshot.activeComponentId);

    // If active component didn't change but geometry did, we must rebuild the editor target mesh handles manually
    if (snapshot.activeComponentId !== null && snapshot.activeComponentId === oldActiveId) {
      this.meshEditor.rebuildEditMode();
    }

    // 3. Restore selection state in MeshEditor
    if (snapshot.selectedType !== null) {
      this.meshEditor.selectElement(snapshot.selectedType, snapshot.selectedId);
    } else {
      this.meshEditor.clearSelection();
    }

    // 4. Force visuals update and anchor propagation refresh
    this.assemblyManager.updateComponentMaterials();
    this.assemblyManager.updateAnchors();
  }

  private updateButtons() {
    const btnUndo = document.getElementById('btn-undo') as HTMLButtonElement | null;
    const btnRedo = document.getElementById('btn-redo') as HTMLButtonElement | null;

    if (btnUndo) btnUndo.disabled = this.undoStack.length === 0;
    if (btnRedo) btnRedo.disabled = this.redoStack.length === 0;
  }
}
