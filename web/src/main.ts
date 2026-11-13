import { createApp } from 'vue'
import { createAppRouter } from './router'
import App from './App.vue'
// Element Plus 暗色变量（html.dark 驱动），与手动/跟随系统主题切换联动
import 'element-plus/theme-chalk/dark/css-vars.css'
import './style.css'

type Theme = 'light' | 'dark'
const THEME_KEY = 'theme'

/** 初始主题：localStorage('theme') 优先，缺省跟随 prefers-color-scheme */
function resolveInitialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** 把主题落到 html.dark 类（Element Plus 暗色变量 + 自有手写样式的统一开关） */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

applyTheme(resolveInitialTheme())

// 无显式选择时跟随系统切换（有 localStorage 值则尊重用户选择）
window
  .matchMedia?.('(prefers-color-scheme: dark)')
  .addEventListener?.('change', (e) => {
    if (!localStorage.getItem(THEME_KEY)) applyTheme(e.matches ? 'dark' : 'light')
  })

createApp(App).use(createAppRouter()).mount('#app')
