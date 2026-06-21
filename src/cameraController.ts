import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ViewMode = 'FREE' | 'TOP' | 'SIDE' | 'FRONT';
export type ShadingMode = 'SOLID' | 'WIREFRAME' | 'XRAY';
export type ProjectionMode = 'PERSPECTIVE' | 'ORTHOGRAPHIC';

export class CameraController {
  private perspCamera: THREE.PerspectiveCamera;
  private orthoCamera: THREE.OrthographicCamera;
  private controls: OrbitControls;
  private canvas: HTMLCanvasElement;

  private currentViewMode: ViewMode = 'FREE';
  private currentProjMode: ProjectionMode = 'PERSPECTIVE';
  private currentShadingMode: ShadingMode = 'SOLID';

  // Animation variables
  private isAnimating = false;
  private animStartTime = 0;
  private animDuration = 400; // ms
  private animStartPosition = new THREE.Vector3();
  private animEndPosition = new THREE.Vector3();
  private animStartTarget = new THREE.Vector3();
  private animEndTarget = new THREE.Vector3();
  private animStartUp = new THREE.Vector3();
  private animEndUp = new THREE.Vector3();
  private snapDirection = new THREE.Vector3();

  // Reference meshes for shading tests
  private testMeshes: THREE.Mesh[] = [];

  constructor(
    perspCamera: THREE.PerspectiveCamera,
    orthoCamera: THREE.OrthographicCamera,
    controls: OrbitControls,
    canvas: HTMLCanvasElement
  ) {
    this.perspCamera = perspCamera;
    this.orthoCamera = orthoCamera;
    this.controls = controls;
    this.canvas = canvas;

    this.setupMouseControls();
    this.setupKeyboardShortcuts();
    this.setupUIBindings();
  }

  // Returns the active camera
  public getActiveCamera(): THREE.Camera {
    return this.currentProjMode === 'PERSPECTIVE' ? this.perspCamera : this.orthoCamera;
  }

  // Register meshes to apply shading modes to
  public registerTestMeshes(meshes: THREE.Mesh[]) {
    this.testMeshes = meshes;
    this.applyShadingMode(this.currentShadingMode);
  }

  // Intercepts middle mouse click and binds OrbitControls
  private setupMouseControls() {
    // 1. Prevent browser middle click auto-scroll circle
    const preventMiddleScroll = (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
      }
    };
    this.canvas.addEventListener('mousedown', preventMiddleScroll);
    this.canvas.addEventListener('pointerdown', preventMiddleScroll);

    // 2. Configure OrbitControls CAD bindings
    // MMB + drag -> Rotate
    // Shift + MMB + drag -> Pan (OrbitControls handles Shift + Rotate keybinds internally)
    // RMB + drag -> Pan
    this.controls.mouseButtons = {
      LEFT: null as any, // Free up left click for CAD tools selection
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN
    };

    // Responsive feel settings
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.minDistance = 20;   // Prevent zooming past origin into negative space
    this.controls.maxDistance = 5000; // Constrain field of view zoomout

    // 3. Listen to camera rotation changes to release snaps
    this.controls.addEventListener('change', () => {
      if (!this.isAnimating && this.currentViewMode !== 'FREE') {
        const currentDir = new THREE.Vector3();
        const activeCamera = this.getActiveCamera();
        activeCamera.getWorldDirection(currentDir);
        const angleDev = currentDir.angleTo(this.snapDirection);
        // If direction angle deviates by more than 0.005 radians (~0.3 degrees), exit snap mode
        if (angleDev > 0.005) {
          this.setViewMode('FREE');
        }
      }
    });
  }

  // Keyboard Shortcuts: Blender Standards
  private setupKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      // Ignore keys if user is typing in input fields (if we add inputs later)
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') {
        return;
      }

      switch (e.key) {
        case '1': // Front View
          e.preventDefault();
          this.setViewMode('FRONT');
          break;
        case '3': // Side View
          e.preventDefault();
          this.setViewMode('SIDE');
          break;
        case '7': // Top View
          e.preventDefault();
          this.setViewMode('TOP');
          break;
        case '5': // Toggle Projection (Persp / Ortho)
          e.preventDefault();
          this.toggleProjection();
          break;
        case 'Escape': // Reset View / Exit Snapping
          e.preventDefault();
          this.setViewMode('FREE');
          break;
      }
    });
  }

  // Connect UI buttons to camera actions
  private setupUIBindings() {
    const bindBtn = (id: string, callback: () => void) => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', callback);
    };

    bindBtn('btn-view-free', () => this.setViewMode('FREE'));
    bindBtn('btn-view-top', () => this.setViewMode('TOP'));
    bindBtn('btn-view-side', () => this.setViewMode('SIDE'));
    bindBtn('btn-view-front', () => this.setViewMode('FRONT'));
    bindBtn('btn-proj-toggle', () => this.toggleProjection());

    bindBtn('btn-shade-solid', () => this.setShadingMode('SOLID'));
    bindBtn('btn-shade-wire', () => this.setShadingMode('WIREFRAME'));
    bindBtn('btn-shade-xray', () => this.setShadingMode('XRAY'));
  }

  // Sets orthographic snap views or free orbit
  public setViewMode(mode: ViewMode) {
    if (this.currentViewMode === mode && mode !== 'FREE') return;
    this.currentViewMode = mode;

    // Highlight active view button
    const buttons = ['btn-view-free', 'btn-view-top', 'btn-view-side', 'btn-view-front'];
    buttons.forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.classList.remove('active');
    });

    const activeId = `btn-view-${mode.toLowerCase()}`;
    const activeBtn = document.getElementById(activeId);
    if (activeBtn) activeBtn.classList.add('active');

    const activeCamera = this.getActiveCamera();
    const distance = activeCamera.position.distanceTo(this.controls.target);
    const target = this.controls.target.clone();

    let destPos = new THREE.Vector3();
    let destUp = new THREE.Vector3(0, 1, 0);

    switch (mode) {
      case 'TOP':
        destPos.set(target.x, target.y + distance, target.z);
        destUp.set(0, 0, -1); // Top view: North is UP (Z-axis negative)
        break;
      case 'SIDE':
        destPos.set(target.x + distance, target.y, target.z);
        destUp.set(0, 1, 0);
        break;
      case 'FRONT':
        destPos.set(target.x, target.y, target.z + distance);
        destUp.set(0, 1, 0);
        break;
      case 'FREE':
      default:
        // Reset camera's up vector to standard Y-up (0, 1, 0)
        // so OrbitControls' rotation axes are properly aligned
        const activeCam = this.getActiveCamera();
        activeCam.up.set(0, 1, 0);
        this.controls.update();
        return;
    }

    // Record the target direction for snap release checks
    this.snapDirection.copy(target).sub(destPos).normalize();

    this.startCameraAnimation(destPos, target, destUp);
  }

  // Toggles camera projection perspective vs orthographic
  public toggleProjection() {
    const nextProj = this.currentProjMode === 'PERSPECTIVE' ? 'ORTHOGRAPHIC' : 'PERSPECTIVE';
    this.currentProjMode = nextProj;

    const projText = document.getElementById('proj-text');
    const projBtn = document.getElementById('btn-proj-toggle');
    
    if (projText) {
      projText.innerText = nextProj === 'PERSPECTIVE' ? 'Persp' : 'Ortho';
    }
    if (projBtn) {
      if (nextProj === 'ORTHOGRAPHIC') {
        projBtn.classList.add('active');
      } else {
        projBtn.classList.remove('active');
      }
    }

    const aspect = window.innerWidth / window.innerHeight;

    if (nextProj === 'ORTHOGRAPHIC') {
      // Sync Orthographic Camera with Perspective Camera
      const distance = this.perspCamera.position.distanceTo(this.controls.target);
      const halfHeight = distance * Math.tan((this.perspCamera.fov * Math.PI) / 360);
      const halfWidth = halfHeight * aspect;

      this.orthoCamera.left = -halfWidth;
      this.orthoCamera.right = halfWidth;
      this.orthoCamera.top = halfHeight;
      this.orthoCamera.bottom = -halfHeight;
      this.orthoCamera.position.copy(this.perspCamera.position);
      this.orthoCamera.up.copy(this.perspCamera.up);
      this.orthoCamera.lookAt(this.controls.target);
      this.orthoCamera.updateProjectionMatrix();

      this.controls.object = this.orthoCamera;
    } else {
      // Sync Perspective Camera with Orthographic Camera
      this.perspCamera.position.copy(this.orthoCamera.position);
      this.perspCamera.up.copy(this.orthoCamera.up);
      this.perspCamera.lookAt(this.controls.target);
      this.perspCamera.updateProjectionMatrix();

      this.controls.object = this.perspCamera;
    }

    this.controls.update();
  }

  // Animation starter
  private startCameraAnimation(destPos: THREE.Vector3, destTarget: THREE.Vector3, destUp: THREE.Vector3) {
    const camera = this.getActiveCamera();
    this.animStartPosition.copy(camera.position);
    this.animEndPosition.copy(destPos);
    this.animStartTarget.copy(this.controls.target);
    this.animEndTarget.copy(destTarget);
    this.animStartUp.copy(camera.up);
    this.animEndUp.copy(destUp);

    this.isAnimating = true;
    this.animStartTime = performance.now();
  }

  // Render loop update
  public update() {
    this.controls.update();

    if (this.isAnimating) {
      const now = performance.now();
      const elapsed = now - this.animStartTime;
      const progress = Math.min(elapsed / this.animDuration, 1.0);

      // Cosine Easing (Smooth start and end)
      const ease = (1 - Math.cos(progress * Math.PI)) / 2;

      const camera = this.getActiveCamera();
      
      // Interpolate position, target, and up vector
      camera.position.lerpVectors(this.animStartPosition, this.animEndPosition, ease);
      this.controls.target.lerpVectors(this.animStartTarget, this.animEndTarget, ease);
      camera.up.lerpVectors(this.animStartUp, this.animEndUp, ease);

      if (this.currentProjMode === 'ORTHOGRAPHIC') {
        this.orthoCamera.updateProjectionMatrix();
      } else {
        this.perspCamera.updateProjectionMatrix();
      }

      if (progress >= 1.0) {
        this.isAnimating = false;
      }
    }
  }

  // Shading mode modifier
  public setShadingMode(mode: ShadingMode) {
    this.currentShadingMode = mode;

    const modes: ShadingMode[] = ['SOLID', 'WIREFRAME', 'XRAY'];
    modes.forEach(m => {
      const btn = document.getElementById(`btn-shade-${m.toLowerCase()}`);
      if (btn) btn.classList.remove('active');
    });

    const activeBtn = document.getElementById(`btn-shade-${mode.toLowerCase()}`);
    if (activeBtn) activeBtn.classList.add('active');

    this.applyShadingMode(mode);
  }

  public rebuildEdgesHelper(mesh: THREE.Mesh) {
    let helper = mesh.getObjectByName('edgesHelper') as THREE.LineSegments | undefined;
    if (helper) {
      mesh.remove(helper);
      helper.geometry.dispose();
      if (Array.isArray(helper.material)) {
        helper.material.forEach(m => m.dispose());
      } else {
        helper.material.dispose();
      }
    }
    
    if (this.currentShadingMode === 'WIREFRAME' || this.currentShadingMode === 'XRAY') {
      const edgesGeom = new THREE.EdgesGeometry(mesh.geometry);
      const color = this.currentShadingMode === 'WIREFRAME' ? 0xf8fafc : 0x64748b;
      const edgesMat = new THREE.LineBasicMaterial({ color: color, linewidth: 1.5 });
      const newHelper = new THREE.LineSegments(edgesGeom, edgesMat);
      newHelper.name = 'edgesHelper';
      mesh.add(newHelper);
    }
  }

  private applyShadingMode(mode: ShadingMode) {
    this.testMeshes.forEach(mesh => {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach(mat => {
        if (mat instanceof THREE.MeshStandardMaterial || mat instanceof THREE.MeshBasicMaterial) {
          switch (mode) {
            case 'WIREFRAME':
              mat.visible = false;
              mat.wireframe = false;
              break;
            case 'XRAY':
              mat.visible = true;
              mat.wireframe = false;
              mat.transparent = true;
              mat.opacity = 0.4;
              break;
            case 'SOLID':
            default:
              mat.visible = true;
              mat.wireframe = false;
              mat.transparent = false;
              mat.opacity = 1.0;
              break;
          }
          mat.needsUpdate = true;
        }
      });

      this.rebuildEdgesHelper(mesh);
    });
  }
}
