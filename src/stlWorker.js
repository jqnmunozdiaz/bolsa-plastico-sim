// Background worker: turns the simulated film into a printable, self-intersection-free STL.
import Module from 'manifold-3d';
import { buildPrintableSolid, writeBinaryStl } from './printable.js';

let wasmPromise = null;

self.onmessage = async (e) => {
  const { id, positions, indices, options } = e.data;
  try {
    if (!wasmPromise) {
      // The bundler embeds manifold.wasm in this worker, so Module() finds it on its own
      wasmPromise = Module().then((wasm) => {
        wasm.setup();
        return wasm;
      });
    }
    const wasm = await wasmPromise;
    const result = buildPrintableSolid(wasm, positions, indices, options, (step) =>
      self.postMessage({ id, progress: step })
    );
    const stl = writeBinaryStl(result.positions, result.indices);
    self.postMessage({ id, stl, info: result.info }, [stl]);
  } catch (err) {
    wasmPromise = null;
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
