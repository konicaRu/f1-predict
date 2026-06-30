import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/f1-predict/', // GitHub Pages
  plugins: [react()],
});
