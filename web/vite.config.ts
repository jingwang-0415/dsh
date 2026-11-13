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
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    // ElementPlusResolver 注入的样式 import 落在 node_modules 内（默认 externalize），
    // Node ESM 加载不了 .css → 测试环境 inline element-plus，让 vite 管线接管其 css（仅测试生效）
    server: { deps: { inline: ['element-plus'] } }
  }
})
