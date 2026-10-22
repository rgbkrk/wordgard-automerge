import {defineConfig} from 'vite';
export default defineConfig({
  // Automerge's published base64 entrypoint works without an extra WASM loader.
  // Its browser/bundler entrypoint otherwise expects Webpack's WASM handling.
  resolve: {conditions: ['webpack', 'module', 'browser', 'development|production']},
  build: {target: 'es2022'},
});
