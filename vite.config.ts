import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 화면만 빌드한다. Worker 는 wrangler 가 번들하며, 빌드 결과(dist/client)를 Static Assets 로 제공한다.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
});
