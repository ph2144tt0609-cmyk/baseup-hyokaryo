import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// GitHub Pages はリポジトリ名のサブパス（/baseup-hyokaryo/）で配信される。
// ローカル開発は launch.json の `--base /` で上書きしているのでルートで動く。
export default defineConfig({
  base: process.env.GITHUB_PAGES_BASE ?? '/baseup-hyokaryo/',
  plugins: [react()],
})
