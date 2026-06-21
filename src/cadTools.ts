import * as THREE from 'three';
import { CameraController } from './cameraController';

export type CADToolType = 'SELECT' | 'MEASURE' | 'ANCHOR';

export class CADTools {
  private scene: THREE.Scene;
  private canvas: HTMLCanvasElement;
  private cameraController: CameraController;
  private targetMeshes: THREE.Object3D[] = [];
  private meshEditor: any = null;

  public setMeshEditor(meshEditor: any) {
    this.meshEditor = meshEditor;
  }

  private activeTool: CADToolType = 'SELECT';
  public onToolChanged?: (tool: CADToolType) => void;
  public onAnchorButtonClicked?: () => void;
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  public getActiveTool(): CADToolType {
    return this.activeTool;
  }
  
  // Hover tracker
  private currentCoords = new THREE.Vector3();

  // Tape Measure State
  private measureStartPoint: THREE.Vector3 | null = null;
  private measureEndPoint: THREE.Vector3 | null = null;
  private isMeasuring = false;

  // Visual measurement items in 3D scene
  private measureLine: THREE.Mesh | null = null;
  private startDot: THREE.Mesh | null = null;
  private endDot: THREE.Mesh | null = null;

  // Start edge for perpendicular snapping
  private startEdgeDir: THREE.Vector3 | null = null;
  private perpSnapDot: THREE.Mesh | null = null;
  
  // UI Element for measurement label
  private measurementLabelDiv: HTMLDivElement | null = null;

  // HTML elements caches
  private elX: HTMLElement | null = null;
  private elY: HTMLElement | null = null;
  private elZ: HTMLElement | null = null;
  private elToolDisplay: HTMLElement | null = null;

  constructor(
    scene: THREE.Scene,
    canvas: HTMLCanvasElement,
    cameraController: CameraController
  ) {
    this.scene = scene;
    this.canvas = canvas;
    this.cameraController = cameraController;

    // Cache elements
    this.elX = document.getElementById('coord-x');
    this.elY = document.getElementById('coord-y');
    this.elZ = document.getElementById('coord-z');
    this.elToolDisplay = document.getElementById('tool-display');

    this.setupMouseEvents();
    this.setupUIBindings();
  }

  public registerTargetMeshes(meshes: THREE.Object3D[]) {
    this.targetMeshes = meshes;
  }

  private setupMouseEvents() {
    // Track mouse position on canvas
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      this.updateCoordinates();
      this.updateMeasurementLive();
    });

    // Left click handling
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // Only trigger for Left Click

      if (this.activeTool === 'MEASURE') {
        this.handleMeasureClick();
      }
    });

    // Double-click cancels/clears measurement
    this.canvas.addEventListener('dblclick', () => {
      if (this.activeTool === 'MEASURE') {
        this.clearMeasurement();
      }
    });
  }

  private setupUIBindings() {
    const btnSelect = document.getElementById('btn-tool-select');
    const btnMeasure = document.getElementById('btn-tool-measure');
    const btnAnchor = document.getElementById('btn-tool-anchor');

    if (btnSelect) {
      btnSelect.addEventListener('click', () => this.setActiveTool('SELECT'));
    }
    if (btnMeasure) {
      btnMeasure.addEventListener('click', () => this.setActiveTool('MEASURE'));
    }
    if (btnAnchor) {
      btnAnchor.addEventListener('click', () => {
        if (this.onAnchorButtonClicked) {
          this.onAnchorButtonClicked();
        } else {
          this.setActiveTool('ANCHOR');
        }
      });
    }
  }

  public setActiveTool(tool: CADToolType) {
    this.activeTool = tool;

    // Toggle button styles
    const btnSelect = document.getElementById('btn-tool-select');
    const btnMeasure = document.getElementById('btn-tool-measure');
    const btnAnchor = document.getElementById('btn-tool-anchor');

    if (btnSelect) {
      if (tool === 'SELECT') btnSelect.classList.add('active');
      else btnSelect.classList.remove('active');
    }
    if (btnMeasure) {
      if (tool === 'MEASURE') btnMeasure.classList.add('active');
      else btnMeasure.classList.remove('active');
    }
    if (btnAnchor) {
      if (tool === 'ANCHOR') btnAnchor.classList.add('active');
      else btnAnchor.classList.remove('active');
    }

    // Update footer info
    if (this.elToolDisplay) {
      if (tool === 'SELECT') {
        this.elToolDisplay.innerText = 'Select Mode Active';
      } else if (tool === 'MEASURE') {
        this.elToolDisplay.innerText = 'Tape Measure: Click first point';
      } else if (tool === 'ANCHOR') {
        this.elToolDisplay.innerText = 'Anchor Tool: Click child feature (vertex/edge/face) to snap';
      }
    }

    // Clear any active measurements if switching out of measure tool
    if (tool !== 'MEASURE') {
      this.clearMeasurement();
    }

    // Trigger onToolChanged callback
    if (this.onToolChanged) {
      this.onToolChanged(tool);
    }
  }

  // Raycasts mouse position onto ground plane or meshes
  private getRaycastIntersection(): THREE.Vector3 {
    const camera = this.cameraController.getActiveCamera();
    this.raycaster.setFromCamera(this.mouse, camera);

    // 1. Raycast against meshes first
    const intersects = this.raycaster.intersectObjects(this.targetMeshes, true);
    if (intersects.length > 0) {
      return intersects[0].point;
    }

    // 2. Fall back to ground plane (Y = 0)
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const targetPoint = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(groundPlane, targetPoint);
    return targetPoint;
  }

  private getSnappedIntersectionPoint(rawIntersectionPoint: THREE.Vector3): THREE.Vector3 {
    if (this.meshEditor) {
      const snapped = this.meshEditor.getHoveredElementWorldPosition(rawIntersectionPoint);
      
      // Handle perpendicular snapping between parallel edges
      if (this.isMeasuring && this.startEdgeDir && snapped) {
        const edge = this.meshEditor.getHoveredEdgeVertices();
        if (edge) {
          const hoverDir = new THREE.Vector3().subVectors(edge.p1, edge.p0).normalize();
          const dot = hoverDir.dot(this.startEdgeDir);
          if (Math.abs(dot) > 0.999) {
            // Parallel edges detected!
            const len = new THREE.Vector3().subVectors(edge.p1, edge.p0).length();
            const t = new THREE.Vector3().subVectors(this.measureStartPoint!, edge.p0).dot(this.startEdgeDir) / dot;
            if (t >= 0 && t <= len) {
              const perpPoint = edge.p0.clone().add(hoverDir.multiplyScalar(t));
              
              // Only snap if the angle of deviation from perpendicular is less than 15 degrees
              const vPerp = new THREE.Vector3().subVectors(perpPoint, this.measureStartPoint!);
              const vRaw = new THREE.Vector3().subVectors(snapped, this.measureStartPoint!);
              
              let shouldSnap = true;
              if (vPerp.lengthSq() > 0.001 && vRaw.lengthSq() > 0.001) {
                const cosAngle = vPerp.normalize().dot(vRaw.normalize());
                const angleRad = Math.acos(Math.max(-1, Math.min(1, cosAngle)));
                const angleDeg = angleRad * (180 / Math.PI);
                if (angleDeg > 15) {
                  shouldSnap = false;
                }
              }
              
              if (shouldSnap) {
                this.createPerpSnapDot(perpPoint);
                return perpPoint;
              }
            }
          }
        }
      }
      
      this.removePerpSnapDot();
      if (snapped) {
        return snapped;
      }
    }
    return rawIntersectionPoint;
  }

  // Updates X, Y, Z readout
  private updateCoordinates() {
    const rawPt = this.getRaycastIntersection();
    const pt = this.getSnappedIntersectionPoint(rawPt);
    this.currentCoords.copy(pt);

    if (this.elX) this.elX.innerText = pt.x.toFixed(2);
    if (this.elY) this.elY.innerText = pt.y.toFixed(2);
    if (this.elZ) this.elZ.innerText = pt.z.toFixed(2);
  }

  // Measurement logic click handler
  private handleMeasureClick() {
    const rawPt = this.getRaycastIntersection();
    const pt = this.getSnappedIntersectionPoint(rawPt);

    if (!this.isMeasuring) {
      // Clear previous measurement visual helpers
      this.clearMeasurement();

      // First Click: Lock Start Point
      this.measureStartPoint = pt.clone();
      this.isMeasuring = true;

      // Check if start point is on an edge to enable perpendicular edge snapping
      if (this.meshEditor) {
        const edge = this.meshEditor.getHoveredEdgeVertices();
        if (edge) {
          this.startEdgeDir = new THREE.Vector3().subVectors(edge.p1, edge.p0).normalize();
        }
      }

      // Spawn start indicator dot
      this.createStartDot(this.measureStartPoint);

      if (this.elToolDisplay) {
        this.elToolDisplay.innerText = 'Tape Measure: Click end point (Double click to reset)';
      }
    } else {
      // Second Click: Lock End Point
      this.measureEndPoint = pt.clone();
      this.isMeasuring = false;

      // Lock measurement visualizer
      this.createEndDot(this.measureEndPoint);
      this.drawMeasurementLine(this.measureStartPoint!, this.measureEndPoint);
      this.createMeasurementLabel(this.measureStartPoint!, this.measureEndPoint);

      // Clear the temporary perpendicular snap dot as we have finished the measurement
      this.removePerpSnapDot();

      if (this.elToolDisplay) {
        this.elToolDisplay.innerText = `Distance: ${this.measureStartPoint!.distanceTo(this.measureEndPoint).toFixed(1)} mm. Click to measure again.`;
      }
    }
  }

  private updateMeasurementLive() {
    if (!this.isMeasuring || !this.measureStartPoint) return;

    // If currently drafting, draw a live dotted line to the current hover point
    const rawPt = this.getRaycastIntersection();
    const currentPt = this.getSnappedIntersectionPoint(rawPt);
    this.drawMeasurementLine(this.measureStartPoint, currentPt);
    this.createMeasurementLabel(this.measureStartPoint, currentPt);
  }

  // Clear measurement and helper nodes
  public clearMeasurement() {
    this.isMeasuring = false;
    this.measureStartPoint = null;
    this.measureEndPoint = null;
    this.startEdgeDir = null;
    this.removePerpSnapDot();

    if (this.measureLine) {
      this.scene.remove(this.measureLine);
      this.measureLine.geometry.dispose();
      if (this.measureLine.material) {
        if (Array.isArray(this.measureLine.material)) {
          this.measureLine.material.forEach(m => m.dispose());
        } else {
          this.measureLine.material.dispose();
        }
      }
      this.measureLine = null;
    }
    if (this.startDot) {
      this.scene.remove(this.startDot);
      this.startDot.geometry.dispose();
      if (this.startDot.material) {
        if (Array.isArray(this.startDot.material)) {
          this.startDot.material.forEach(m => m.dispose());
        } else {
          this.startDot.material.dispose();
        }
      }
      this.startDot = null;
    }
    if (this.endDot) {
      this.scene.remove(this.endDot);
      this.endDot.geometry.dispose();
      if (this.endDot.material) {
        if (Array.isArray(this.endDot.material)) {
          this.endDot.material.forEach(m => m.dispose());
        } else {
          this.endDot.material.dispose();
        }
      }
      this.endDot = null;
    }
    if (this.measurementLabelDiv) {
      if (this.measurementLabelDiv.parentNode) {
        this.measurementLabelDiv.parentNode.removeChild(this.measurementLabelDiv);
      }
      this.measurementLabelDiv = null;
    }

    if (this.activeTool === 'MEASURE' && this.elToolDisplay) {
      this.elToolDisplay.innerText = 'Tape Measure: Click first point';
    }
  }

  // 3D rendering builders
  private createStartDot(point: THREE.Vector3) {
    if (this.startDot) {
      this.scene.remove(this.startDot);
      this.startDot.geometry.dispose();
      if (this.startDot.material) {
        if (Array.isArray(this.startDot.material)) {
          this.startDot.material.forEach(m => m.dispose());
        } else {
          this.startDot.material.dispose();
        }
      }
    }

    const geom = new THREE.SphereGeometry(3, 16, 16);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xfbbf24, // Amber yellow
      depthTest: false,
      transparent: true,
      opacity: 0.9
    });
    this.startDot = new THREE.Mesh(geom, mat);
    this.startDot.position.copy(point);
    this.startDot.renderOrder = 999;
    this.scene.add(this.startDot);
  }

  private createEndDot(point: THREE.Vector3) {
    if (this.endDot) {
      this.scene.remove(this.endDot);
      this.endDot.geometry.dispose();
      if (this.endDot.material) {
        if (Array.isArray(this.endDot.material)) {
          this.endDot.material.forEach(m => m.dispose());
        } else {
          this.endDot.material.dispose();
        }
      }
    }

    const geom = new THREE.SphereGeometry(3, 16, 16);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xfbbf24,
      depthTest: false,
      transparent: true,
      opacity: 0.9
    });
    this.endDot = new THREE.Mesh(geom, mat);
    this.endDot.position.copy(point);
    this.endDot.renderOrder = 999;
    this.scene.add(this.endDot);
  }

  private drawMeasurementLine(start: THREE.Vector3, end: THREE.Vector3) {
    if (this.measureLine) {
      this.scene.remove(this.measureLine);
      this.measureLine.geometry.dispose();
      if (this.measureLine.material) {
        if (Array.isArray(this.measureLine.material)) {
          this.measureLine.material.forEach(m => m.dispose());
        } else {
          this.measureLine.material.dispose();
        }
      }
      this.measureLine = null;
    }

    const distance = start.distanceTo(end);
    if (distance < 0.1) return;

    // Use a cylinder mesh (radius ~1.5mm / thickness ~3mm)
    const radius = 1.5;
    const geom = new THREE.CylinderGeometry(radius, radius, distance, 8);
    // Cylinder geometry is created vertically centered at origin, orient it to align with points
    geom.translate(0, distance / 2, 0);
    geom.rotateX(Math.PI / 2);

    const mat = new THREE.MeshBasicMaterial({
      color: 0xfbbf24, // Amber yellow
      depthTest: false, // Ensure line is visible on top of other meshes
      transparent: true,
      opacity: 0.8
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(start);
    mesh.lookAt(end);
    mesh.renderOrder = 999;

    this.measureLine = mesh;
    this.scene.add(this.measureLine);
  }

  private createPerpSnapDot(point: THREE.Vector3) {
    if (this.perpSnapDot) {
      this.scene.remove(this.perpSnapDot);
      this.perpSnapDot.geometry.dispose();
      if (this.perpSnapDot.material) {
        if (Array.isArray(this.perpSnapDot.material)) {
          this.perpSnapDot.material.forEach(m => m.dispose());
        } else {
          this.perpSnapDot.material.dispose();
        }
      }
    }

    const geom = new THREE.SphereGeometry(3, 16, 16);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x10b981, // Emerald green for perpendicular snap!
      depthTest: false,
      transparent: true,
      opacity: 0.9
    });
    this.perpSnapDot = new THREE.Mesh(geom, mat);
    this.perpSnapDot.position.copy(point);
    this.perpSnapDot.renderOrder = 1000;
    this.scene.add(this.perpSnapDot);
  }

  private removePerpSnapDot() {
    if (this.perpSnapDot) {
      this.scene.remove(this.perpSnapDot);
      this.perpSnapDot.geometry.dispose();
      if (this.perpSnapDot.material) {
        if (Array.isArray(this.perpSnapDot.material)) {
          this.perpSnapDot.material.forEach(m => m.dispose());
        } else {
          this.perpSnapDot.material.dispose();
        }
      }
      this.perpSnapDot = null;
    }
  }

  private createMeasurementLabel(start: THREE.Vector3, end: THREE.Vector3) {
    // Create label div if it doesn't exist
    if (!this.measurementLabelDiv) {
      this.measurementLabelDiv = document.createElement('div');
      this.measurementLabelDiv.className = 'measure-billboard';
      document.body.appendChild(this.measurementLabelDiv);
    }

    const distance = start.distanceTo(end);
    this.measurementLabelDiv.innerText = `${distance.toFixed(1)} mm`;

    // Midpoint calculations
    const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    this.updateLabelPosition(midpoint);
  }

  private updateLabelPosition(midpoint: THREE.Vector3) {
    if (!this.measurementLabelDiv) return;

    const camera = this.cameraController.getActiveCamera();
    
    // Project 3D coordinates to 2D Screen NDC space (-1 to 1)
    const tempV = midpoint.clone();
    tempV.project(camera);

    // Check if point is behind camera
    if (tempV.z > 1) {
      this.measurementLabelDiv.style.display = 'none';
      return;
    }

    this.measurementLabelDiv.style.display = 'block';

    // Map NDC space to client width and height pixels
    const x = (tempV.x * 0.5 + 0.5) * window.innerWidth;
    const y = (tempV.y * -0.5 + 0.5) * window.innerHeight;

    this.measurementLabelDiv.style.left = `${x}px`;
    this.measurementLabelDiv.style.top = `${y}px`;
  }

  // Updates floating labels position every frame
  public update() {
    if (this.measurementLabelDiv && this.measureStartPoint) {
      const end = this.measureEndPoint || this.currentCoords;
      const midpoint = new THREE.Vector3().addVectors(this.measureStartPoint, end).multiplyScalar(0.5);
      this.updateLabelPosition(midpoint);
    }
  }
}
