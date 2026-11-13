<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import { Moon, Sunny } from '@element-plus/icons-vue'

const route = useRoute()

// 初始值取 main.ts 已落到 html 上的 dark 类（localStorage ?? 系统偏好）
const isDark = ref(document.documentElement.classList.contains('dark'))

/** 主题手动切换：同步 html.dark 类（EP 暗色变量 + 手写样式开关）并持久化 localStorage */
function toggleTheme(): void {
  isDark.value = !isDark.value
  document.documentElement.classList.toggle('dark', isDark.value)
  localStorage.setItem('theme', isDark.value ? 'dark' : 'light')
}
</script>

<template>
  <el-container class="app">
    <el-aside class="app-aside" width="200px">
      <el-menu class="app-menu" router :default-active="route.path">
        <el-menu-item index="/">总览</el-menu-item>
        <el-menu-item index="/compare">分支对比</el-menu-item>
        <el-menu-item index="/crossrepo">跨仓对比</el-menu-item>
        <el-menu-item index="/repos">仓库管理</el-menu-item>
      </el-menu>
    </el-aside>
    <el-container class="app-body">
      <el-header class="app-header">
        <el-button
          circle
          :aria-label="isDark ? '切换浅色主题' : '切换深色主题'"
          :icon="isDark ? Sunny : Moon"
          :title="isDark ? '切换浅色主题' : '切换深色主题'"
          @click="toggleTheme"
        />
      </el-header>
      <el-main class="app-main">
        <RouterView />
      </el-main>
    </el-container>
  </el-container>
</template>
