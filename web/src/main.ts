import { createApp } from 'vue'
import { createAppRouter } from './router'
import App from './App.vue'
import './style.css'

createApp(App).use(createAppRouter()).mount('#app')
