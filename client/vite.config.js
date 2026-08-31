import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

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
  server: {
    // 既定は 5173。PORT 指定時のみ従う（開発プレビューでポートが塞がっている場合用）
    port: Number(process.env.PORT) || 5173,
    fs: {
      allow: [repoRoot],
    },
  },
})
