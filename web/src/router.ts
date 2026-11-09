import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import Overview from './views/Overview.vue'
import CommitDetail from './views/CommitDetail.vue'
import Compare from './views/Compare.vue'
import CrossRepo from './views/CrossRepo.vue'
import Repos from './views/Repos.vue'

export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'overview', component: Overview },
  { path: '/commit/:sha', name: 'commit', component: CommitDetail },
  { path: '/compare', name: 'compare', component: Compare },
  { path: '/crossrepo', name: 'crossrepo', component: CrossRepo },
  { path: '/repos', name: 'repos', component: Repos }
]

export function createAppRouter() {
  return createRouter({ history: createWebHistory(), routes })
}
