/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  plugins: [
    vue(),
    // Element Plus 按需引入：El* API（ElMessage 等）与 El* 组件免手动 import，
    // 样式由 ElementPlusResolver 按 css 内联；d.ts 落在 src/ 下由既有 tsconfig include 覆盖。
    AutoImport({ resolvers: [ElementPlusResolver()], dts: 'src/auto-imports.d.ts' }),
    Components({ resolvers: [ElementPlusResolver()], dts: 'src/components.d.ts' })
  ],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:43900' } },
  test: { environment: 'jsdom', include: ['test/**/*.test.ts'] }
})
