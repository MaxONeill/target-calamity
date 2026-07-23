import * as THREE from 'three';
import type { PinLayer } from '../globe/PinLayer.js';
import type { GlobalRing } from '../globe/GlobalRing.js';

/** Movement in CSS px below which a pointer down→up counts as a click, not a drag. */
const CLICK_SLOP_PX = 5;

export interface PickingOptions {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  pins: PinLayer;
  ring: GlobalRing;
  globeRadius: number;
  onPick: (id: string) => void;
  /** Picking rebinds the pin material, so the scene must repaint afterwards. */
  requestRender: () => void;
}

/**
 * Wires click-to-select on the canvas.
 *
 * A click first tries the pin geometry. If it misses, it raycasts the globe
 * sphere and falls back to the pin whose painted halo covers that surface point,
 * so clicking a factor's visible glow selects it even when the marker itself is
 * small on screen.
 *
 * @returns a teardown function removing both listeners.
 */
export function attachPicking(options: PickingOptions): () => void {
  const { canvas, renderer, camera, pins, ring, globeRadius, onPick, requestRender } = options;

  const raycaster = new THREE.Raycaster();
  const globeSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), globeRadius);
  const surfaceHit = new THREE.Vector3();
  const ndc = new THREE.Vector2();

  let downX = 0;
  let downY = 0;
  let downValid = false;

  const onPointerDown = (event: PointerEvent): void => {
    downValid = event.button === 0;
    if (!downValid) return;
    downX = event.clientX;
    downY = event.clientY;
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!downValid || event.button !== 0) return;
    downValid = false;

    if (Math.hypot(event.clientX - downX, event.clientY - downY) > CLICK_SLOP_PX) return;

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    let id = pins.pick(renderer, camera, x, y);

    if (id === null) {
      ndc.set((x / rect.width) * 2 - 1, -((y / rect.height) * 2 - 1));
      raycaster.setFromCamera(ndc, camera);

      // The ring sits outside the globe, so it is tested first: a click landing
      // on an arc is unambiguous, where a halo hit is a fallback guess.
      id = ring.pick(raycaster);

      if (id === null && raycaster.ray.intersectSphere(globeSphere, surfaceHit)) {
        id = pins.pickHalo(surfaceHit.normalize());
      }
    }

    requestRender();
    if (id !== null) onPick(id);
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointerup', onPointerUp);
  };
}
