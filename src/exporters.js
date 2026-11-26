import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';

/** Saves a Blob (or ArrayBuffer / string) as a file. */
export function downloadBlob(data, filename, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * A detached copy of what is on screen now: the cloth (and optionally the obstacle), in metres,
 * with the floor at y = 0. The procedural ripple texture is left out (it would only bloat files).
 */
function snapshot(clothMesh, obstacleGroup, includeObstacle, floorY) {
  const g = new THREE.Group();
  const geo = clothMesh.geometry.clone();
  geo.computeVertexNormals();
  const mat = clothMesh.material.clone();
  mat.bumpMap = null;
  const cloth = new THREE.Mesh(geo, mat);
  cloth.name = 'tela';
  g.add(cloth);
  if (includeObstacle && obstacleGroup && obstacleGroup.visible) {
    const o = obstacleGroup.clone(true);
    o.name = 'obstaculo';
    g.add(o);
  }
  g.position.y = -floorY;
  g.updateMatrixWorld(true);
  return g;
}

export function exportGLB(clothMesh, obstacleGroup, includeObstacle, floorY) {
  const g = snapshot(clothMesh, obstacleGroup, includeObstacle, floorY);
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(g, resolve, reject, { binary: true });
  });
}

export function exportOBJ(clothMesh, obstacleGroup, includeObstacle, floorY) {
  const g = snapshot(clothMesh, obstacleGroup, includeObstacle, floorY);
  return new OBJExporter().parse(g);
}

/** Records the 3D canvas to a WebM video. */
export function createRecorder(canvas, { onStop }) {
  let rec = null;
  let chunks = [];
  let started = 0;
  return {
    get active() {
      return !!rec;
    },
    get seconds() {
      return rec ? (performance.now() - started) / 1000 : 0;
    },
    supported: typeof MediaRecorder !== 'undefined' && !!canvas.captureStream,
    start() {
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) =>
        MediaRecorder.isTypeSupported(m)
      );
      const stream = canvas.captureStream(60);
      chunks = [];
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined);
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) chunks.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        onStop(new Blob(chunks, { type: 'video/webm' }));
        chunks = [];
      };
      rec.start(250);
      started = performance.now();
    },
    stop() {
      if (!rec) return;
      const r = rec;
      rec = null;
      r.stop();
    },
  };
}
