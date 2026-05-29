import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    // Electron の file:// ロードで crossorigin 属性がスクリプト読み込みを
    // ブロックするケースがあるため、ビルド後の HTML から除去する
    {
      name: 'remove-crossorigin',
      transformIndexHtml(html) {
        return html.replace(/\s+crossorigin(?:="[^"]*")?/g, '');
      },
    },
  ],
})
