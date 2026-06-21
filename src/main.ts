import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CameraController } from './cameraController';
import { CADTools } from './cadTools';
import { MeshEditor } from './meshEditor';
import { AssemblyManager } from './assemblyManager';
import { HistoryManager } from './history';

// 1. Get canvas and configure WebGLRenderer
const canvas = document.getElementById('scratchpad-canvas') as HTMLCanvasElement;
if (!canvas) {
  throw new Error("Could not find canvas element with ID 'scratchpad-canvas'");
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;

// 2. Initialize Scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e0e11); // Dark background

// 3. Initialize Cameras
const aspect = window.innerWidth / window.innerHeight;

// Perspective Camera (standard 3D viewing)
const perspCamera = new THREE.PerspectiveCamera(45, aspect, 1, 10000);
perspCamera.position.set(300, 250, 450); // Initial 3D view angle

// Orthographic Camera (standard 2D aligned drafting)
const orthoCamera = new THREE.OrthographicCamera(
  -300 * aspect, 300 * aspect,
  300, -300,
  1, 10000
);
orthoCamera.position.set(0, 250, 0); // Start top-down

// 4. Initialize OrbitControls
// Temporary attach to perspective camera, controller will swap camera objects
const controls = new OrbitControls(perspCamera, canvas);
controls.target.set(0, 0, 0); // Focus at center coordinates

// 5. Initialize Camera Controller & CAD Tools
const cameraController = new CameraController(
  perspCamera,
  orthoCamera,
  controls,
  canvas
);

const cadTools = new CADTools(scene, canvas, cameraController);

const meshEditor = new MeshEditor(scene, cameraController, controls, canvas);
meshEditor.setCADTools(cadTools);

const assemblyManager = new AssemblyManager(meshEditor);
meshEditor.setAssemblyManager(assemblyManager);

const historyManager = new HistoryManager(assemblyManager, meshEditor);
meshEditor.setHistoryManager(historyManager);

assemblyManager.setCameraController(cameraController);
cameraController.setAssemblyManager(assemblyManager);

// Clear snapping tool highlights when switching active tools
cadTools.onToolChanged = (tool) => {
  if (tool !== 'ANCHOR') {
    meshEditor.clearAnchorToolState();
  }
};

// 6. Build Workshop Floor Grid & Helpers
// Major Grid: 1000mm wide, subdivisions every 100mm (cyan highlight)
const majorGrid = new THREE.GridHelper(1200, 12, 0x0891b2, 0x334155);
majorGrid.position.y = -0.1; // Offset slightly downward to prevent z-fighting with minor grid
scene.add(majorGrid);

// Minor Grid: 1200mm wide, subdivisions every 10mm (dark slate)
const minorGrid = new THREE.GridHelper(1200, 120, 0x1e293b, 0x1e293b);
minorGrid.position.y = -0.2;
scene.add(minorGrid);

// Axes Helper: Red = X, Green = Y, Blue = Z (size = 200mm)
const axesHelper = new THREE.AxesHelper(200);
// Style axes helper lines to be thicker
(axesHelper.material as THREE.LineBasicMaterial).linewidth = 2;
axesHelper.renderOrder = 1;
scene.add(axesHelper);

// 7. Add Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.75);
dirLight1.position.set(300, 500, 200);
scene.add(dirLight1);

const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.25);
dirLight2.position.set(-300, 200, -200);
scene.add(dirLight2);

// 8. Add Symmetrical reference foam-board airplane meshes
const testMeshes: THREE.Mesh[] = [];
const foamMaterial = new THREE.MeshStandardMaterial({
  color: 0xf1f5f9, // Slate white foam board look
  roughness: 0.6,
  metalness: 0.05,
  side: THREE.DoubleSide
});

// Fuselage Box (40mm width, 50mm height, 300mm length)
const fuseGeom = new THREE.BoxGeometry(40, 50, 300);
const fuselage = new THREE.Mesh(fuseGeom, foamMaterial);
fuselage.position.set(0, 25, 0); // Sit on grid
scene.add(fuselage);
testMeshes.push(fuselage);

// Wing Flat Board (600mm wingspan, 100mm chord, 5mm thickness)
const wingGeom = new THREE.BoxGeometry(600, 5, 100);
const wing = new THREE.Mesh(wingGeom, foamMaterial);
wing.position.set(0, 52.5, 0); // Sit on top of fuselage
scene.add(wing);
testMeshes.push(wing);

// Vertical Stabilizer / Tail (5mm thickness, 60mm height, 60mm length)
const tailGeom = new THREE.BoxGeometry(5, 60, 60);
const tail = new THREE.Mesh(tailGeom, foamMaterial);
tail.position.set(0, 55, -120); // Sit at the rear of fuselage
scene.add(tail);
testMeshes.push(tail);

// Register meshes with AssemblyManager
assemblyManager.addComponent('fuselage', 'Fuselage', fuselage);
assemblyManager.addComponent('wing', 'Wing', wing);
assemblyManager.addComponent('tail', 'Tail', tail);

// Set default anchors (Wing and Tail are anchored to the Fuselage top face)
const fuselageComp = assemblyManager.getComponent('fuselage')!;
const topFace = fuselageComp.indexedGeometry.faces.find(f => f.normal.y > 0.9);
if (topFace) {
  assemblyManager.setAnchor('wing', 'fuselage', 'FACE', topFace.id);
  assemblyManager.setAnchor('tail', 'fuselage', 'FACE', topFace.id);
} else {
  assemblyManager.setAnchor('wing', 'fuselage', 'FACE', 'face_0');
  assemblyManager.setAnchor('tail', 'fuselage', 'FACE', 'face_0');
}

// Hook active component change to adjust measure/select tool targeting
assemblyManager.onActiveComponentChanged = (id) => {
  if (id) {
    const activeComp = assemblyManager.getComponent(id);
    if (activeComp) {
      cadTools.registerTargetMeshes([activeComp.mesh]);
    }
  } else {
    // Tier 1: All components can be targeted/measured
    cadTools.registerTargetMeshes(testMeshes);
  }
};

// Bind UI dropdown changes to active component
const selectComponent = document.getElementById('select-active-component') as HTMLSelectElement | null;
if (selectComponent) {
  selectComponent.addEventListener('change', (e) => {
    const targetId = (e.target as HTMLSelectElement).value;
    assemblyManager.setActiveComponent(targetId || null);
  });
}

// Bind Exit Component UI button
const exitComponentBtn = document.getElementById('btn-exit-component');
if (exitComponentBtn) {
  exitComponentBtn.addEventListener('click', () => {
    assemblyManager.setActiveComponent(null);
  });
}

// Bind Anchor button action (toggles between Snapping Tool and Break Anchor)
cadTools.onAnchorButtonClicked = () => {
  const transformControls = meshEditor.getTransformControls();
  const attachedMesh = transformControls.object;
  if (attachedMesh && assemblyManager.getActiveComponentId() === null) {
    const comp = assemblyManager.getComponentByMesh(attachedMesh);
    if (comp && comp.anchor) {
      historyManager.pushState();
      assemblyManager.breakAnchor(comp.id);
      return;
    }
  }
  // Fall back to standard anchor snapping tool
  cadTools.setActiveTool('ANCHOR');
};

// Bind Undo / Redo UI buttons
const undoBtn = document.getElementById('btn-undo');
const redoBtn = document.getElementById('btn-redo');
if (undoBtn) {
  undoBtn.addEventListener('click', () => {
    historyManager.undo();
  });
}
if (redoBtn) {
  redoBtn.addEventListener('click', () => {
    historyManager.redo();
  });
}

// Bind keyboard shortcuts for Undo / Redo
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    const key = e.key.toLowerCase();
    if (key === 'z') {
      if (e.shiftKey) {
        historyManager.redo();
      } else {
        historyManager.undo();
      }
      e.preventDefault();
    } else if (key === 'y') {
      historyManager.redo();
      e.preventDefault();
    }
  }
});

// Register meshes for visual shading changes
cameraController.registerTestMeshes(testMeshes);
cadTools.registerTargetMeshes(testMeshes); // In Tier 1, start with all targetable

// Set initial active component in AssemblyManager (Tier 1)
assemblyManager.setActiveComponent(null);

// 9. Handle Resizing
window.addEventListener('resize', () => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const aspect = width / height;

  // Update Perspective Camera
  perspCamera.aspect = aspect;
  perspCamera.updateProjectionMatrix();

  // Update Orthographic Camera
  const distance = perspCamera.position.distanceTo(controls.target);
  const halfHeight = distance * Math.tan((perspCamera.fov * Math.PI) / 360);
  const halfWidth = halfHeight * aspect;
  orthoCamera.left = -halfWidth;
  orthoCamera.right = halfWidth;
  orthoCamera.top = halfHeight;
  orthoCamera.bottom = -halfHeight;
  orthoCamera.updateProjectionMatrix();

  // Update Renderer
  renderer.setSize(width, height);
});

// 10. Animation Render Loop
function animate() {
  requestAnimationFrame(animate);

  // Update controller (physics damping & snapping lerp updates)
  cameraController.update();

  // Update CAD tools (midpoint projection calculations)
  cadTools.update();

  // Update mesh editor gizmos
  meshEditor.update();

  // Update assembly anchors
  assemblyManager.updateAnchors();

  // Render using active camera
  const activeCamera = cameraController.getActiveCamera();
  renderer.render(scene, activeCamera);
}

// Start loop
(window as any).assemblyManager = assemblyManager;
(window as any).meshEditor = meshEditor;
(window as any).THREE = THREE;

animate();
console.log("Foam Plane Builder Phase 1 Canvas Environment initialized successfully.");
